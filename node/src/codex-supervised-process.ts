import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { CodexAppServerProcess } from "./codex-app-server-process.js";
import type { CodexAppServerStopReason } from "./codex-app-server-process.js";
import type {
	CodexProviderObservation,
	CodexProviderStopCause,
} from "./codex-provider-generation-state.js";
import { observationForProviderStopCause } from "./codex-provider-generation-state.js";
import {
	type CodexPreparedProcess,
	type CodexProviderSupervisorEvent,
	parseCodexProviderSupervisorEvent,
	sanitizePreparedEnvironment,
	terminateSupervisorCommand,
} from "./codex-provider-supervisor-protocol.js";
import {
	type CodexSupervisedProcessOptions,
	type CodexSupervisorCommand,
	type ResolvedCodexSupervisedProcessOptions,
	prepareProviderCommands,
	resolveSupervisedProcessOptions,
	supervisorEnvironment,
} from "./codex-supervised-process-config.js";
import {
	childClose,
	childExit,
	isSupervisorProcessGroupAlive,
	sendSupervisorCommand,
	stopSupervisorProcessGroup,
	waitForChildSpawn,
	writableError,
} from "./codex-supervisor-owner.js";

const STOP_GRACE_MS = 2_000;
const REAPER_FINALIZATION_TIMEOUT_MS = 10_000;

export type { CodexSupervisedProcessOptions, CodexSupervisorCommand };

export class CodexSupervisedProcess {
	readonly process: CodexAppServerProcess;
	readonly termination: Promise<{ readonly kind: CodexProviderObservation }>;
	readonly #options: ResolvedCodexSupervisedProcessOptions;
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #exited: CodexAppServerProcess["exited"];
	readonly #closed: CodexAppServerProcess["closed"];
	#resolveTermination!: (value: { readonly kind: CodexProviderObservation }) => void;
	#rejectTermination!: (error: Error) => void;
	#heartbeat: NodeJS.Timeout | null = null;
	#ready = false;
	#observation: CodexProviderObservation | null = null;
	#stopCause: CodexProviderStopCause | null = null;
	#stopPromise: Promise<void> | null = null;

