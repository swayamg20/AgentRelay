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
	sendSupervisorCommand,
	stopSupervisorProcessGroup,
	waitForChildSpawn,
	writableError,
} from "./codex-supervisor-owner.js";

const STOP_GRACE_MS = 2_000;
const REAPER_FINALIZATION_TIMEOUT_MS = 20_000;

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
	#urgentGroupTermination: Promise<void> | null = null;
	#initializationMayHaveBeenDelivered = false;
	#allowMissingGenerationState = true;

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
		const authorityTermination = observeAuthorityTermination(
			options.process.authoritySignal,
			this.termination,
			() => this.stop("authority_revoked"),
		);
		void authorityTermination.catch(() => undefined);
		this.process = {
			child,
			cwd: options.process.cwd,
			exited: this.#exited,
			closed: this.#closed,
			inputError: writableError(child),
			authorityTermination,
			stop: (reason) => this.stop(this.#stopCause ?? stopCause(reason, this.#ready)),
		};
	}

	static async start(
		options: CodexSupervisedProcessOptions,
		onSpawned: (supervised: CodexSupervisedProcess) => void,
	): Promise<CodexSupervisedProcess> {
		const bounded = resolveSupervisedProcessOptions(options);
		options.process.authoritySignal.throwIfAborted();
		const commands = await prepareProviderCommands(options.process);
		options.process.authoritySignal.throwIfAborted();
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
		if (options.process.authoritySignal.aborted) {
			await supervised.stop("authority_revoked");
			options.process.authoritySignal.throwIfAborted();
		}
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
		if (requiresImmediateTermination(cause)) {
			this.#urgentGroupTermination ??= stopSupervisorProcessGroup(
				this.#child,
				this.#exited,
				this.#closed,
				{ immediate: true },
			);
			void this.#urgentGroupTermination.catch(() => undefined);
		}
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
			if (event.kind === "ready") {
				this.#allowMissingGenerationState = false;
				resolveReady();
			}
			if (event.kind === "failure") {
				this.#allowMissingGenerationState = event.code === "invalid_startup";
				rejectReady(new Error(`Codex provider supervisor failed during ${event.code}`));
			}
			if (event.kind === "terminal") {
				this.#allowMissingGenerationState = false;
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

		this.#initializationMayHaveBeenDelivered = true;
		this.#allowMissingGenerationState = false;
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
			if (!this.#initializationMayHaveBeenDelivered) {
				await this.proveSupervisorTermination();
				await this.#options.lock.release();
				this.#resolveTermination({ kind: observationForProviderStopCause(cause) });
				return;
			}
			await sendSupervisorCommand(
				this.#child,
				terminateSupervisorCommand(this.#options.generationId, cause),
			).catch(() => undefined);
			await Promise.race([this.#closed, delay(STOP_GRACE_MS + 250, undefined, { ref: false })]);
			await this.proveSupervisorTermination();
			const finalized = await waitForReaperFinalization(
				this.#options.store,
				this.#options.generationId,
				this.#allowMissingGenerationState,
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

	private async proveSupervisorTermination(): Promise<void> {
		const initialProof =
			this.#urgentGroupTermination ??
			stopSupervisorProcessGroup(this.#child, this.#exited, this.#closed);
		const initialResult = await settle(initialProof);
		const urgentProof = this.#urgentGroupTermination;
		const urgentResult =
			urgentProof === null || urgentProof === initialProof ? null : await settle(urgentProof);
		const failures = [initialResult, urgentResult].filter(
			(result): result is PromiseRejectedResult => result?.status === "rejected",
		);
		if (failures.length === 1) throw failures[0]!.reason;
		if (failures.length > 1) {
			throw new AggregateError(
				failures.map((failure) => failure.reason),
				"Codex provider process-group termination could not be proven",
			);
		}
	}
}

async function observeAuthorityTermination(
	signal: AbortSignal,
	termination: CodexSupervisedProcess["termination"],
	stop: () => Promise<void>,
): Promise<void> {
	let notifyAbort!: () => void;
	let abortStop: Promise<void> | null = null;
	const aborted = new Promise<void>((resolve) => {
		notifyAbort = resolve;
	});
	const onAbort = () => {
		abortStop ??= stop();
		notifyAbort();
	};
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	try {
		const trigger = await Promise.race([
			aborted.then(() => "aborted" as const),
			termination.then(() => "terminated" as const),
		]);
		if (trigger === "terminated" && !signal.aborted) return;
		await (abortStop ?? stop());
		signal.throwIfAborted();
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function waitForReaperFinalization(
	store: ResolvedCodexSupervisedProcessOptions["store"],
	generationId: string,
	allowMissingGenerationState: boolean,
): Promise<Awaited<ReturnType<typeof store.snapshot>>> {
	const deadline = Date.now() + REAPER_FINALIZATION_TIMEOUT_MS;
	for (;;) {
		const state = await store.snapshot();
		if (state === null || state.generation_id !== generationId) {
			if (allowMissingGenerationState) return null;
			throw new Error("Codex provider generation state changed before teardown was proven");
		}
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

function requiresImmediateTermination(cause: CodexProviderStopCause): boolean {
	return cause === "authority_revoked" || cause === "deadline_exceeded";
}

async function settle(promise: Promise<void>): Promise<PromiseSettledResult<void>> {
	try {
		await promise;
		return { status: "fulfilled", value: undefined };
	} catch (reason) {
		return { status: "rejected", reason };
	}
}
