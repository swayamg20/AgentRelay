import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import type { PinnedOwnerGitExecutable } from "./codex-git-artifact.js";
import type { CodexProcessBoundary } from "./codex-process-boundary.js";
import type { LocalFilesystemIdentity } from "./mission-workspace.js";
import type { PreparedMissionWorkspace } from "./mission-workspace.js";
import type { RuntimeContainmentEvidence } from "./runtime-containment-manifest.js";

export const CODEX_SANDBOX_PROFILE_NAME = "agentrelay-runtime";
export const CODEX_SANDBOX_OFFLINE_PROFILE_NAME = "agentrelay-offline";
export const CODEX_SANDBOX_CONFIG_FILE = "config.toml";
export const CODEX_SANDBOX_MANIFEST_FILE = "containment.json";

export type ContainmentOpenMode = "create" | "recover";
export type CodexWorkspaceAccess = "read" | "write";

/** The owner could not prove that a containment child process group is gone. */
export class CodexContainmentTerminationError extends Error {
	constructor(options: ErrorOptions = {}) {
		super("Codex containment process group termination could not be proven", options);
		this.name = "CodexContainmentTerminationError";
	}
}

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
	readonly workspaceMediator?: Readonly<{
		/** Canonical private Node state shared by every write-capable Capsule. */
		globalControlRoot: string;
		git: PinnedOwnerGitExecutable;
	}>;
	readonly readOnlyRoots?: readonly string[];
	readonly forbiddenRoots?: readonly string[];
	readonly policyGrantSha256: string;
	/** Logical grant used by the trusted mediator; the provider mount is always read-only. */
	readonly workspaceAccess: CodexWorkspaceAccess;
}

export interface CodexSandboxContainment {
	readonly boundary: CodexProcessBoundary;
	readonly evidence: RuntimeContainmentEvidence;
	/** Trusted fields recovered from the exact validated manifest binding. */
	readonly authorization: CodexSandboxAuthorization;
	/** Local authority that the Node must persist before relying on crash recovery. */
	readonly recovery: CodexSandboxRecoveryExpectation;
	readonly runtimeHome: string;
	readonly runtimeTmp: string;
}

export interface CodexSandboxAuthorization {
	readonly controlDirectory: string;
	readonly runtimeDirectory: string;
	readonly providerExecutable: string;
	readonly runtimeVersion: RuntimeContainmentEvidence["runtimeVersion"];
	readonly policyGrantSha256: string;
	readonly logicalWorkspaceAccess: CodexWorkspaceAccess;
	readonly providerWorkspaceAccess: "read";
	readonly workspaceMediator: Readonly<{
		globalControlRoot: Readonly<{
			path: string;
			identity: LocalFilesystemIdentity;
		}>;
		git: PinnedOwnerGitExecutable;
	}> | null;
	readonly workspace: Readonly<{
		root: string;
		repositoryUrl: string;
		headCommit: string;
		reachableFromRef: string;
	}>;
}

export const codexSandboxRecoveryExpectationSchema = z
	.object({
		manifestPath: z
			.string()
			.min(1)
			.max(4_096)
			.refine((value) => !value.includes("\0"), "Path cannot contain NUL")
			.refine((value) => isAbsolute(value), "Path must be absolute")
			.refine((value) => normalize(value) === value, "Path must be normalized"),
		instanceId: z.string().uuid(),
		bindingSha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();

export type CodexSandboxRecoveryExpectation = Readonly<
	z.infer<typeof codexSandboxRecoveryExpectationSchema>
>;

export interface ContainmentLayout {
	readonly controlRoot: string;
	readonly launcherHome: string;
	readonly launcherPath: string;
	readonly stagedProbeRoot: string;
	readonly stagedProbeExecutable: string;
	readonly runtimeRoot: string;
	readonly runtimeHome: string;
	readonly runtimeTmp: string;
	readonly manifestPath: string;
}
