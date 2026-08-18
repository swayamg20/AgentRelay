import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import {
	type FileHandle,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	rename,
	unlink,
} from "node:fs/promises";
import { type Socket, createConnection } from "node:net";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
	type AdapterInfo,
	type AgentHostAdapter,
	type HostEvent,
	type HostSessionRef,
	type HostTurnRef,
	type SessionInput,
	type StartTurnInput,
	hostExecutionAttemptSchema,
	hostTurnRefSchema,
	sessionInputSchema,
	startTurnInputSchema,
	uuidSchema,
} from "@agentrelay/protocol";
import { z } from "zod";
import {
	type CachedCapsuleAuthority,
	CapsuleAuthorityRegistry,
} from "./capsule-authority-registry.js";
import { buildBaseCapsuleEnvironment } from "./capsule-environment.js";
import {
	CAPSULE_DESCRIPTOR_FILE,
	type FakeCapsuleLaunchDescriptor,
	type FakeCapsuleOutcome,
	capsuleSocketPath,
	fakeCapsuleLaunchDescriptorSchema,
	fakeCapsuleOutcomeSchema,
	readFakeCapsuleLaunchDescriptor,
} from "./capsule-launch-descriptor.js";
import {
	CAPSULE_ADAPTER_INFO,
	type CapsuleErrorCode,
	type CapsuleRequest,
	type CapsuleResponse,
	MAX_CAPSULE_REQUEST_FRAME_BYTES,
	MAX_CAPSULE_RESPONSE_FRAME_BYTES,
	capsuleEmptyResultSchema,
	capsuleEnsureSessionResultSchema,
	capsuleLookupTurnResultSchema,
	capsuleProbeResultSchema,
	capsuleResponseSchema,
} from "./capsule-protocol.js";
import { syncDirectory, writeDurableJson } from "./durable-file.js";
import { digestStartTurnInput, executionKey } from "./fake-capsule-store.js";
import type { RuntimeAuthorityPort } from "./runtime-authority-port.js";
import {
	type RuntimeAuthorityDenyCode,
	type RuntimeAuthorityGrant,
	type RuntimeAuthorityRenewal,
	type RuntimeAuthorityRequest,
	parseRuntimeAuthorityGrant,
	runtimeAuthorityDenyCodeSchema,
	runtimeAuthorityGrantSha256,
	runtimeAuthorityRenewalSchema,
	runtimeAuthorityRequest,
	runtimeAuthorityRequestSchema,
} from "./runtime-authority.js";

const CAPSULE_REGISTRY_FILE = "registry.json";
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const CAPSULE_CONNECT_TIMEOUT_MS = 2_000;
const CAPSULE_RESPONSE_IDLE_TIMEOUT_MS = 65_000;

const executionRecordSchema = z
	.object({
		delivery_id: uuidSchema,
		execution_attempt: hostExecutionAttemptSchema,
		mission_id: uuidSchema,
		capsule_id: uuidSchema,
		input_sha256: z.string().regex(/^[a-f0-9]{64}$/),
		recorded_at: z.string().datetime({ offset: true }),
	})
	.strict();

const capsuleRegistrySchema = z
	.object({
		schema_version: z.literal(1),
		executions: z.record(executionRecordSchema),
	})
	.strict();

type CapsuleRegistry = z.infer<typeof capsuleRegistrySchema>;
type ExecutionRecord = z.infer<typeof executionRecordSchema>;

interface SocketIdentity {
	readonly dev: number;
	readonly ino: number;
}

type CapsuleLaunchPreparation = "ready" | "launch" | "retry";

export interface CapsuleLauncher {
	start(capsuleDirectory: string): Promise<void>;
}

export interface CapsuleProcessCommand {
	readonly executable: string;
	readonly args: readonly string[];
}

export interface PersistentFakeCapsuleAdapterOptions {
	readonly rootDirectory: string;
	readonly launcher: CapsuleLauncher;
	readonly outcome?: FakeCapsuleOutcome;
	readonly completionDelayMs?: number;
	readonly startupTimeoutMs?: number;
}

export class CapsuleRpcError extends Error {
	constructor(
		readonly code: CapsuleErrorCode | "transport",
		message: string,
		options: ErrorOptions = {},
	) {
		super(message, options);
		this.name = "CapsuleRpcError";
	}
}

/** Node-side adapter for independently persistent, one-Mission fake capsule processes. */
export class PersistentFakeCapsuleAdapter implements AgentHostAdapter, RuntimeAuthorityPort {
	readonly #rootDirectory: string;
	readonly #registryPath: string;
	readonly #launcher: CapsuleLauncher;
	readonly #outcome: FakeCapsuleOutcome;
	readonly #completionDelayMs: number;
	readonly #startupTimeoutMs: number;
	#registry: CapsuleRegistry;
	#pendingRegistryWrite: Promise<void> = Promise.resolve();
	readonly #descriptorReadiness = new Map<string, Promise<FakeCapsuleLaunchDescriptor>>();
	readonly #capsuleReadiness = new Map<string, Promise<void>>();
	readonly #authorities = new CapsuleAuthorityRegistry();

	private constructor(
		options: Required<PersistentFakeCapsuleAdapterOptions>,
		registry: CapsuleRegistry,
	) {
		this.#rootDirectory = options.rootDirectory;
		this.#registryPath = join(options.rootDirectory, CAPSULE_REGISTRY_FILE);
		this.#launcher = options.launcher;
		this.#outcome = options.outcome;
		this.#completionDelayMs = options.completionDelayMs;
		this.#startupTimeoutMs = options.startupTimeoutMs;
		this.#registry = registry;
	}

