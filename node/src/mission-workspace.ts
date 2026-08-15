import { realpath as fsRealpath, lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceConfig } from "./config.js";
import {
	type MissionWorkspaceExpectation,
	type WorkspaceCommandRunner,
	defaultWorkspaceCommandRunner,
	preflightWorkspace,
} from "./workspace.js";

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
	readonly clean: true;
}

export interface MissionWorkspaceDependencies {
	readonly runCommand?: WorkspaceCommandRunner;
	readonly realpath?: (path: string) => Promise<string>;
}

/**
 * Validates an owner-prepared standalone checkout. Linked worktrees are rejected because their
 * Git control directory reaches back into another checkout outside the Mission boundary.
 */
export async function prepareMissionWorkspace(
	workspace: WorkspaceConfig,
	expectation: MissionWorkspaceExpectation,
	dependencies: MissionWorkspaceDependencies = {},
): Promise<PreparedMissionWorkspace> {
	if (process.platform === "win32" || process.getuid === undefined) {
		throw new MissionWorkspaceError(
			"unsupported_platform",
			"Mission workspace identity currently requires a Unix owner boundary",
		);
	}

	const runCommand = dependencies.runCommand ?? defaultWorkspaceCommandRunner;
	const realpath = dependencies.realpath ?? fsRealpath;
	const preflight = await preflightWorkspace(workspace, expectation, { runCommand, realpath });
	const rootStats = await ownedDirectoryIdentity(preflight.root, "workspace root");

	const expectedGitDirectory = join(preflight.root, ".git");
	const gitEntry = await lstat(expectedGitDirectory).catch(() => null);
	if (gitEntry === null || !gitEntry.isDirectory() || gitEntry.isSymbolicLink()) {
		throw new MissionWorkspaceError(
			"git_metadata_not_isolated",
			"Mission workspace must use a real, checkout-local .git directory",
		);
	}

	const gitDirectory = await canonicalGitPath(
		runCommand,
		preflight.root,
		["rev-parse", "--absolute-git-dir"],
		realpath,
	);
	const commonDirectory = await canonicalGitPath(
		runCommand,
		preflight.root,
		["rev-parse", "--path-format=absolute", "--git-common-dir"],
		realpath,
	);
	if (gitDirectory !== expectedGitDirectory || commonDirectory !== expectedGitDirectory) {
		throw new MissionWorkspaceError(
			"git_metadata_not_isolated",
			"Mission workspace Git metadata must be fully contained in its own checkout",
		);
	}

	const gitStats = await ownedDirectoryIdentity(gitDirectory, "workspace Git directory");
	const prepared = Object.freeze({
		repositoryUrl: preflight.repository_url,
		baseCommit: preflight.head_commit,
		root: preflight.root,
		gitDirectory,
		rootIdentity: rootStats,
		gitIdentity: gitStats,
		reachableFromRef: preflight.reachable_from_ref,
		clean: true,
	});
	await revalidateMissionWorkspaceIsolation(prepared, { runCommand, realpath });
	return prepared;
}

/**
 * Revalidates the durable workspace identity without requiring a clean worktree. Mission edits are
 * expected after first admission, but new storage aliases or repository-identity changes are not.
 */
export async function revalidateMissionWorkspaceIsolation(
	workspace: PreparedMissionWorkspace,
	dependencies: MissionWorkspaceDependencies = {},
): Promise<void> {
	const runCommand = dependencies.runCommand ?? defaultWorkspaceCommandRunner;
	const realpath = dependencies.realpath ?? fsRealpath;
	const rootIdentity = await ownedDirectoryIdentity(workspace.root, "workspace root");
	assertSameIdentity(rootIdentity, workspace.rootIdentity, "Mission workspace root changed");

	const expectedGitDirectory = join(workspace.root, ".git");
	const gitEntry = await lstat(expectedGitDirectory).catch(() => null);
	if (gitEntry === null || !gitEntry.isDirectory() || gitEntry.isSymbolicLink()) {
		throw new MissionWorkspaceError(
			"git_metadata_not_isolated",
			"Mission workspace must use a real, checkout-local .git directory",
		);
	}
	const gitDirectory = await canonicalGitPath(
		runCommand,
		workspace.root,
		["rev-parse", "--absolute-git-dir"],
		realpath,
	);
	const commonDirectory = await canonicalGitPath(
		runCommand,
		workspace.root,
		["rev-parse", "--path-format=absolute", "--git-common-dir"],
		realpath,
	);
	if (
		gitDirectory !== workspace.gitDirectory ||
		commonDirectory !== workspace.gitDirectory ||
		gitDirectory !== expectedGitDirectory
	) {
		throw new MissionWorkspaceError(
			"git_metadata_not_isolated",
			"Mission workspace Git metadata changed or escaped its checkout",
		);
	}
	const gitIdentity = await ownedDirectoryIdentity(gitDirectory, "workspace Git directory");
	assertSameIdentity(gitIdentity, workspace.gitIdentity, "Mission workspace Git directory changed");

	const repositoryUrl = await singleGitLine(runCommand, workspace.root, [
		"remote",
		"get-url",
		"origin",
	]);
	const baseCommit = await singleGitLine(runCommand, workspace.root, [
		"rev-parse",
		"--verify",
		"HEAD^{commit}",
	]);
	if (repositoryUrl !== workspace.repositoryUrl || baseCommit !== workspace.baseCommit) {
		throw new MissionWorkspaceError(
			"workspace_identity_changed",
			"Mission workspace repository identity changed after admission",
		);
	}

	await rejectAlternates(gitDirectory);
	await inspectWritableWorkspaceTree(workspace.root, workspace.rootIdentity.device);
}

