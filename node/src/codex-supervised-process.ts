import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { CodexAppServerProcess } from "./codex-app-server-process.js";
import type {
	CodexProviderObservation,
	CodexProviderStopCause,
} from "./codex-provider-generation-state.js";
import {
	type CodexPreparedProcess,
	type CodexProviderSupervisorEvent,
	parseCodexProviderSupervisorEvent,
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
	observationForCause,
	sendSupervisorCommand,
	stopSupervisorProcessGroup,
	waitForChildSpawn,
	writableError,
} from "./codex-supervisor-owner.js";

const STOP_GRACE_MS = 2_000;

export type { CodexSupervisedProcessOptions, CodexSupervisorCommand };

export class CodexSupervisedProcess {
	readonly process: CodexAppServerProcess;
	readonly termination: Promise<{ readonly kind: CodexProviderObservation }>;
	readonly #options: ResolvedCodexSupervisedProcessOptions;
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #exited: CodexAppServerProcess["exited"];
	readonly #closed: CodexAppServerProcess["closed"];
	#resolveTermination!: (value: { readonly kind: CodexProviderObservation }) => void;
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
		this.termination = new Promise((resolve) => {
			this.#resolveTermination = resolve;
		});
		this.process = {
			child,
			cwd: options.process.cwd,
			exited: this.#exited,
			closed: this.#closed,
			inputError: writableError(child),
			stop: () =>
				this.stop(this.#stopCause ?? (this.#ready ? "provider_failure" : "startup_failure")),
		};
	}

	static async start(options: CodexSupervisedProcessOptions): Promise<CodexSupervisedProcess> {
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
		try {
			await waitForChildSpawn(child);
			child.stderr.resume();
			await supervised.initialize(commands);
			return supervised;
		} catch (error) {
			await supervised.stop("startup_failure").catch(() => undefined);
			throw error;
		}
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
			if (event.kind === "terminal") this.#observation ??= event.observation;
		};
		this.#child.on("message", onMessage);
		void this.#closed.then(() => {
			if (!this.#ready) rejectReady(new Error("Codex provider supervisor exited during startup"));
			void this.stop(this.#stopCause ?? (this.#ready ? "provider_failure" : "startup_failure"));
		});

		await sendSupervisorCommand(this.#child, {
			version: 1,
			kind: "initialize",
			capsule_id: this.#options.capsuleId,
			generation_id: this.#options.generationId,
			owner_pid: process.pid,
			lock_path: this.#options.lock.path,
			state_directory: this.#options.capsuleDirectory,
			heartbeat_timeout_ms: this.#options.heartbeatTimeoutMs,
			heartbeat_record_ms: this.#options.heartbeatRecordMs,
			version_probe: commands.versionProbe,
			app_server: commands.appServer,
		});
		this.#heartbeat = setInterval(() => {
			void sendSupervisorCommand(this.#child, {
				version: 1,
				kind: "heartbeat",
				generation_id: this.#options.generationId,
			}).catch(() => this.stop("provider_failure"));
		}, this.#options.heartbeatIntervalMs);
		this.#heartbeat.unref();

		await Promise.race([
			ready,
			delay(this.#options.startupTimeoutMs).then(() => {
				throw new Error("Codex provider supervisor timed out during startup");
			}),
		]);
	}

	private async performStop(): Promise<void> {
		if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
		const cause = this.#stopCause ?? "provider_failure";
		await sendSupervisorCommand(
			this.#child,
			terminateSupervisorCommand(this.#options.generationId, cause),
		).catch(() => undefined);
		await Promise.race([this.#closed, delay(STOP_GRACE_MS + 250)]);
		if (this.#child.pid !== undefined && isSupervisorProcessGroupAlive(this.#child.pid)) {
			await stopSupervisorProcessGroup(this.#child, this.#exited, this.#closed);
		}
		const observation = this.#observation ?? observationForCause(cause);
		await this.#options.store.markQuiescent(this.#options.generationId, cause, observation);
		await this.#options.lock.release();
		this.#resolveTermination({ kind: observation });
	}
}
