import type { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { currentBootSessionId } from "./boot-session.js";
import {
	CodexProviderGenerationStore,
	observationForProviderStopCause,
} from "./codex-provider-generation-state.js";
import type {
	CodexProviderObservation,
	CodexProviderStopCause,
} from "./codex-provider-generation-state.js";
import { assertInheritedProviderLock } from "./codex-provider-lock.js";
import {
	CodexProviderReaperClient,
	CodexProviderReaperTeardownError,
} from "./codex-provider-reaper-client.js";
import {
	CodexSupervisorProcessError,
	assertSupervisorProcessGroup,
	startPreparedCodexProvider,
	verifyPreparedCodexVersion,
} from "./codex-provider-supervisor-process.js";
import {
	type CodexProviderSupervisorEvent,
	type CodexProviderSupervisorInit,
	parseCodexProviderSupervisorCommand,
	terminalSupervisorEvent,
} from "./codex-provider-supervisor-protocol.js";
const STARTUP_MESSAGE_TIMEOUT_MS = 5_000;

/** Runs only in the dedicated guardian process started by CodexProviderGuardian. */
export class CodexProviderSupervisor {
	#generationId: string | null = null;
	#ownerPid: number | null = null;
	#store: CodexProviderGenerationStore | null = null;
	#reaper: CodexProviderReaperClient | null = null;
	#provider: ChildProcess | null = null;
	#lastHeartbeat = performance.now();
	#lastRecordedHeartbeat = performance.now();
	#heartbeatTimer: NodeJS.Timeout | null = null;
	#deadlineAtMs: number | null = null;
	#deadlineTimer: NodeJS.Timeout | null = null;
	#stopCause: CodexProviderStopCause | null = null;
	#pendingTermination: {
		readonly generationId: string;
		readonly cause: CodexProviderStopCause;
	} | null = null;
	#stopping: Promise<never> | null = null;
	#initialized = false;
	#readyPublished = false;

	run(): void {
		assertSupervisorProcessGroup();
		const startupTimer = setTimeout(() => process.exit(1), STARTUP_MESSAGE_TIMEOUT_MS);
		startupTimer.unref();
		process.on("message", (value) => {
			void this.handleMessage(value, startupTimer).catch(() => {
				const cause = this.#readyPublished ? "provider_failure" : "startup_failure";
				return this.fail("internal", cause, "crashed");
			});
		});
		process.once("disconnect", () => void this.stop("owner_lost", "stopped"));
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
		if (this.#generationId === null) {
			if (command.kind === "terminate") {
				this.#pendingTermination ??= {
					generationId: command.generation_id,
					cause: command.cause,
				};
			}
			return;
		}
		if (command.generation_id !== this.#generationId) return;
		if (command.kind === "heartbeat") {
			await Promise.all([this.recordHeartbeat(), this.#reaper?.heartbeat()]);
			return;
		}
		await this.stop(command.cause, observationForProviderStopCause(command.cause));
	}

	private async initialize(command: CodexProviderSupervisorInit): Promise<void> {
		this.#generationId = command.generation_id;
		this.#ownerPid = command.owner_pid;
		try {
			if (this.#pendingTermination !== null) {
				if (this.#pendingTermination.generationId !== command.generation_id) {
					throw new Error("Codex provider supervisor termination generation did not match");
				}
				return this.stop(
					this.#pendingTermination.cause,
					observationForProviderStopCause(this.#pendingTermination.cause),
				);
			}
			assertInheritedProviderLock(command.lock_path);
			this.assertOwnerAlive();
			const reaper = await CodexProviderReaperClient.start({
				command: command.reaper,
				capsuleId: command.capsule_id,
				generationId: command.generation_id,
				lockPath: command.lock_path,
				stateDirectory: command.state_directory,
				deadlineAtMs: command.deadline_at_ms,
				heartbeatTimeoutMs: command.heartbeat_timeout_ms,
			});
			this.#reaper = reaper;
			void reaper.termination.then(() => {
				if (this.#stopping === null) void this.stop("provider_failure", "crashed");
			});
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
			provider.once("close", () => {
				if (this.#stopping !== null) return;
				if (!this.hasLiveOwner()) {
					void this.stop("owner_lost", "stopped");
					return;
				}
				void this.stop("provider_failure", "crashed");
			});
			await this.#store.markRunning(command.generation_id);
			this.assertAuthorityActive();
			await this.send({
				version: 1,
				kind: "ready",
				generation_id: command.generation_id,
			});
			this.#readyPublished = true;
		} catch (error) {
			const code = startupFailureCode(error, this.#reaper !== null);
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
		if (this.#deadlineAtMs === null) return;
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
		if (!this.hasLiveOwner()) {
			throw new Error("Codex provider supervisor owner disappeared during startup");
		}
	}

	private hasLiveOwner(): boolean {
		return this.#ownerPid !== null && process.ppid === this.#ownerPid && process.connected;
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
		if (this.#stopping !== null) {
			if (requiresImmediateTermination(cause)) {
				void this.#reaper?.escalate(cause).catch(() => undefined);
			}
			return this.#stopping;
		}
		this.#stopping = this.performStop(this.#stopCause, observation);
		return this.#stopping;
	}

	private async performStop(
		cause: CodexProviderStopCause,
		observation: CodexProviderObservation,
	): Promise<never> {
		if (this.#heartbeatTimer !== null) clearInterval(this.#heartbeatTimer);
		if (requiresImmediateTermination(cause) && this.#deadlineTimer !== null) {
			clearTimeout(this.#deadlineTimer);
		}
		const generationId = this.#generationId;
		const reaper = this.#reaper;
		if (generationId === null || reaper === null) process.exit(1);
		const reaping = reaper.stop(cause);
		await this.send(terminalSupervisorEvent(generationId, cause, observation)).catch(
			() => undefined,
		);
		try {
			return await reaping;
		} catch {
			process.exit(1);
		}
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

function requiresImmediateTermination(cause: CodexProviderStopCause): boolean {
	return cause === "authority_revoked" || cause === "deadline_exceeded";
}

function startupFailureCode(
	error: unknown,
	reaperArmed: boolean,
): Extract<CodexProviderSupervisorEvent, { kind: "failure" }>["code"] {
	if (error instanceof CodexSupervisorProcessError) return error.code;
	if (error instanceof CodexProviderReaperTeardownError) return "state";
	return reaperArmed ? "state" : "invalid_startup";
}
