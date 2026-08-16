import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { fstatSync, lstatSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { currentBootSessionId } from "./boot-session.js";
import { CodexProviderGenerationStore } from "./codex-provider-generation-state.js";
import type {
	CodexProviderObservation,
	CodexProviderStopCause,
} from "./codex-provider-generation-state.js";
import {
	CodexSupervisorProcessError,
	assertSupervisorProcessGroup,
	killSupervisorProcessGroup,
	requestProviderStop,
	startPreparedCodexProvider,
	verifyPreparedCodexVersion,
} from "./codex-provider-supervisor-process.js";
import {
	type CodexProviderSupervisorEvent,
	type CodexProviderSupervisorInit,
	parseCodexProviderSupervisorCommand,
	terminalSupervisorEvent,
} from "./codex-provider-supervisor-protocol.js";

const PROVIDER_LOCK_FD = 4;
const STARTUP_MESSAGE_TIMEOUT_MS = 5_000;

/** Runs only in the dedicated guardian process started by CodexProviderGuardian. */
export class CodexProviderSupervisor {
	#generationId: string | null = null;
	#ownerPid: number | null = null;
	#store: CodexProviderGenerationStore | null = null;
	#provider: ChildProcessWithoutNullStreams | null = null;
	#lastHeartbeat = performance.now();
	#lastRecordedHeartbeat = performance.now();
	#heartbeatTimer: NodeJS.Timeout | null = null;
	#deadlineAtMs: number | null = null;
	#deadlineTimer: NodeJS.Timeout | null = null;
	#stopCause: CodexProviderStopCause | null = null;
	#stopping: Promise<never> | null = null;
	#initialized = false;

	run(): void {
		assertSupervisorProcessGroup();
		const startupTimer = setTimeout(() => process.exit(1), STARTUP_MESSAGE_TIMEOUT_MS);
		startupTimer.unref();
		process.on("message", (value) => {
			void this.handleMessage(value, startupTimer).catch(() =>
				this.fail("internal", "startup_failure", "crashed"),
			);
		});
		process.once("disconnect", () => void this.stop("owner_lost", "stopped"));
		process.stdin.once("end", () => void this.stop("owner_lost", "stopped"));
		process.stdin.once("error", () => void this.stop("owner_lost", "stopped"));
		process.once("SIGINT", () => void this.stop("owner_lost", "stopped"));
		process.once("SIGTERM", () => void this.stop(this.#stopCause ?? "owner_lost", "stopped"));
	}

	private async handleMessage(value: unknown, startupTimer: NodeJS.Timeout): Promise<void> {
		const command = parseCodexProviderSupervisorCommand(value);
		if (command.kind === "initialize") {
			if (this.#initialized) throw new Error("Codex provider supervisor was initialized twice");
			this.#initialized = true;
			clearTimeout(startupTimer);
			await this.initialize(command);
			return;
		}
		if (this.#generationId === null || command.generation_id !== this.#generationId) return;
		if (command.kind === "heartbeat") {
			await this.recordHeartbeat();
			return;
		}
		await this.stop(command.cause, terminationObservation(command.cause));
	}

	private async initialize(command: CodexProviderSupervisorInit): Promise<void> {
		this.#generationId = command.generation_id;
		this.#ownerPid = command.owner_pid;
		try {
			assertInheritedProviderLock(command.lock_path);
			this.assertOwnerAlive();
			this.#store = await CodexProviderGenerationStore.open(
				command.state_directory,
				command.capsule_id,
			);
			await this.#store.begin(
				command.generation_id,
				await currentBootSessionId(),
				command.deadline_at_ms,
			);
			this.startDeadlineWatchdog(command.deadline_at_ms);
			this.assertAuthorityActive();
			this.startHeartbeatWatchdog(command);
			await verifyPreparedCodexVersion(command.version_probe);
			this.assertAuthorityActive();
			const provider = await startPreparedCodexProvider(command.app_server);
			this.#provider = provider;
			this.assertAuthorityActive();
			provider.stderr.resume();
			process.stdin.pipe(provider.stdin);
			provider.stdout.pipe(process.stdout);
			provider.once("close", () => {
				if (this.#stopping === null) void this.stop("provider_failure", "crashed");
			});
			provider.stdin.once("error", () => {
				if (this.#stopping === null) void this.stop("provider_failure", "crashed");
			});
			await this.#store.markRunning(command.generation_id);
			await this.send({
				version: 1,
				kind: "ready",
				generation_id: command.generation_id,
			});
		} catch (error) {
			const code =
				error instanceof CodexSupervisorProcessError
					? error.code
					: this.#store === null
						? "invalid_startup"
						: "state";
			await this.fail(code, "startup_failure", "crashed");
		}
	}

	private startHeartbeatWatchdog(command: CodexProviderSupervisorInit): void {
		this.#lastHeartbeat = performance.now();
		this.#lastRecordedHeartbeat = this.#lastHeartbeat;
		const intervalMs = Math.max(50, Math.floor(command.heartbeat_timeout_ms / 4));
		this.#heartbeatTimer = setInterval(() => {
			if (performance.now() - this.#lastHeartbeat >= command.heartbeat_timeout_ms) {
				void this.stop("heartbeat_timeout", "unresponsive");
			}
		}, intervalMs);
		this.#heartbeatTimer.unref();
		this.#heartbeatRecordMs = command.heartbeat_record_ms;
	}

	private startDeadlineWatchdog(deadlineAtMs: number): void {
		this.#deadlineAtMs = deadlineAtMs;
		this.armDeadlineTimer();
	}

	private armDeadlineTimer(): void {
		if (this.#deadlineAtMs === null || this.#stopping !== null) return;
		const remainingMs = this.#deadlineAtMs - Date.now();
		if (remainingMs <= 0) {
			void this.stop("deadline_exceeded", "unresponsive");
			return;
		}
		this.#deadlineTimer = setTimeout(
			() => this.armDeadlineTimer(),
			Math.min(remainingMs, 2_147_483_647),
		);
		this.#deadlineTimer.unref();
	}

	#heartbeatRecordMs = 1_000;

	private async recordHeartbeat(): Promise<void> {
		this.#lastHeartbeat = performance.now();
		if (
			this.#store === null ||
			this.#generationId === null ||
			this.#lastHeartbeat - this.#lastRecordedHeartbeat < this.#heartbeatRecordMs
		) {
			return;
		}
		this.#lastRecordedHeartbeat = this.#lastHeartbeat;
		await this.#store.recordHeartbeat(this.#generationId);
	}

	private assertOwnerAlive(): void {
		if (this.#ownerPid === null || process.ppid !== this.#ownerPid || !process.connected) {
			throw new Error("Codex provider supervisor owner disappeared during startup");
		}
	}

	private assertAuthorityActive(): void {
		this.assertOwnerAlive();
		if (this.#deadlineAtMs !== null && Date.now() >= this.#deadlineAtMs) {
			void this.stop("deadline_exceeded", "unresponsive");
		}
		if (this.#stopping !== null) {
			throw new Error("Codex provider authority ended during startup");
		}
	}

	private async fail(
		code: Extract<CodexProviderSupervisorEvent, { kind: "failure" }>["code"],
		cause: CodexProviderStopCause,
		observation: CodexProviderObservation,
	): Promise<never> {
		if (this.#generationId !== null) {
			await this.send({
				version: 1,
				kind: "failure",
				generation_id: this.#generationId,
				code,
			}).catch(() => undefined);
		}
		return this.stop(cause, observation);
	}

	private stop(
		cause: CodexProviderStopCause,
		observation: CodexProviderObservation,
	): Promise<never> {
		this.#stopCause ??= cause;
		this.#stopping ??= this.performStop(this.#stopCause, observation);
		return this.#stopping;
	}

	private async performStop(
		cause: CodexProviderStopCause,
		observation: CodexProviderObservation,
	): Promise<never> {
		if (this.#heartbeatTimer !== null) clearInterval(this.#heartbeatTimer);
		if (this.#deadlineTimer !== null) clearTimeout(this.#deadlineTimer);
		const generationId = this.#generationId;
		if (generationId !== null && this.#store !== null) {
			await this.#store.requestStop(generationId, cause).catch(() => undefined);
		}
		await requestProviderStop(this.#provider).catch(() => undefined);
		if (generationId !== null && this.#store !== null) {
			await this.#store.markQuiescent(generationId, cause, observation).catch(() => undefined);
			await this.send(terminalSupervisorEvent(generationId, cause, observation)).catch(
				() => undefined,
			);
		}
		return killSupervisorProcessGroup();
	}

	private send(event: CodexProviderSupervisorEvent): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!process.connected || process.send === undefined) {
				reject(new Error("Codex provider supervisor control channel is closed"));
				return;
			}
			process.send(event, (error) => (error === null ? resolve() : reject(error)));
		});
	}
}

function assertInheritedProviderLock(path: string): void {
	const descriptor = fstatSync(PROVIDER_LOCK_FD);
	const published = lstatSync(path);
	if (
		published.isSymbolicLink() ||
		!published.isFile() ||
		descriptor.dev !== published.dev ||
		descriptor.ino !== published.ino ||
		descriptor.nlink !== 1 ||
		(published.mode & 0o777) !== 0o600 ||
		(process.getuid !== undefined && published.uid !== process.getuid())
	) {
		throw new Error("Codex provider supervisor did not inherit the expected private lock");
	}
	const decoded = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	if (decoded.schema_version !== 2 || decoded.kind !== "agentrelay_provider_generation_lock") {
		throw new Error("Codex provider supervisor lock kind is invalid");
	}
}

function terminationObservation(cause: CodexProviderStopCause): CodexProviderObservation {
	if (
		cause === "deadline_exceeded" ||
		cause === "heartbeat_timeout" ||
		cause === "provider_unresponsive"
	) {
		return "unresponsive";
	}
	if (cause === "provider_failure" || cause === "startup_failure") return "crashed";
	return "stopped";
}