	static async open(
		options: PersistentFakeCapsuleAdapterOptions,
	): Promise<PersistentFakeCapsuleAdapter> {
		const rootDirectory = validateRootDirectory(options.rootDirectory);
		const outcome = fakeCapsuleOutcomeSchema.parse(options.outcome ?? "ready");
		const completionDelayMs = z
			.number()
			.int()
			.min(0)
			.max(60_000)
			.parse(options.completionDelayMs ?? 0);
		const startupTimeoutMs = z
			.number()
			.int()
			.min(100)
			.max(60_000)
			.parse(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
		await ensurePrivateDirectory(rootDirectory);
		const decoded = await readSecureJsonIfPresent(join(rootDirectory, CAPSULE_REGISTRY_FILE));
		const registry = capsuleRegistrySchema.parse(decoded ?? { schema_version: 1, executions: {} });
		validateRegistry(registry);
		return new PersistentFakeCapsuleAdapter(
			{
				rootDirectory,
				launcher: options.launcher,
				outcome,
				completionDelayMs,
				startupTimeoutMs,
			},
			registry,
		);
	}

	async probe(): Promise<AdapterInfo> {
		return structuredClone(CAPSULE_ADAPTER_INFO);
	}

	async installAuthority(
		grantValue: RuntimeAuthorityGrant,
		currentLeaseValue: RuntimeAuthorityRenewal,
	): Promise<void> {
		const grant = parseRuntimeAuthorityGrant(grantValue);
		const currentLease = runtimeAuthorityRenewalSchema.parse(currentLeaseValue);
		assertCurrentLeaseMatchesGrant(grant, currentLease);
		await this.#authorities.runTransition(grant.mission_id, async () => {
			const incomingSha256 = runtimeAuthorityGrantSha256(grant);
			const existing = this.#authorities.get(grant.mission_id);
			if (existing?.status === "revoking") {
				throw authorityDenied("Runtime authority revocation is still in progress");
			}
			if (this.#authorities.isRevoked(grant.mission_id, grant.grant_id)) {
				throw authorityDenied("Runtime authority grant has been revoked");
			}
			const exactReplay = existing?.acceptedInstallSha256 === incomingSha256;
			if (existing?.status === "active" && !exactReplay) {
				throw authorityDenied("Active runtime authority must be revoked before replacement");
			}
			if (existing?.status === "installing" && !exactReplay) {
				throw authorityDenied("Runtime authority install outcome is unresolved");
			}
			if (existing?.status === "active" || existing?.status === "installing") {
				assertLeaseDoesNotRegress(existing.currentLease, currentLease);
			}
			const descriptor = await this.ensureDescriptor(sessionFromGrant(grant));
			await this.ensureCapsuleReady(descriptor);
			const installing = this.#authorities.beginInstall(
				{
					acceptedInstallSha256: incomingSha256,
					grant: exactReplay && existing !== undefined ? existing.grant : grant,
					currentLease,
				},
				existing,
			);
			capsuleEmptyResultSchema.parse(
				await this.requestUnary(descriptor, "install_authority", {
					grant,
					current_lease: currentLease,
				}),
			);
			this.#authorities.markActive(installing);
		});
	}

	async renewAuthority(
		missionIdValue: string,
		renewalValue: RuntimeAuthorityRenewal,
	): Promise<void> {
		const missionId = uuidSchema.parse(missionIdValue);
		const renewal = runtimeAuthorityRenewalSchema.parse(renewalValue);
		await this.#authorities.runTransition(missionId, async () => {
			const authority = this.requireAuthority(missionId);
			if (renewal.grant_id !== authority.grant.grant_id) {
				throw authorityDenied("Runtime authority grant does not match this Mission");
			}
			const descriptor = await this.requireDescriptor(missionId, sessionFromGrant(authority.grant));
			await this.ensureCapsuleWithinTransition(descriptor);
			capsuleEmptyResultSchema.parse(
				await this.requestUnary(descriptor, "renew_authority", {
					mission_id: missionId,
					renewal,
				}),
			);
			this.#authorities.renew(authority, renewal);
		});
	}

	async assertAuthority(requestValue: RuntimeAuthorityRequest): Promise<void> {
		const request = runtimeAuthorityRequestSchema.parse(requestValue);
		const authority = this.requireAuthority(request.mission_id);
		if (request.grant_id !== authority.grant.grant_id) {
			throw authorityDenied("Runtime authority grant does not match this Mission");
		}
		const descriptor = await this.requireDescriptor(
			request.mission_id,
			sessionFromGrant(authority.grant),
		);
		await this.ensureCapsule(descriptor);
		if (this.requireAuthority(request.mission_id).grant.grant_id !== request.grant_id) {
			throw authorityDenied("Runtime authority grant does not match this Mission");
		}
		capsuleEmptyResultSchema.parse(
			await this.requestUnary(descriptor, "assert_authority", { request }),
		);
	}

	async revokeAuthority(
		grantValue: RuntimeAuthorityGrant,
		reasonValue: RuntimeAuthorityDenyCode,
	): Promise<void> {
		const grant = parseRuntimeAuthorityGrant(grantValue);
		const missionId = grant.mission_id;
		const grantId = grant.grant_id;
		const reason = runtimeAuthorityDenyCodeSchema.parse(reasonValue);
		await this.#authorities.runTransition(missionId, async () => {
			const authority = this.#authorities.get(missionId);
			if (authority === undefined) {
				if (this.#authorities.isRevoked(missionId, grantId)) return;
				await this.revokeUncachedAuthority(grant, reason);
				this.#authorities.recordRevokedGrant(missionId, grantId);
				return;
			}
			if (runtimeAuthorityGrantSha256(grant) !== authority.acceptedInstallSha256) {
				throw authorityDenied("Runtime authority grant does not match this Mission");
			}
			if (authority.status === "revoked") return;
			const revoking =
				authority.status === "revoking" ? authority : this.#authorities.markRevoking(authority);
			const descriptor = await this.requireDescriptor(missionId, sessionFromGrant(authority.grant));
			try {
				capsuleEmptyResultSchema.parse(
					await this.requestUnary(descriptor, "revoke_authority", {
						mission_id: missionId,
						grant_id: grantId,
						reason,
					}),
				);
			} catch (error) {
				if (isAuthorityNotInstalled(error)) {
					await this.shutdownUninstalledCapsule(descriptor);
				} else if (!isTransportError(error)) {
					throw error;
				}
			}
			await this.waitForCapsuleRetirement(descriptor);
			this.#authorities.markRevoked(revoking);
		});
	}

	async ensureSession(inputValue: SessionInput): Promise<HostSessionRef> {
		const input = sessionInputSchema.parse(inputValue);
		this.assertSessionAuthority(input);
		const descriptor = await this.ensureDescriptor(input);
		await this.ensureCapsule(descriptor);
		this.assertSessionAuthority(input);
		return capsuleEnsureSessionResultSchema.parse(
			await this.requestUnary(descriptor, "ensure_session", { input }),
		);
	}

	async lookupTurn(
		deliveryIdValue: string,
		executionAttemptValue: number,
	): Promise<HostTurnRef | null> {
		const deliveryId = uuidSchema.parse(deliveryIdValue);
		const executionAttempt = hostExecutionAttemptSchema.parse(executionAttemptValue);
		await this.#pendingRegistryWrite;
		const record = this.#registry.executions[executionKey(deliveryId, executionAttempt)];
		if (record === undefined) return null;
		const descriptor = await this.requireDescriptor(record.mission_id, record.capsule_id);
		await this.ensureCapsule(descriptor, false);
		return capsuleLookupTurnResultSchema.parse(
			await this.requestUnary(descriptor, "lookup_turn", {
				delivery_id: deliveryId,
				execution_attempt: executionAttempt,
			}),
		);
	}

	startTurn(inputValue: StartTurnInput): AsyncIterable<HostEvent> {
		const input = startTurnInputSchema.parse(inputValue);
		return this.streamStart(input);
	}

	recoverTurn(refValue: HostTurnRef, expectedInputValue: StartTurnInput): AsyncIterable<HostEvent> {
		const ref = hostTurnRefSchema.parse(refValue);
		const expectedInput = startTurnInputSchema.parse(expectedInputValue);
		return this.streamRecovery(ref, expectedInput);
	}

	async cancelTurn(refValue: HostTurnRef): Promise<void> {
		const ref = hostTurnRefSchema.parse(refValue);
		this.assertTurnAuthority(undefined, ref);
		const record = await this.requireExecution(ref.deliveryId, ref.executionAttempt, ref.missionId);
		const descriptor = await this.requireDescriptor(record.mission_id, record.capsule_id);
		await this.ensureCapsule(descriptor);
		this.assertTurnAuthority(undefined, ref);
		capsuleEmptyResultSchema.parse(
			await this.requestUnary(descriptor, "cancel_turn", { turn: ref }),
		);
	}

	/** Test/operator cleanup only. Normal Node shutdown intentionally leaves capsules alive. */
	async terminateAll(): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await readdir(this.#rootDirectory, { withFileTypes: true });
		} catch (error) {
			if (errorCode(error) === "ENOENT") return;
			throw error;
		}
		const failures: unknown[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || !uuidSchema.safeParse(entry.name).success) continue;
			let descriptor: FakeCapsuleLaunchDescriptor;
			try {
				descriptor = await readFakeCapsuleLaunchDescriptor(join(this.#rootDirectory, entry.name));
			} catch (error) {
				failures.push(error);
				continue;
			}
			try {
				await this.requestUnary(descriptor, "shutdown", {});
			} catch (error) {
				if (!isUnavailableTransport(error)) failures.push(error);
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, "Failed to terminate one or more Mission capsules");
		}
	}

	private async *streamStart(input: StartTurnInput): AsyncIterable<HostEvent> {
		this.assertTurnAuthority(input);
		const descriptor = await this.requireDescriptor(input.missionId, input.session, true);
		await this.recordExecution(input, descriptor.capsule_id);
		await this.ensureCapsule(descriptor);
		this.assertTurnAuthority(input);
		yield* this.requestEvents(descriptor, "start_turn", { input });
	}

	private async *streamRecovery(
		ref: HostTurnRef,
		expectedInput: StartTurnInput,
	): AsyncIterable<HostEvent> {
		this.assertTurnAuthority(expectedInput, ref);
		const record = await this.requireExecution(ref.deliveryId, ref.executionAttempt, ref.missionId);
		if (record.input_sha256 !== digestStartTurnInput(expectedInput)) {
			throw new CapsuleRpcError(
				"correlation_conflict",
				"Recovered turn input does not match its durable capsule start intent",
			);
		}
		const descriptor = await this.requireDescriptor(record.mission_id, record.capsule_id);
		await this.ensureCapsule(descriptor);
		this.assertTurnAuthority(expectedInput, ref);
		yield* this.requestEvents(descriptor, "recover_turn", { turn: ref, input: expectedInput });
	}

	private requireAuthority(missionId: string): CachedCapsuleAuthority {
		const authority = this.#authorities.get(missionId);
		if (authority === undefined) {
			throw authorityDenied("Runtime authority is not installed for this Mission");
		}
		if (authority.status === "installing") {
			throw authorityDenied("Runtime authority install outcome is unresolved");
		}
		if (authority.status === "revoking") {
			throw authorityDenied("Runtime authority revocation is still in progress");
		}
		if (authority.status === "revoked") {
			throw authorityDenied("Runtime authority grant has been revoked");
		}
		return authority;
	}

	private assertSessionAuthority(input: SessionInput): void {
		assertGrantSession(this.requireAuthority(input.missionId).grant, input);
	}

	private assertTurnAuthority(input?: StartTurnInput, turn?: HostTurnRef): void {
		const missionId = input?.missionId ?? turn?.missionId;
		if (missionId === undefined) {
			throw authorityDenied("Runtime turn authority cannot be resolved");
		}
		const grant = this.requireAuthority(missionId).grant;
		if (input !== undefined) {
			assertGrantSession(grant, input.session);
			if (
				input.deliveryId !== grant.delivery_id ||
				input.executionAttempt !== grant.execution_attempt
			) {
				throw authorityDenied("Runtime turn does not match its delivery authority");
			}
		}
		if (
			turn !== undefined &&
			(turn.missionId !== grant.mission_id ||
				turn.deliveryId !== grant.delivery_id ||
				turn.executionAttempt !== grant.execution_attempt)
		) {
			throw authorityDenied("Runtime turn does not match its delivery authority");
		}
	}

	private async ensureDescriptor(input: SessionInput): Promise<FakeCapsuleLaunchDescriptor> {
		let readiness = this.#descriptorReadiness.get(input.missionId);
		if (readiness === undefined) {
			readiness = this.loadOrCreateDescriptor(input);
			this.#descriptorReadiness.set(input.missionId, readiness);
		}
		try {
			const descriptor = await readiness;
			this.assertDescriptorConfig(descriptor, input);
			return descriptor;
		} finally {
			if (this.#descriptorReadiness.get(input.missionId) === readiness) {
				this.#descriptorReadiness.delete(input.missionId);
			}
		}
	}

	private async loadOrCreateDescriptor(input: SessionInput): Promise<FakeCapsuleLaunchDescriptor> {
		const directory = this.capsuleDirectory(input.missionId);
		await ensurePrivateDirectory(directory);
		const descriptorPath = join(directory, CAPSULE_DESCRIPTOR_FILE);
		const existing = await readSecureJsonIfPresent(descriptorPath);
		if (existing !== null) {
			return readFakeCapsuleLaunchDescriptor(directory);
		}
		const capsuleId = randomUUID();
		const descriptor = fakeCapsuleLaunchDescriptorSchema.parse({
			schema_version: 1,
			capsule_id: capsuleId,
			capability_token: `ar_capsule_${randomBytes(32).toString("hex")}`,
			socket_path: capsuleSocketPath(capsuleId),
			session: input,
			runtime: {
				kind: "fake",
				outcome: this.#outcome,
				completion_delay_ms: this.#completionDelayMs,
			},
		});
		await writeDurableJson(descriptorPath, descriptor, {
			fileMode: 0o600,
			directoryMode: 0o700,
		});
		return descriptor;
	}

	private async requireDescriptor(
		missionId: string,
		expected: string | SessionInput,
		allowMissing = false,
	): Promise<FakeCapsuleLaunchDescriptor> {
		const descriptor = await readFakeCapsuleLaunchDescriptor(
			this.capsuleDirectory(missionId),
		).catch((error) => {
			if (allowMissing)
				throw new CapsuleRpcError("transport", "Capsule session is not initialized", {
					cause: error,
				});
			throw error;
		});
		if (typeof expected === "string") {
			if (descriptor.capsule_id !== expected) {
				throw new CapsuleRpcError(
					"correlation_conflict",
					"Execution registry points to a different capsule generation",
				);
			}
		} else if (
			expected.missionId !== descriptor.session.missionId ||
			expected.participantId !== descriptor.session.participantId ||
			expected.workspaceAlias !== descriptor.session.workspaceAlias
		) {
			throw new CapsuleRpcError(
				"scope_mismatch",
				"Host session does not match its persisted capsule scope",
			);
		}
		this.assertDescriptorConfig(descriptor, descriptor.session);
		return descriptor;
	}

	private assertDescriptorConfig(
		descriptor: FakeCapsuleLaunchDescriptor,
		input: SessionInput,
	): void {
		if (!isDeepStrictEqual(descriptor.session, input)) {
			throw new CapsuleRpcError(
				"scope_mismatch",
				"Mission capsule cannot be reused across participant or workspace scope",
			);
		}
		if (
			descriptor.runtime.outcome !== this.#outcome ||
			descriptor.runtime.completion_delay_ms !== this.#completionDelayMs
		) {
			throw new CapsuleRpcError(
				"correlation_conflict",
				"Existing Mission capsule runtime configuration does not match this Node",
			);
		}
	}

	private async recordExecution(input: StartTurnInput, capsuleId: string): Promise<void> {
		const key = executionKey(input.deliveryId, input.executionAttempt);
		const digest = digestStartTurnInput(input);
		await this.mutateRegistry((registry) => {
			const existing = registry.executions[key];
			if (existing !== undefined) {
				if (
					existing.mission_id !== input.missionId ||
					existing.capsule_id !== capsuleId ||
					existing.input_sha256 !== digest
				) {
					throw new CapsuleRpcError(
						"correlation_conflict",
						"Execution key was already bound to a different capsule start intent",
					);
				}
				return;
			}
			registry.executions[key] = {
				delivery_id: input.deliveryId,
				execution_attempt: input.executionAttempt,
				mission_id: input.missionId,
				capsule_id: capsuleId,
				input_sha256: digest,
				recorded_at: new Date().toISOString(),
			};
		});
	}

	private async requireExecution(
		deliveryId: string,
		executionAttempt: number,
		missionId: string,
	): Promise<ExecutionRecord> {
		await this.#pendingRegistryWrite;
		const record = this.#registry.executions[executionKey(deliveryId, executionAttempt)];
		if (record === undefined || record.mission_id !== missionId) {
			throw new CapsuleRpcError(
				"not_found",
				`Capsule execution is not durably registered: ${deliveryId}:${executionAttempt}`,
			);
		}
		return structuredClone(record);
	}

	private async mutateRegistry(mutator: (registry: CapsuleRegistry) => void): Promise<void> {
		const write = this.#pendingRegistryWrite.then(async () => {
			const next = structuredClone(this.#registry);
			mutator(next);
			validateRegistry(next);
			await writeDurableJson(this.#registryPath, next, {
				fileMode: 0o600,
				directoryMode: 0o700,
			});
			this.#registry = next;
		});
		this.#pendingRegistryWrite = write.catch(() => undefined);
		await write;
	}

	private ensureCapsule(
		descriptor: FakeCapsuleLaunchDescriptor,
		requireActiveAuthority = true,
	): Promise<void> {
		return this.#authorities.runTransition(descriptor.session.missionId, () =>
			this.ensureCapsuleWithinTransition(descriptor, requireActiveAuthority),
		);
	}

	private async ensureCapsuleWithinTransition(
		descriptor: FakeCapsuleLaunchDescriptor,
		requireActiveAuthority = true,
	): Promise<void> {
		const authority = this.#authorities.get(descriptor.session.missionId);
		if (authority?.status === "revoking") {
			throw authorityDenied("Runtime authority revocation is still in progress");
		}
		if (requireActiveAuthority && authority?.status !== "active") {
			throw authorityDenied(
				authority?.status === "revoked"
					? "Runtime authority grant has been revoked"
					: "Runtime authority is not installed for this Mission",
			);
		}
		await this.ensureCapsuleReady(descriptor);
		if (requireActiveAuthority) await this.syncAuthorityWithinTransition(descriptor);
	}

	private async ensureCapsuleReady(descriptor: FakeCapsuleLaunchDescriptor): Promise<void> {
		let readiness = this.#capsuleReadiness.get(descriptor.capsule_id);
		if (readiness === undefined) {
			readiness = this.startOrAwaitCapsule(descriptor);
			this.#capsuleReadiness.set(descriptor.capsule_id, readiness);
		}
		try {
			await readiness;
		} finally {
			if (this.#capsuleReadiness.get(descriptor.capsule_id) === readiness) {
				this.#capsuleReadiness.delete(descriptor.capsule_id);
			}
		}
	}

	private async startOrAwaitCapsule(descriptor: FakeCapsuleLaunchDescriptor): Promise<void> {
		const deadline = Date.now() + this.#startupTimeoutMs;
		let waitMs = 20;
		let lastError: unknown;
		let launchAttempted = false;
		while (Date.now() < deadline) {
			try {
				await this.probeCapsule(descriptor);
				return;
			} catch (error) {
				lastError = error;
				if (!isTransportError(error)) throw error;
				if (!launchAttempted && isUnavailableTransport(error)) {
					const preparation = await this.prepareCapsuleLaunch(descriptor);
					if (preparation === "ready") return;
					if (preparation === "launch") {
						launchAttempted = true;
						try {
							await this.#launcher.start(this.capsuleDirectory(descriptor.session.missionId));
						} catch (launchError) {
							// A concurrent launcher may have won publication. The authenticated
							// probe below decides whether the Capsule is actually ready.
							lastError = launchError;
						}
					}
				}
				await delay(waitMs);
				waitMs = Math.min(waitMs * 2, 200);
			}
		}
		throw new CapsuleRpcError("transport", "Mission capsule did not become ready", {
			cause: lastError,
		});
	}

	private async prepareCapsuleLaunch(
		descriptor: FakeCapsuleLaunchDescriptor,
	): Promise<CapsuleLaunchPreparation> {
		try {
			await this.probeCapsule(descriptor);
			return "ready";
		} catch (error) {
			if (!isUnavailableTransport(error)) throw error;
			if (!isConnectionRefusedTransport(error)) return "launch";
		}

		const before = await readPrivateSocketIdentity(descriptor.socket_path);
		if (before === null) return "launch";

		// A second authenticated probe protects a Capsule that became ready after
		// the first refused connection.
		try {
			await this.probeCapsule(descriptor);
			return "ready";
		} catch (error) {
			if (!isUnavailableTransport(error)) throw error;
			if (!isConnectionRefusedTransport(error)) return "launch";
		}

		const after = await readPrivateSocketIdentity(descriptor.socket_path);
		if (after === null) return "launch";
		if (!sameSocketIdentity(before, after)) return "retry";
		return removeUnchangedSocket(descriptor.socket_path, after);
	}

	private async probeCapsule(descriptor: FakeCapsuleLaunchDescriptor): Promise<void> {
		await assertPrivateSocket(descriptor.socket_path);
		const info = capsuleProbeResultSchema.parse(await this.requestUnary(descriptor, "probe", {}));
		if (!isDeepStrictEqual(info, CAPSULE_ADAPTER_INFO)) {
			throw new CapsuleRpcError(
				"correlation_conflict",
				"Mission capsule reports an unsupported adapter identity",
			);
		}
	}

	private async syncAuthorityWithinTransition(
		descriptor: FakeCapsuleLaunchDescriptor,
	): Promise<void> {
		const missionId = descriptor.session.missionId;
		const authority = this.#authorities.get(missionId);
		if (authority === undefined) return;
		if (authority.status === "revoking") {
			throw authorityDenied("Runtime authority revocation is still in progress");
		}
		if (authority.status === "revoked") return;
		assertGrantSession(authority.grant, descriptor.session);
		const request = runtimeAuthorityRequest(authority.grant, {
			action: "runtime_start",
			resource: "runtime",
		});
		try {
			capsuleEmptyResultSchema.parse(
				await this.requestUnary(descriptor, "assert_authority", { request }),
			);
			return;
		} catch (error) {
			if (!isAuthorityNotInstalled(error)) throw error;
		}
		capsuleEmptyResultSchema.parse(
			await this.requestUnary(descriptor, "install_authority", {
				grant: authority.grant,
				current_lease: authority.currentLease,
			}),
		);
	}

	private async revokeUncachedAuthority(
		grant: RuntimeAuthorityGrant,
		reason: RuntimeAuthorityDenyCode,
	): Promise<void> {
		let descriptor: FakeCapsuleLaunchDescriptor;
		try {
			descriptor = await this.requireDescriptor(grant.mission_id, sessionFromGrant(grant));
		} catch (error) {
			// A durable Node checkpoint can precede descriptor creation. Since the
			// launcher is never called before launch.json is persisted, exact absence
			// proves that this adapter could not have started a Capsule generation.
			if (isMissingCapsuleDescriptor(error)) return;
			throw error;
		}
		try {
			capsuleEmptyResultSchema.parse(
				await this.requestUnary(descriptor, "revoke_authority", {
					mission_id: grant.mission_id,
					grant_id: grant.grant_id,
					reason,
				}),
			);
		} catch (error) {
			if (isAuthorityNotInstalled(error)) {
				await this.shutdownUninstalledCapsule(descriptor);
			} else if (!isTransportError(error)) {
				throw error;
			}
		}
		await this.waitForCapsuleRetirement(descriptor);
	}

	private async shutdownUninstalledCapsule(descriptor: FakeCapsuleLaunchDescriptor): Promise<void> {
		try {
			capsuleEmptyResultSchema.parse(await this.requestUnary(descriptor, "shutdown", {}));
		} catch (error) {
			if (!isTransportError(error)) throw error;
		}
	}

	private async waitForCapsuleRetirement(descriptor: FakeCapsuleLaunchDescriptor): Promise<void> {
		const deadline = Date.now() + this.#startupTimeoutMs;
		let waitMs = 10;
		while (Date.now() < deadline) {
			try {
				await this.probeCapsule(descriptor);
			} catch (error) {
				if (isUnavailableTransport(error)) return;
				if (!isTransportError(error)) throw error;
			}
			await delay(waitMs);
			waitMs = Math.min(waitMs * 2, 100);
		}
		throw new CapsuleRpcError(
			"transport",
			"Revoked Mission capsule did not retire before the local deadline",
		);
	}

	private async requestUnary(
		descriptor: FakeCapsuleLaunchDescriptor,
		method:
			| "probe"
			| "install_authority"
			| "assert_authority"
			| "renew_authority"
			| "revoke_authority"
			| "ensure_session"
			| "lookup_turn"
			| "cancel_turn"
			| "shutdown",
		params: Record<string, unknown>,
	): Promise<unknown> {
		let result: unknown;
		let resultCount = 0;
		for await (const response of this.requestFrames(descriptor, method, params)) {
			if (response.kind === "event") {
				throw new CapsuleRpcError("transport", "Capsule returned an event to a unary request");
			}
			if (response.kind === "result") {
				result = response.value;
				resultCount += 1;
			}
		}
		if (resultCount !== 1) {
			throw new CapsuleRpcError("transport", "Capsule unary response count is invalid");
		}
		return result;
	}

	private async *requestEvents(
		descriptor: FakeCapsuleLaunchDescriptor,
		method: "start_turn" | "recover_turn",
		params: Record<string, unknown>,
	): AsyncIterable<HostEvent> {
		let eventCount = 0;
		for await (const response of this.requestFrames(descriptor, method, params)) {
			if (response.kind === "result") {
				throw new CapsuleRpcError(
					"transport",
					"Capsule returned a unary result to an event request",
				);
			}
			if (response.kind === "event") {
				eventCount += 1;
				yield response.event;
			}
		}
		if (eventCount === 0) {
			throw new CapsuleRpcError("transport", "Capsule event stream ended without acceptance");
		}
	}

	private async *requestFrames(
		descriptor: FakeCapsuleLaunchDescriptor,
		method: CapsuleRequest["method"],
		params: Record<string, unknown>,
	): AsyncIterable<CapsuleResponse> {
		const requestId = randomUUID();
		const request = {
			version: 1 as const,
			capsule_id: descriptor.capsule_id,
			capability_token: descriptor.capability_token,
			request_id: requestId,
			method,
			params,
		};
		const frame = `${JSON.stringify(request)}\n`;
		if (Buffer.byteLength(frame, "utf8") > MAX_CAPSULE_REQUEST_FRAME_BYTES) {
			throw new CapsuleRpcError("transport", "Capsule request frame exceeds the byte limit");
		}
		const socket = await connect(descriptor.socket_path);
		let ended = false;
		try {
			socket.setTimeout(CAPSULE_RESPONSE_IDLE_TIMEOUT_MS, () => {
				socket.destroy(new Error("Timed out waiting for a capsule response frame"));
			});
			socket.write(frame);
			for await (const line of readResponseLines(socket)) {
				const response = capsuleResponseSchema.parse(JSON.parse(line));
				if (response.request_id !== requestId || response.capsule_id !== descriptor.capsule_id) {
					throw new CapsuleRpcError("transport", "Capsule response correlation mismatch");
				}
				if (response.kind === "error") {
					throw new CapsuleRpcError(response.code, response.message);
				}
				if (response.kind === "end") {
					ended = true;
					return;
				}
				yield response;
			}
			if (!ended)
				throw new CapsuleRpcError("transport", "Capsule connection ended without a terminator");
		} catch (error) {
			if (error instanceof CapsuleRpcError) throw error;
			throw new CapsuleRpcError("transport", "Capsule request failed", { cause: error });
		} finally {
			socket.destroy();
		}
	}

	private capsuleDirectory(missionId: string): string {
		return join(this.#rootDirectory, uuidSchema.parse(missionId));
	}
}

