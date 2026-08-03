import type { AgentHostAdapter } from "@agentrelay/protocol";

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
	/** Called only after this process has exclusively published the Capsule socket. */
	readonly openRuntime: (lifecycle: CapsuleRuntimeLifecycle) => Promise<CapsuleRuntime>;
}