async function inspectWritableWorkspaceTree(root: string, rootDevice: string): Promise<void> {
	const pending = [root];
	while (pending.length > 0) {
		const directory = pending.pop();
		if (directory === undefined) break;
		const entries = await opendir(directory);
		for await (const entry of entries) {
			if (directory === root && entry.name === ".git") continue;
			const path = join(directory, entry.name);
			const stats = await lstat(path, { bigint: true });
			if (stats.dev.toString() !== rootDevice) {
				throw new MissionWorkspaceError(
					"workspace_mounts_unsupported",
					"Mission workspace cannot contain another filesystem",
				);
			}
			if (stats.isDirectory()) {
				pending.push(path);
				continue;
			}
			if (stats.isSymbolicLink()) continue;
			if (!stats.isFile()) {
				throw new MissionWorkspaceError(
					"workspace_special_files_unsupported",
					"Mission workspace cannot contain device, socket, or pipe entries",
				);
			}
			if (stats.nlink > 1n) {
				throw new MissionWorkspaceError(
					"workspace_hardlinks_unsupported",
					"Mission workspace files cannot share storage with another path",
				);
			}
		}
	}
}

async function singleGitLine(
	runCommand: WorkspaceCommandRunner,
	cwd: string,
	argv: readonly string[],
): Promise<string> {
	const result = await runCommand({ file: "git", argv, cwd, shell: false });
	if (result.exitCode !== 0) {
		throw new MissionWorkspaceError("git_command_failed", "Git identity inspection failed", {
			argv: [...argv],
			exit_code: result.exitCode,
		});
	}
	const value = result.stdout.replace(/\r?\n$/, "");
	if (value.length === 0 || value.includes("\n") || value.includes("\r")) {
		throw new MissionWorkspaceError("git_command_failed", "Git returned invalid identity output");
	}
	return value;
}

function assertSameIdentity(
	actual: LocalFilesystemIdentity,
	expected: LocalFilesystemIdentity,
	message: string,
): void {
	if (actual.device !== expected.device || actual.inode !== expected.inode) {
		throw new MissionWorkspaceError("workspace_identity_changed", message);
	}
}

async function canonicalGitPath(
	runCommand: WorkspaceCommandRunner,
	cwd: string,
	argv: readonly string[],
	realpath: (path: string) => Promise<string>,
): Promise<string> {
	const result = await runCommand({ file: "git", argv, cwd, shell: false });
	if (result.exitCode !== 0) {
		throw new MissionWorkspaceError("git_command_failed", "Git metadata inspection failed", {
			argv: [...argv],
			exit_code: result.exitCode,
		});
	}
	const value = result.stdout.replace(/\r?\n$/, "");
	if (value.length === 0 || value.includes("\n") || value.includes("\r")) {
		throw new MissionWorkspaceError("git_command_failed", "Git returned an invalid metadata path");
	}
	return realpath(value);
}

async function ownedDirectoryIdentity(
	path: string,
	label: string,
): Promise<LocalFilesystemIdentity> {
	const currentUid = process.getuid?.();
	if (currentUid === undefined) {
		throw new MissionWorkspaceError(
			"unsupported_platform",
			"Mission workspace ownership inspection requires Unix",
		);
	}
	const stats = await lstat(path, { bigint: true });
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new MissionWorkspaceError(
			"git_metadata_not_isolated",
			`${label} must be a real directory`,
		);
	}
	if (stats.uid !== BigInt(currentUid)) {
		throw new MissionWorkspaceError("workspace_not_owned", `${label} must be owner-controlled`);
	}
	if ((stats.mode & 0o22n) !== 0n) {
		throw new MissionWorkspaceError(
			"workspace_permissions_unsafe",
			`${label} cannot be group- or world-writable`,
		);
	}
	return Object.freeze({ device: stats.dev.toString(), inode: stats.ino.toString() });
}

async function rejectAlternates(gitDirectory: string): Promise<void> {
	const alternatesPath = join(gitDirectory, "objects", "info", "alternates");
	const stats = await lstat(alternatesPath).catch((error: unknown) => {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	});
	if (stats !== null) {
		throw new MissionWorkspaceError(
			"git_alternates_unsupported",
			"Mission workspace cannot borrow Git objects from another repository",
		);
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
