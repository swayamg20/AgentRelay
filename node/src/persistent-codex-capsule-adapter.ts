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
import {
	type CodexCapsuleLaunchDescriptor,
	readCodexCapsuleLaunchDescriptor,
} from "./capsule-launch-descriptor.js";
import { CODEX_CAPSULE_ADAPTER_INFO } from "./codex-capsule-runner-contract.js";
import {
	type CapsuleDescriptorSelection,
	type CapsuleLauncher,
	CapsuleRpcError,
	PersistentCapsuleAdapter,
} from "./persistent-capsule-adapter-core.js";
import type { RuntimeAuthorityPort } from "./runtime-authority-port.js";
import type {
	RuntimeAuthorityDenyCode,
	RuntimeAuthorityGrant,
	RuntimeAuthorityRenewal,
	RuntimeAuthorityRequest,
} from "./runtime-authority.js";

export interface PersistentCodexCapsuleAdapterOptions {
	readonly rootDirectory: string;
	readonly launcher: CapsuleLauncher;
	readonly startupTimeoutMs?: number;
}

/** Node-side adapter for Codex Capsules already provisioned under local authority. */
export class PersistentCodexCapsuleAdapter implements AgentHostAdapter, RuntimeAuthorityPort {
	readonly #adapter: PersistentCapsuleAdapter<CodexCapsuleLaunchDescriptor>;

	private constructor(adapter: PersistentCapsuleAdapter<CodexCapsuleLaunchDescriptor>) {
		this.#adapter = adapter;
	}

	static async open(
		options: PersistentCodexCapsuleAdapterOptions,
	): Promise<PersistentCodexCapsuleAdapter> {
		return new PersistentCodexCapsuleAdapter(
			await PersistentCapsuleAdapter.open({
				...options,
				selection: CODEX_DESCRIPTOR_SELECTION,
			}),
		);
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

const CODEX_DESCRIPTOR_SELECTION: CapsuleDescriptorSelection<CodexCapsuleLaunchDescriptor> = {
	adapterInfo: CODEX_CAPSULE_ADAPTER_INFO,
	resolveForInstall: readCodexCapsuleLaunchDescriptor,
	readPersisted: readCodexCapsuleLaunchDescriptor,
	assertCompatible(descriptor, input) {
		if (!isDeepStrictEqual(descriptor.session, input)) {
			throw new CapsuleRpcError(
				"scope_mismatch",
				"Mission capsule cannot be reused across participant or workspace scope",
			);
		}
	},
};