export function createDetachedCapsuleLauncher(command: CapsuleProcessCommand): CapsuleLauncher {
	if (!isAbsolute(command.executable) || normalize(command.executable) !== command.executable) {
		throw new Error("Capsule executable path must be absolute and normalized");
	}
	if (command.args.some((argument) => argument.includes("\0"))) {
		throw new Error("Capsule process arguments cannot contain NUL");
	}
	return {
		start(capsuleDirectory: string): Promise<void> {
			return new Promise((resolve, reject) => {
				const child = spawn(
					command.executable,
					[...command.args, "serve", "--directory", capsuleDirectory],
					{
						cwd: capsuleDirectory,
						detached: true,
						stdio: "ignore",
						env: buildCapsuleEnvironment(),
					},
				);
				child.once("error", reject);
				child.once("spawn", () => {
					child.removeListener("error", reject);
					child.unref();
					resolve();
				});
			});
		},
	};
}

/** Explicit allowlist prevents Node/Relay credentials and unrelated owner secrets from inheriting. */
export function buildCapsuleEnvironment(
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return buildBaseCapsuleEnvironment(source);
}

function sessionFromGrant(grant: RuntimeAuthorityGrant): SessionInput {
	return sessionInputSchema.parse({
		missionId: grant.mission_id,
		participantId: grant.agent_id,
		workspaceAlias: grant.workspace_alias,
	});
}

