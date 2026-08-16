import type { WorkspaceCommandRunner } from "./workspace.js";

export type MissionWorkspaceErrorCode =
	| "unsupported_platform"
	| "workspace_not_owned"
	| "workspace_permissions_unsafe"
	| "git_metadata_not_isolated"
	| "git_alternates_unsupported"
	| "workspace_hardlinks_unsupported"
	| "workspace_mounts_unsupported"
	| "workspace_special_files_unsupported"
	| "workspace_identity_changed"
	| "workspace_dirty"
	| "git_command_failed";

export class MissionWorkspaceError extends Error {
	constructor(
		readonly code: MissionWorkspaceErrorCode,
		message: string,
		readonly details: Readonly<Record<string, unknown>> = {},
	) {
		super(message);
		this.name = "MissionWorkspaceError";
	}
}

export interface LocalFilesystemIdentity {
	readonly device: string;
	readonly inode: string;
}

export interface PreparedMissionWorkspace {
	readonly repositoryUrl: string;
	readonly baseCommit: string;
	readonly root: string;
	readonly gitDirectory: string;
	readonly rootIdentity: LocalFilesystemIdentity;
	readonly gitIdentity: LocalFilesystemIdentity;
	readonly reachableFromRef: string;
}

export interface MissionWorkspaceDependencies {
	readonly runCommand?: WorkspaceCommandRunner;
	readonly realpath?: (path: string) => Promise<string>;
}
