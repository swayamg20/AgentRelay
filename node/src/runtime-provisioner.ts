import type { SessionInput } from "@agentrelay/protocol";
import type { PreparedMissionWorkspace } from "./mission-workspace.js";
import type { RuntimeWorkspaceAuthority } from "./runtime-authority.js";

export type RuntimeWorkspaceAccess = "read" | "write";

export interface RuntimeProvisioningInput {
	readonly session: SessionInput;
	readonly workspace: PreparedMissionWorkspace;
	readonly policyGrantSha256: string;
	readonly workspaceAccess: RuntimeWorkspaceAccess;
}

/** Establishes durable runtime launch state without selecting how the runtime is hosted. */
export interface RuntimeProvisioner {
	provision(
		input: RuntimeProvisioningInput,
		authority: RuntimeWorkspaceAuthority,
	): Promise<unknown>;
	/** Reopens exact durable runtime state and must never create or repair it. */
	recover(input: RuntimeProvisioningInput, authority: RuntimeWorkspaceAuthority): Promise<unknown>;
}