	private constructor(
		options: ResolvedCodexSupervisedProcessOptions,
		child: ChildProcessWithoutNullStreams,
	) {
		this.#options = options;
		this.#child = child;
		this.#exited = childExit(child);
		this.#closed = childClose(child);
		this.termination = new Promise((resolve, reject) => {
			this.#resolveTermination = resolve;
			this.#rejectTermination = reject;
		});
		void this.termination.catch(() => undefined);
		this.process = {
			child,
			cwd: options.process.cwd,
			exited: this.#exited,
			closed: this.#closed,
			inputError: writableError(child),
			stop: (reason) => this.stop(this.#stopCause ?? stopCause(reason, this.#ready)),
		};
	}

	static async start(
		options: CodexSupervisedProcessOptions,
		onSpawned: (supervised: CodexSupervisedProcess) => void,
	): Promise<CodexSupervisedProcess> {
		const bounded = resolveSupervisedProcessOptions(options);
		const commands = await prepareProviderCommands(options.process);
		const child = spawn(options.supervisor.executable, [...options.supervisor.args], {
			cwd: options.capsuleDirectory,
			detached: true,
			env: supervisorEnvironment(options.supervisor.env),
			stdio: ["pipe", "pipe", "pipe", "ipc", options.lock.inheritFileDescriptor()],
			shell: false,
		}) as ChildProcessWithoutNullStreams;
		const supervised = new CodexSupervisedProcess(bounded, child);
		await waitForChildSpawn(child);
		child.stderr.resume();
		onSpawned(supervised);
		await supervised.initialize(commands);
		return supervised;
	}

	activate(): void {
		this.#ready = true;
	}

	setStopCause(cause: CodexProviderStopCause): void {
		this.#stopCause ??= cause;
	}

	stop(cause: CodexProviderStopCause): Promise<void> {
		this.setStopCause(cause);
		this.#stopPromise ??= this.performStop();
		return this.#stopPromise;
	}

	private async initialize(commands: {
		readonly versionProbe: CodexPreparedProcess;
		readonly appServer: CodexPreparedProcess;
	}): Promise<void> {
		let resolveReady!: () => void;
		let rejectReady!: (error: Error) => void;
		const ready = new Promise<void>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		const onMessage = (value: unknown) => {
			let event: CodexProviderSupervisorEvent;
			try {
				event = parseCodexProviderSupervisorEvent(value);
			} catch {
				rejectReady(new Error("Codex provider supervisor returned an invalid control event"));
				return;
			}
			if (event.generation_id !== this.#options.generationId) return;
			if (event.kind === "ready") resolveReady();
			if (event.kind === "failure") {
				rejectReady(new Error(`Codex provider supervisor failed during ${event.code}`));
			}
			if (event.kind === "terminal") {
				this.setStopCause(event.cause);
				this.#observation ??= event.observation;
			}
		};
		this.#child.on("message", onMessage);
		void this.#closed.then(() => {
			if (!this.#ready) rejectReady(new Error("Codex provider supervisor exited during startup"));
			void this.stop(
				this.#stopCause ?? (this.#ready ? "provider_failure" : "startup_failure"),
			).catch(() => undefined);
		});

		await sendSupervisorCommand(this.#child, {
			version: 1,
			kind: "initialize",
			capsule_id: this.#options.capsuleId,
			generation_id: this.#options.generationId,
			owner_pid: process.pid,
			lock_path: this.#options.lock.path,
			state_directory: this.#options.capsuleDirectory,
			deadline_at_ms: this.#options.deadlineAtMs,
			heartbeat_timeout_ms: this.#options.heartbeatTimeoutMs,
			heartbeat_record_ms: this.#options.heartbeatRecordMs,
			reaper: {
				executable: this.#options.reaper.executable,
				argv: [...this.#options.reaper.args],
				cwd: this.#options.capsuleDirectory,
				env: sanitizePreparedEnvironment(supervisorEnvironment(this.#options.reaper.env)),
			},
			version_probe: commands.versionProbe,
			app_server: commands.appServer,
		});
		this.#heartbeat = setInterval(() => {
			void sendSupervisorCommand(this.#child, {
				version: 1,
				kind: "heartbeat",
				generation_id: this.#options.generationId,
			})
				.catch(() => this.stop("provider_failure"))
				.catch(() => undefined);
		}, this.#options.heartbeatIntervalMs);
		this.#heartbeat.unref();

		await Promise.race([
			ready,
			delay(this.#options.startupTimeoutMs, undefined, { ref: false }).then(() => {
				throw new Error("Codex provider supervisor timed out during startup");
			}),
		]);
	}

	private async performStop(): Promise<void> {
		if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
		const cause = this.#stopCause ?? "provider_failure";
		try {
			await sendSupervisorCommand(
				this.#child,
				terminateSupervisorCommand(this.#options.generationId, cause),
			).catch(() => undefined);
			await Promise.race([this.#closed, delay(STOP_GRACE_MS + 250, undefined, { ref: false })]);
			if (this.#child.pid !== undefined && isSupervisorProcessGroupAlive(this.#child.pid)) {
				await stopSupervisorProcessGroup(this.#child, this.#exited, this.#closed);
			}
			const finalized = await waitForReaperFinalization(
				this.#options.store,
				this.#options.generationId,
			);
			const observation =
				finalized?.observation ?? this.#observation ?? observationForProviderStopCause(cause);
			await this.#options.lock.release();
			this.#resolveTermination({ kind: observation });
		} catch (cause) {
			const error = new Error("Codex provider termination could not be proven", { cause });
			this.#rejectTermination(error);
			throw error;
		}
	}
}

async function waitForReaperFinalization(
	store: ResolvedCodexSupervisedProcessOptions["store"],
	generationId: string,
): Promise<Awaited<ReturnType<typeof store.snapshot>>> {
	const deadline = Date.now() + REAPER_FINALIZATION_TIMEOUT_MS;
	for (;;) {
		const state = await store.snapshot();
		if (state === null || state.generation_id !== generationId) return null;
		if (state.phase === "quiescent") return state;
		if (Date.now() >= deadline) {
			throw new Error("Codex provider reaper did not finalize quiescence");
		}
		await delay(10);
	}
}

function stopCause(
	reason: CodexAppServerStopReason | undefined,
	ready: boolean,
): CodexProviderStopCause {
	if (reason === "unresponsive") return "provider_unresponsive";
	return ready ? "provider_failure" : "startup_failure";
}