function assertGrantSession(grant: RuntimeAuthorityGrant, session: SessionInput): void {
	if (
		session.missionId !== grant.mission_id ||
		session.participantId !== grant.agent_id ||
		session.workspaceAlias !== grant.workspace_alias
	) {
		throw authorityDenied("Runtime session does not match its local authority");
	}
}

function assertCurrentLeaseMatchesGrant(
	grant: RuntimeAuthorityGrant,
	currentLease: RuntimeAuthorityRenewal,
): void {
	if (
		currentLease.grant_id !== grant.grant_id ||
		currentLease.lease_id !== grant.lease_id ||
		currentLease.fencing_token !== grant.fencing_token
	) {
		throw authorityDenied("Runtime authority current lease does not match its grant");
	}
	assertLeaseDoesNotRegress(currentLeaseFromGrant(grant), currentLease);
}

function assertLeaseDoesNotRegress(
	current: RuntimeAuthorityRenewal,
	next: RuntimeAuthorityRenewal,
): void {
	if (Date.parse(next.lease_expires_at) < Date.parse(current.lease_expires_at)) {
		throw authorityDenied("Runtime authority current lease cannot move backwards");
	}
}

function currentLeaseFromGrant(grant: RuntimeAuthorityGrant): RuntimeAuthorityRenewal {
	return {
		grant_id: grant.grant_id,
		lease_id: grant.lease_id,
		fencing_token: grant.fencing_token,
		lease_expires_at: grant.lease_expires_at,
	};
}

