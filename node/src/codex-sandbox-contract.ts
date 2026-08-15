import type { CodexProcessBoundary } from "./codex-process-boundary.js";
import type { PreparedMissionWorkspace } from "./mission-workspace.js";
import type { RuntimeContainmentEvidence } from "./runtime-containment-manifest.js";

export const CODEX_SANDBOX_PROFILE_NAME = "agentrelay-runtime";
export const CODEX_SANDBOX_CONFIG_FILE = "config.toml";
export const CODEX_SANDBOX_MANIFEST_FILE = "containment.json";

export type ContainmentOpenMode = "create" | "recover";

export interface PinnedExecutable {
	readonly executable: string;
	readonly readRoot: string;
	readonly sha256: string;
}

export interface PinnedCodexLauncher extends PinnedExecutable {
	readonly sandboxHelper: PinnedExecutable;
}

export interface CodexSandboxContainmentInput {
	readonly controlDirectory: string;
	readonly runtimeDirectory: string;
	readonly workspace: PreparedMissionWorkspace;
	readonly launcher: PinnedCodexLauncher;
	readonly provider: PinnedExecutable;
	readonly readOnlyRoots?: readonly string[];
	readonly forbiddenRoots?: readonly string[];
	readonly policyGrantSha256: string;
}

export interface CodexSandboxContainment {
	readonly boundary: CodexProcessBoundary;
	readonly evidence: RuntimeContainmentEvidence;
	/** Local authority that the Node must persist before relying on crash recovery. */
	readonly recovery: CodexSandboxRecoveryExpectation;
	readonly runtimeHome: string;
	readonly runtimeTmp: string;
}

export interface CodexSandboxRecoveryExpectation {
	readonly manifestPath: string;
	readonly instanceId: string;
	readonly bindingSha256: string;
}

export interface ContainmentLayout {
	readonly controlRoot: string;
	readonly launcherHome: string;
	readonly launcherPath: string;
	readonly runtimeRoot: string;
	readonly runtimeHome: string;
	readonly runtimeTmp: string;
	readonly manifestPath: string;
}
