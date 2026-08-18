import type { SessionInput } from "@agentrelay/protocol";
import type { PreparedMissionWorkspace } from "./mission-workspace.js";
import type { RuntimeWorkspaceReadAuthority } from "./runtime-authority.js";

export interface RuntimeProvisioningInput {
	readonly session: SessionInput;
	readonly workspace: PreparedMissionWorkspace;
	readonly policyGrantSha256: string;
}

/** Establishes durable runtime launch state without selecting how the runtime is hosted. */
export interface RuntimeProvisioner {
	provision(
		input: RuntimeProvisioningInput,
		authority: RuntimeWorkspaceReadAuthority,
	): Promise<unknown>;
}