function authorityDenied(message: string): CapsuleRpcError {
	return new CapsuleRpcError("authority_denied", message);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const stats = await lstat(directory);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`Capsule directory must be a real directory: ${directory}`);
	}
	if ((stats.mode & 0o777) !== 0o700) {
		throw new Error(`Capsule directory must have mode 0700: ${directory}`);
	}
}

async function assertPrivateSocket(path: string): Promise<void> {
	let stats: Stats;
	try {
		stats = await lstat(path);
	} catch (error) {
		throw new CapsuleRpcError("transport", `Capsule socket is unavailable: ${path}`, {
			cause: error,
		});
	}
	if (!stats.isSocket() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600) {
		throw new CapsuleRpcError("transport", `Capsule socket is not a private Unix socket: ${path}`);
	}
}

async function readPrivateSocketIdentity(path: string): Promise<SocketIdentity | null> {
	let stats: Stats;
	try {
		stats = await lstat(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw new CapsuleRpcError("transport", `Capsule socket is unavailable: ${path}`, {
			cause: error,
		});
	}
	if (!stats.isSocket() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600) {
		throw new CapsuleRpcError("transport", `Capsule socket is not a private Unix socket: ${path}`);
	}
	return { dev: stats.dev, ino: stats.ino };
}

async function removeUnchangedSocket(
	path: string,
	expected: SocketIdentity,
): Promise<"launch" | "retry"> {
	const quarantinePath = join(dirname(path), `.stale-${randomUUID()}.sock`);
	// Rename first so an inode replaced after the last lstat is inspected under a
	// private name instead of being unlinked by mistake.
	try {
		await rename(path, quarantinePath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return "launch";
		throw error;
	}

	const movedStats = await lstat(quarantinePath);
	const moved = { dev: movedStats.dev, ino: movedStats.ino };
	if (
		movedStats.isSocket() &&
		!movedStats.isSymbolicLink() &&
		(movedStats.mode & 0o777) === 0o600 &&
		sameSocketIdentity(moved, expected)
	) {
		await unlink(quarantinePath);
		await syncDirectory(dirname(path));
		return "launch";
	}

	try {
		await link(quarantinePath, path);
	} catch (error) {
		if (errorCode(error) === "EEXIST") {
			throw new CapsuleRpcError(
				"transport",
				"Capsule socket changed during stale recovery; preserved the changed inode",
				{ cause: error },
			);
		}
		throw error;
	}
	await unlink(quarantinePath);
	await syncDirectory(dirname(path));
	return "retry";
}

function sameSocketIdentity(left: SocketIdentity, right: SocketIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function connect(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new CapsuleRpcError("transport", `Timed out connecting to Mission capsule: ${path}`));
		}, CAPSULE_CONNECT_TIMEOUT_MS);
		socket.once("connect", () => {
			clearTimeout(timeout);
			resolve(socket);
		});
		socket.once("error", (error) => {
			clearTimeout(timeout);
			socket.destroy();
			reject(
				new CapsuleRpcError("transport", `Cannot connect to Mission capsule: ${path}`, {
					cause: error,
				}),
			);
		});
	});
}

