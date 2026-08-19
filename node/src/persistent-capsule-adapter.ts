import { randomBytes, randomUUID } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
	AdapterInfo,
	AgentHostAdapter,
	HostEvent,
	HostSessionRef,
	HostTurnRef,
	SessionInput,
	StartTurnInput,
} from "@agentrelay/protocol";
import { z } from "zod";
import {
	CAPSULE_DESCRIPTOR_FILE,
	type FakeCapsuleLaunchDescriptor,
	type FakeCapsuleOutcome,
	capsuleSocketPath,
	fakeCapsuleLaunchDescriptorSchema,
	fakeCapsuleOutcomeSchema,
	readFakeCapsuleLaunchDescriptor,
} from "./capsule-launch-descriptor.js";
import { CAPSULE_ADAPTER_INFO } from "./capsule-protocol.js";
import { writeDurableJson } from "./durable-file.js";
import {
	type CapsuleDescriptorSelection,
	type CapsuleLauncher,
	CapsuleRpcError,
	PersistentCapsuleAdapter,
	ensurePersistentCapsuleDirectory,
	readPersistentCapsuleJsonIfPresent,
} from "./persistent-capsule-adapter-core.js";
import type { RuntimeAuthorityPort } from "./runtime-authority-port.js";
import type {
	RuntimeAuthorityDenyCode,
	RuntimeAuthorityGrant,
	RuntimeAuthorityRenewal,
	RuntimeAuthorityRequest,
} from "./runtime-authority.js";

export {
	CapsuleRpcError,
	buildCapsuleEnvironment,
	createDetachedCapsuleLauncher,
} from "./persistent-capsule-adapter-core.js";
export type {
	CapsuleLauncher,
	CapsuleProcessCommand,
} from "./persistent-capsule-adapter-core.js";

export interface PersistentFakeCapsuleAdapterOptions {
	readonly rootDirectory: string;
	readonly launcher: CapsuleLauncher;
	readonly outcome?: FakeCapsuleOutcome;
	readonly completionDelayMs?: number;
	readonly startupTimeoutMs?: number;
}

/** Node-side adapter for independently persistent, one-Mission fake capsule processes. */
export class PersistentFakeCapsuleAdapter implements AgentHostAdapter, RuntimeAuthorityPort {
	readonly #adapter: PersistentCapsuleAdapter<FakeCapsuleLaunchDescriptor>;

	private constructor(adapter: PersistentCapsuleAdapter<FakeCapsuleLaunchDescriptor>) {
		this.#adapter = adapter;
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
		const adapter = await PersistentCapsuleAdapter.open({
			rootDirectory,
			launcher: options.launcher,
			startupTimeoutMs: options.startupTimeoutMs,
			selection: fakeDescriptorSelection(outcome, completionDelayMs),
		});
		return new PersistentFakeCapsuleAdapter(adapter);
	}

	probe(): Promise<AdapterInfo> {
		return this.#adapter.probe();
	}

	installAuthority(
		grant: RuntimeAuthorityGrant,
		currentLease: RuntimeAuthorityRenewal,
	): Promise<void> {
		return this.#adapter.installAuthority(grant, currentLease);
	}

	renewAuthority(missionId: string, renewal: RuntimeAuthorityRenewal): Promise<void> {
		return this.#adapter.renewAuthority(missionId, renewal);
	}

	assertAuthority(request: RuntimeAuthorityRequest): Promise<void> {
		return this.#adapter.assertAuthority(request);
	}

	revokeAuthority(grant: RuntimeAuthorityGrant, reason: RuntimeAuthorityDenyCode): Promise<void> {
		return this.#adapter.revokeAuthority(grant, reason);
	}

	ensureSession(input: SessionInput): Promise<HostSessionRef> {
		return this.#adapter.ensureSession(input);
	}

	lookupTurn(deliveryId: string, executionAttempt: number): Promise<HostTurnRef | null> {
		return this.#adapter.lookupTurn(deliveryId, executionAttempt);
	}

	startTurn(input: StartTurnInput): AsyncIterable<HostEvent> {
		return this.#adapter.startTurn(input);
	}

	recoverTurn(ref: HostTurnRef, expectedInput: StartTurnInput): AsyncIterable<HostEvent> {
		return this.#adapter.recoverTurn(ref, expectedInput);
	}

	cancelTurn(ref: HostTurnRef): Promise<void> {
		return this.#adapter.cancelTurn(ref);
	}

	/** Test/operator cleanup only. Normal Node shutdown intentionally leaves capsules alive. */
	terminateAll(): Promise<void> {
		return this.#adapter.terminateAll();
	}
}

function fakeDescriptorSelection(
	outcome: FakeCapsuleOutcome,
	completionDelayMs: number,
): CapsuleDescriptorSelection<FakeCapsuleLaunchDescriptor> {
	return {
		adapterInfo: CAPSULE_ADAPTER_INFO,
		async resolveForInstall(directory, input) {
			await ensurePersistentCapsuleDirectory(directory);
			const descriptorPath = join(directory, CAPSULE_DESCRIPTOR_FILE);
			if ((await readPersistentCapsuleJsonIfPresent(descriptorPath)) !== null) {
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
					outcome,
					completion_delay_ms: completionDelayMs,
				},
			});
			await writeDurableJson(descriptorPath, descriptor, {
				fileMode: 0o600,
				directoryMode: 0o700,
			});
			return descriptor;
		},
		readPersisted: readFakeCapsuleLaunchDescriptor,
		assertCompatible(descriptor, input) {
			if (!isDeepStrictEqual(descriptor.session, input)) {
				throw new CapsuleRpcError(
					"scope_mismatch",
					"Mission capsule cannot be reused across participant or workspace scope",
				);
			}
			if (
				descriptor.runtime.outcome !== outcome ||
				descriptor.runtime.completion_delay_ms !== completionDelayMs
			) {
				throw new CapsuleRpcError(
					"correlation_conflict",
					"Existing Mission capsule runtime configuration does not match this Node",
				);
			}
		},
	};
}

function validateRootDirectory(path: string): string {
	if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0")) {
		throw new Error("Capsule root must be an absolute normalized path without NUL");
	}
	return path;
}
