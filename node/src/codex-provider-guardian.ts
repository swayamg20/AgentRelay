import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { uuidSchema } from "@agentrelay/protocol";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import type { CodexAppServerClientOptions } from "./codex-app-server-client.js";
import type {
	CodexCapsuleClient,
	CodexProviderGeneration,
	CodexProviderGuardian,
	CodexProviderTerminationReason,
} from "./codex-capsule-runner-contract.js";
import { CodexProviderGenerationStore } from "./codex-provider-generation-state.js";
import { CodexSupervisedProcess } from "./codex-supervised-process.js";
import type { CodexSupervisorCommand } from "./codex-supervised-process.js";
import {
	PROVIDER_GENERATION_LOCK_KIND,
	type ProcessLock,
	acquireProcessLock,
} from "./process-lock.js";
import {
	RuntimeAuthorityDeniedError,
	runtimeAuthorityDenyCodeSchema,
} from "./runtime-authority.js";

export const CODEX_PROVIDER_LOCK_FILE = "provider.lock";

export interface CodexProviderGuardianOptions extends CodexAppServerClientOptions {
	readonly capsuleId: string;
	readonly deadlineAtMs: number;
	readonly supervisor?: CodexSupervisorCommand;
	readonly reaper?: CodexSupervisorCommand;
	readonly startupTimeoutMs?: number;
	readonly heartbeatIntervalMs?: number;
	readonly heartbeatTimeoutMs?: number;
	readonly heartbeatRecordMs?: number;
}

export class CodexProviderGuardianError extends Error {
	constructor(
		readonly reason: "authority" | "ownership" | "startup" | "state",
		message: string,
	) {
		super(message);
		this.name = "CodexProviderGuardianError";
	}
}

/** Owns exactly one supervised Codex provider generation for one Capsule. */
export class SupervisedCodexProviderGuardian implements CodexProviderGuardian {
	readonly #options: CodexProviderGuardianOptions;
	#opening: Promise<CodexProviderGeneration> | null = null;
	#active: CodexProviderGeneration | null = null;
	#failedClosed = false;

	constructor(options: CodexProviderGuardianOptions) {
		this.#options = { ...options, capsuleId: uuidSchema.parse(options.capsuleId) };
	}

	openGeneration(): Promise<CodexProviderGeneration> {
		if (this.#failedClosed) {
			return Promise.reject(
				new CodexProviderGuardianError(
					"state",
					"Codex provider guardian is fail-closed after unproven teardown",
				),
			);
		}
		if (this.#options.authoritySignal.aborted) {
			return Promise.reject(authorityDenied(this.#options.authoritySignal));
		}
		if (this.#opening !== null || this.#active !== null) {
			return Promise.reject(
				new CodexProviderGuardianError("ownership", "Codex provider generation is already active"),
			);
		}
		const opening = this.performOpen();
		this.#opening = opening;
		return opening.finally(() => {
			if (this.#opening === opening) this.#opening = null;
		});
	}

	private async performOpen(): Promise<CodexProviderGeneration> {
		const generationId = randomUUID();
		let lock: ProcessLock;
		try {
			lock = await acquireProcessLock(
				join(this.#options.capsuleDirectory, CODEX_PROVIDER_LOCK_FILE),
				{ kind: PROVIDER_GENERATION_LOCK_KIND },
			);
		} catch {
			throw new CodexProviderGuardianError(
				"ownership",
				"Codex provider generation ownership is unavailable",
			);
		}

		let store: CodexProviderGenerationStore;
		try {
			store = await CodexProviderGenerationStore.open(
				this.#options.capsuleDirectory,
				this.#options.capsuleId,
			);
		} catch {
			await lock.release().catch(() => undefined);
			throw new CodexProviderGuardianError(
				"state",
				"Codex provider generation state is not safely recoverable",
			);
		}

		const supervisedRef: { value: CodexSupervisedProcess | null } = { value: null };
		try {
			const client = await CodexAppServerClient.start({
				command: this.#options.command,
				cwd: this.#options.cwd,
				capsuleDirectory: this.#options.capsuleDirectory,
				env: this.#options.env,
				boundary: this.#options.boundary,
				authoritySignal: this.#options.authoritySignal,
				requestTimeoutMs: this.#options.requestTimeoutMs,
				processFactory: async (processOptions) => {
					if (supervisedRef.value !== null) {
						throw new Error("Codex provider process was requested twice");
					}
					supervisedRef.value = await CodexSupervisedProcess.start(
						{
							capsuleId: this.#options.capsuleId,
							capsuleDirectory: this.#options.capsuleDirectory,
							generationId,
							supervisor: this.#options.supervisor ?? defaultSupervisorCommand(),
							reaper: this.#options.reaper,
							process: processOptions,
							lock,
							store,
							deadlineAtMs: this.#options.deadlineAtMs,
							startupTimeoutMs: this.#options.startupTimeoutMs,
							heartbeatIntervalMs: this.#options.heartbeatIntervalMs,
							heartbeatTimeoutMs: this.#options.heartbeatTimeoutMs,
							heartbeatRecordMs: this.#options.heartbeatRecordMs,
						},
						(supervised) => {
							supervisedRef.value = supervised;
						},
					);
					return supervisedRef.value.process;
				},
			});
			const supervised = requireSupervisedProcess(supervisedRef.value);
			if (this.#options.authoritySignal.aborted) {
				throw authorityDenied(this.#options.authoritySignal);
			}
			supervised.activate();
			const generation = providerGeneration(generationId, client, supervised);
			this.#active = generation;
			void generation.termination.then(
				() => {
					if (this.#active === generation) this.#active = null;
				},
				() => {
					this.#failedClosed = true;
					if (this.#active === generation) this.#active = null;
				},
			);
			return generation;
		} catch (error) {
			const supervised = supervisedRef.value;
			try {
				if (supervised === null) {
					await lock.release();
				} else {
					await supervised.stop("startup_failure");
				}
			} catch (teardownError) {
				this.#failedClosed = true;
				throw new AggregateError(
					[teardownError, error],
					"Codex provider startup teardown could not be proven",
				);
			}
			if (this.#options.authoritySignal.aborted) {
				throw authorityDenied(this.#options.authoritySignal);
			}
			if (error instanceof RuntimeAuthorityDeniedError) throw error;
			if (error instanceof CodexProviderGuardianError) throw error;
			throw new CodexProviderGuardianError("startup", "Codex provider generation failed to start");
		}
	}
}

function authorityDenied(signal: AbortSignal): RuntimeAuthorityDeniedError {
	const parsed = runtimeAuthorityDenyCodeSchema.safeParse(signal.reason);
	return new RuntimeAuthorityDeniedError(parsed.success ? parsed.data : "revoked");
}

function requireSupervisedProcess(value: CodexSupervisedProcess | null): CodexSupervisedProcess {
	if (value === null) throw new Error("Codex provider supervisor was not created");
	return value;
}

function providerGeneration(
	generationId: string,
	client: CodexAppServerClient,
	supervised: CodexSupervisedProcess,
): CodexProviderGeneration {
	let termination: Promise<void> | null = null;
	return Object.freeze({
		generationId,
		client: client as CodexCapsuleClient,
		termination: supervised.termination,
		terminate(reason: CodexProviderTerminationReason): Promise<void> {
			supervised.setStopCause(reason);
			termination ??= client.close().then(() => supervised.stop(reason));
			return termination;
		},
	});
}

function defaultSupervisorCommand(): CodexSupervisorCommand {
	return {
		executable: process.execPath,
		args: [fileURLToPath(new URL("./bin/agentrelay-codex-guardian.js", import.meta.url))],
	};
}