async function* readResponseLines(socket: Socket): AsyncIterable<string> {
	socket.setEncoding("utf8");
	let pending = "";
	for await (const chunk of socket) {
		pending += chunk;
		let newline = pending.indexOf("\n");
		while (newline >= 0) {
			const line = pending.slice(0, newline);
			if (Buffer.byteLength(line, "utf8") > MAX_CAPSULE_RESPONSE_FRAME_BYTES) {
				throw new CapsuleRpcError("transport", "Capsule response frame exceeds the byte limit");
			}
			yield line;
			pending = pending.slice(newline + 1);
			newline = pending.indexOf("\n");
		}
		if (Buffer.byteLength(pending, "utf8") > MAX_CAPSULE_RESPONSE_FRAME_BYTES) {
			throw new CapsuleRpcError("transport", "Capsule response frame exceeds the byte limit");
		}
	}
	if (pending.length > 0) {
		throw new CapsuleRpcError("transport", "Capsule response ended with an incomplete frame");
	}
}

async function readSecureJsonIfPresent(path: string): Promise<unknown | null> {
	let handle: FileHandle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new Error(`Capsule file is not regular: ${path}`);
		if ((stats.mode & 0o777) !== 0o600)
			throw new Error(`Capsule file must have mode 0600: ${path}`);
		return JSON.parse(await handle.readFile("utf8"));
	} finally {
		await handle.close();
	}
}

