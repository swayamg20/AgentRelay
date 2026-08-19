import { dirname, join } from "node:path";
import type { AdapterInfo, HostSessionRef, HostTurnRef, SessionInput } from "@agentrelay/protocol";
import { buildBaseCapsuleEnvironment } from "./capsule-environment.js";
import type { CodexCapsuleLaunchDescriptor } from "./capsule-launch-descriptor.js";
import type {
	CapsuleRuntime,
	CapsuleRuntimeActivation,
	CapsuleRuntimeController,
	CapsuleRuntimeLifecycle,
} from "./capsule-runtime.js";
import {
	CODEX_CAPSULE_ADAPTER_INFO,
	type CodexCapsuleRunnerOptions,
	type CodexProviderGuardian,
} from "./codex-capsule-runner-contract.js";
import { CodexCapsuleRunner } from "./codex-capsule-runner.js";
import { CodexCapsuleStore } from "./codex-capsule-store.js";
import {
	type CodexProviderGuardianOptions,
	SupervisedCodexProviderGuardian,
} from "./codex-provider-guardian.js";
import { recoverCodexSandboxContainment } from "./codex-sandbox-containment.js";
import {
	CODEX_SANDBOX_MANIFEST_FILE,
	CodexContainmentTerminationError,
	type CodexSandboxContainment,
	type CodexSandboxRecoveryExpectation,
} from "./codex-sandbox-contract.js";
import {
	RuntimeAuthorityDeniedError,
	type RuntimeAuthorityGrant,
	parseRuntimeAuthorityGrant,
	runtimeAuthorityDenyCodeSchema,
} from "./runtime-authority.js";
import { workspaceResourceSha256 } from "./workspace-resource.js";

type RecoverContainment = (
	expectation: CodexSandboxRecoveryExpectation,
	signal: AbortSignal,
) => Promise<CodexSandboxContainment>;
type CreateGuardian = (options: CodexProviderGuardianOptions) => CodexProviderGuardian;
type OpenRunner = (options: CodexCapsuleRunnerOptions) => Promise<CapsuleRuntime>;

export interface CodexCapsuleRuntimeDependencies {
	readonly recoverContainment?: RecoverContainment;
	readonly createGuardian?: CreateGuardian;
	readonly openRunner?: OpenRunner;
	readonly environment?: NodeJS.ProcessEnv;
}

export interface CodexCapsuleRuntimeControllerOptions {
	readonly directory: string;
	readonly descriptor: CodexCapsuleLaunchDescriptor;
	readonly lifecycle: CapsuleRuntimeLifecycle;
	readonly dependencies?: CodexCapsuleRuntimeDependencies;
}

/** Passive Codex state owner that activates containment and the provider only under authority. */
export class CodexCapsuleRuntimeController implements CapsuleRuntimeController {
	readonly #directory: string;
	readonly #descriptor: CodexCapsuleLaunchDescriptor;
	readonly #lifecycle: CapsuleRuntimeLifecycle;
	readonly #store: CodexCapsuleStore;
	readonly #recoverContainment: RecoverContainment;
	readonly #createGuardian: CreateGuardian;
	readonly #openRunner: OpenRunner;
	readonly #environment: NodeJS.ProcessEnv;
	#activation: Promise<CapsuleRuntime> | null = null;
	#activationTeardownFailure: AggregateError | null = null;
	#closing: Promise<void> | null = null;
	#closed = false;

	private constructor(options: CodexCapsuleRuntimeControllerOptions, store: CodexCapsuleStore) {
		const dependencies = options.dependencies ?? {};
		this.#directory = options.directory;
		this.#descriptor = options.descriptor;
		this.#lifecycle = options.lifecycle;
		this.#store = store;
		this.#recoverContainment = dependencies.recoverContainment ?? recoverCodexSandboxContainment;
		this.#createGuardian =
			dependencies.createGuardian ??
			((guardianOptions) => new SupervisedCodexProviderGuardian(guardianOptions));
		this.#openRunner = dependencies.openRunner ?? CodexCapsuleRunner.open;
		this.#environment = buildBaseCapsuleEnvironment(dependencies.environment);
	}

	static async open(
		options: CodexCapsuleRuntimeControllerOptions,
	): Promise<CodexCapsuleRuntimeController> {
		const store = await CodexCapsuleStore.open(options.directory, {
			capsuleId: options.descriptor.capsule_id,
			session: options.descriptor.session,
		});
		return new CodexCapsuleRuntimeController(options, store);
	}

	async probe(): Promise<AdapterInfo> {
		return structuredClone(CODEX_CAPSULE_ADAPTER_INFO);
	}

	ensureSession(input: SessionInput): Promise<HostSessionRef> {
		return this.#store.ensureSession(input);
	}

	lookupTurn(deliveryId: string, executionAttempt: number): Promise<HostTurnRef | null> {
		return this.#store.lookupTurn(deliveryId, executionAttempt);
	}

