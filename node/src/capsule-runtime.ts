import type {
	AdapterInfo,
	AgentHostAdapter,
	HostSessionRef,
	HostTurnRef,
	SessionInput,
} from "@agentrelay/protocol";
import type {
	RuntimeAuthorityEvidenceSink,
	RuntimeWorkspaceReadAuthority,
} from "./runtime-authority.js";

/**
 * Mission-scoped runtime hosted behind the private Capsule wire.
 *
 * Closing a runtime stops owned background work and processes but must preserve
 * durable state for a later Capsule generation.
 */
export interface CapsuleRuntime extends AgentHostAdapter {
	/**
	 * Abort and fence every admitted operation before resolving. The server may
	 * call this while a socket handler is still inside another runtime method.
	 */
	close(): Promise<void>;
}

/** Installed Capsule authority under which a provider runtime may be activated. */
export type CapsuleRuntimeActivation = RuntimeWorkspaceReadAuthority;

/**
 * Passive Mission-scoped state opened after exclusive socket publication.
 *
 * `probe` and `lookupTurn` must not activate a provider or mutate the workspace.
 * `close` must fence an in-flight activation and close an activated runtime.
 */
export interface CapsuleRuntimeController {
	probe(): Promise<AdapterInfo>;
	/** Establishes only the durable local session identity; it must not activate a provider. */
	ensureSession(input: SessionInput): Promise<HostSessionRef>;
	lookupTurn(deliveryId: string, executionAttempt: number): Promise<HostTurnRef | null>;
	activate(authority: CapsuleRuntimeActivation): Promise<CapsuleRuntime>;
	close(): Promise<void>;
}

export interface CapsuleRuntimeLifecycle {
	/** Retire this runtime generation without exposing its private failure. */
	retire(): void;
}

export interface CapsuleServerIdentity {
	readonly capsuleId: string;
	readonly capabilityToken: string;
	readonly socketPath: string;
}

export interface PersistentCapsuleServerOptions {
	readonly identity: CapsuleServerIdentity;
	/** Receives only bounded, redacted authority decisions; raw peer content is never included. */
	readonly authorityEvidenceSink?: RuntimeAuthorityEvidenceSink;
	/** Called only after this process has exclusively published the Capsule socket. */
	readonly openController: (
		lifecycle: CapsuleRuntimeLifecycle,
	) => Promise<CapsuleRuntimeController>;
}