function validateRootDirectory(path: string): string {
	if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0")) {
		throw new Error("Capsule root must be an absolute normalized path without NUL");
	}
	return path;
}

function validateRegistry(registry: CapsuleRegistry): void {
	for (const [key, record] of Object.entries(registry.executions)) {
		if (key !== executionKey(record.delivery_id, record.execution_attempt)) {
			throw new Error("Capsule execution registry contains a mismatched key");
		}
	}
}

function isUnavailableTransport(error: unknown): boolean {
	if (!isTransportError(error)) return false;
	const cause = error.cause;
	return (
		errorCode(cause) === "ENOENT" ||
		errorCode(cause) === "ECONNREFUSED" ||
		(error.message.startsWith("Capsule socket is unavailable") && errorCode(cause) === "ENOENT")
	);
}

function isConnectionRefusedTransport(error: unknown): boolean {
	return isTransportError(error) && errorCode(error.cause) === "ECONNREFUSED";
}

function isTransportError(error: unknown): error is CapsuleRpcError {
	return error instanceof CapsuleRpcError && error.code === "transport";
}

function isAuthorityNotInstalled(error: unknown): boolean {
	return (
		error instanceof CapsuleRpcError &&
		error.code === "authority_denied" &&
		error.message === "Runtime authority is not installed"
	);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}

function isMissingCapsuleDescriptor(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.startsWith("Cannot open capsule file:") &&
		errorCode(error.cause) === "ENOENT"
	);
}