	activate(authority: CapsuleRuntimeActivation): Promise<CapsuleRuntime> {
		if (this.#closed) return Promise.reject(new Error("Codex Capsule controller is closed"));
		this.#activation ??= this.performActivation(authority);
		return this.#activation;
	}

	close(): Promise<void> {
		this.#closed = true;
		this.#closing ??= this.performClose();
		return this.#closing;
	}

	private async performActivation(authority: CapsuleRuntimeActivation): Promise<CapsuleRuntime> {
		const grant = parseRuntimeAuthorityGrant(authority.grant);
		this.assertAvailable(authority.signal);
		assertDescriptorScope(this.#descriptor, grant);

		let runtime: CapsuleRuntime | null = null;
		try {
			const guardedRuntime = await authority.performWorkspaceRead(async () => {
				this.assertAvailable(authority.signal);
				let containment: CodexSandboxContainment;
				try {
					containment = await this.#recoverContainment(
						this.#descriptor.runtime.containment,
						authority.signal,
					);
				} catch (error) {
					if (error instanceof CodexContainmentTerminationError) throw error;
					this.assertAvailable(authority.signal);
					throw error;
				}
				this.assertAvailable(authority.signal);
				assertRecoveredContainment(this.#directory, this.#descriptor, grant, containment);

				const guardian = this.#createGuardian({
					capsuleId: this.#descriptor.capsule_id,
					deadlineAtMs: Date.parse(grant.hard_expires_at),
					authoritySignal: authority.signal,
					command: { executable: containment.authorization.providerExecutable },
					cwd: containment.authorization.workspace.root,
					capsuleDirectory: containment.authorization.runtimeDirectory,
					env: this.#environment,
					boundary: containment.boundary,
				});
				this.assertAvailable(authority.signal);
				runtime = await this.#openRunner({
					store: this.#store,
					cwd: containment.authorization.workspace.root,
					guardian,
					retireGeneration: this.#lifecycle.retire,
				});
				this.assertAvailable(authority.signal);
				return runtime;
			});
			runtime = guardedRuntime;
			this.assertAvailable(authority.signal);
			return runtime;
		} catch (error) {
			if (runtime !== null) {
				try {
					await runtime.close();
				} catch (closeError) {
					this.#activationTeardownFailure = new AggregateError(
						[error, closeError],
						"Codex runtime activation teardown could not be proven",
					);
					throw this.#activationTeardownFailure;
				}
			}
			throw error;
		}
	}

	private async performClose(): Promise<void> {
		const runtime = await this.#activation?.catch(() => null);
		const failures: unknown[] = [];
		try {
			if (runtime === null || runtime === undefined) {
				await this.#store.close();
			} else {
				await runtime.close();
			}
		} catch (error) {
			failures.push(error);
		}
		if (this.#activationTeardownFailure !== null) {
			failures.unshift(this.#activationTeardownFailure);
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(failures, "Codex Capsule controller shutdown could not be proven");
		}
	}

	private assertAvailable(signal: AbortSignal): void {
		if (this.#closed) throw new Error("Codex Capsule controller is closed");
		if (!signal.aborted) return;
		const reason = runtimeAuthorityDenyCodeSchema.safeParse(signal.reason);
		throw new RuntimeAuthorityDeniedError(reason.success ? reason.data : "revoked");
	}
}

function assertDescriptorScope(
	descriptor: CodexCapsuleLaunchDescriptor,
	grant: RuntimeAuthorityGrant,
): void {
	if (descriptor.session.missionId !== grant.mission_id) {
		throw new RuntimeAuthorityDeniedError("wrong_mission");
	}
	if (descriptor.session.participantId !== grant.agent_id) {
		throw new RuntimeAuthorityDeniedError("wrong_agent");
	}
	if (descriptor.session.workspaceAlias !== grant.workspace_alias) {
		throw new RuntimeAuthorityDeniedError("wrong_workspace");
	}
}

function assertRecoveredContainment(
	directory: string,
	descriptor: CodexCapsuleLaunchDescriptor,
	grant: RuntimeAuthorityGrant,
	containment: CodexSandboxContainment,
): void {
	const expected = descriptor.runtime.containment;
	if (
		containment.recovery.manifestPath !== expected.manifestPath ||
		containment.recovery.instanceId !== expected.instanceId ||
		containment.recovery.bindingSha256 !== expected.bindingSha256 ||
		containment.evidence.instanceId !== expected.instanceId ||
		containment.evidence.bindingSha256 !== expected.bindingSha256
	) {
		throw new Error("Recovered containment does not match the Capsule descriptor");
	}
	const authorization = containment.authorization;
	if (authorization.workspaceAccess !== "read") {
		throw new Error("Recovered containment does not enforce read-only workspace access");
	}
	if (
		authorization.controlDirectory !== directory ||
		expected.manifestPath !== join(directory, CODEX_SANDBOX_MANIFEST_FILE) ||
		dirname(expected.manifestPath) !== authorization.controlDirectory
	) {
		throw new Error("Recovered containment does not match the Capsule control directory");
	}
	if (
		containment.runtimeHome !== join(authorization.runtimeDirectory, "codex-home") ||
		containment.runtimeTmp !== join(authorization.runtimeDirectory, "tmp")
	) {
		throw new Error("Recovered containment does not match its bound runtime directory");
	}
	if (
		authorization.runtimeVersion !== descriptor.runtime.codex_cli_version ||
		containment.evidence.runtimeVersion !== descriptor.runtime.codex_cli_version
	) {
		throw new Error("Recovered containment uses an unsupported Codex runtime");
	}
	if (containment.evidence.baseCommit !== authorization.workspace.headCommit) {
		throw new Error("Recovered containment workspace evidence is inconsistent");
	}
	if (authorization.policyGrantSha256 !== grant.policy_grant_sha256) {
		throw new RuntimeAuthorityDeniedError("policy_changed");
	}
	const workspaceDigest = workspaceResourceSha256({
		workspaceBindingId: grant.workspace_binding_id,
		workspaceAlias: grant.workspace_alias,
		root: authorization.workspace.root,
		repositoryUrl: authorization.workspace.repositoryUrl,
		headCommit: authorization.workspace.headCommit,
		reachableFromRef: authorization.workspace.reachableFromRef,
	});
	if (workspaceDigest !== grant.workspace_resource_sha256) {
		throw new RuntimeAuthorityDeniedError("wrong_resource");
	}
}
