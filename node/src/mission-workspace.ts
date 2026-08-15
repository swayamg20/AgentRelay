import { realpath as fsRealpath, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceConfig } from "./config.js";
import {
	type LocalFilesystemIdentity,
	type MissionWorkspaceDependencies,
	MissionWorkspaceError,
	type PreparedMissionWorkspace,
} from "./mission-workspace-contract.js";
import {
	assertMissionWorkspaceStorageIsolated,
	assertOwnedDirectoryIdentity,
} from "./mission-workspace-storage.js";
import {
	type MissionWorkspaceExpectation,
	type WorkspaceCommandRunner,
	defaultWorkspaceCommandRunner,
	preflightWorkspace,
} from "./workspace.js";

export {
	MissionWorkspaceError,
	type LocalFilesystemIdentity,
	type MissionWorkspaceDependencies,
	type MissionWorkspaceErrorCode,
	type PreparedMissionWorkspace,
} from "./mission-workspace-contract.js";

/** Validates one owner-prepared standalone checkout at the frozen Mission base. */
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
	const rootIdentity = await assertOwnedDirectoryIdentity(preflight.root, "workspace root");
	const gitDirectory = await inspectStandaloneGitDirectory(preflight.root, runCommand, realpath);
	const gitIdentity = await assertOwnedDirectoryIdentity(gitDirectory, "workspace Git directory");
	const prepared = Object.freeze({
		repositoryUrl: preflight.repository_url,
		baseCommit: preflight.head_commit,
		root: preflight.root,
		gitDirectory,
		rootIdentity,
		gitIdentity,
		reachableFromRef: preflight.reachable_from_ref,
	});
	await revalidateMissionWorkspaceIsolation(prepared, { runCommand, realpath });
	await assertMissionWorkspaceClean(prepared, { runCommand });
	return prepared;
}

/** Revalidates durable identity while permitting expected dirty Mission edits. */
export async function revalidateMissionWorkspaceIsolation(
	workspace: PreparedMissionWorkspace,
	dependencies: MissionWorkspaceDependencies = {},
): Promise<void> {
	const runCommand = dependencies.runCommand ?? defaultWorkspaceCommandRunner;
	const realpath = dependencies.realpath ?? fsRealpath;
	const rootIdentity = await assertOwnedDirectoryIdentity(workspace.root, "workspace root");
	assertSameIdentity(rootIdentity, workspace.rootIdentity, "Mission workspace root changed");

	const gitDirectory = await inspectStandaloneGitDirectory(workspace.root, runCommand, realpath);
	if (gitDirectory !== workspace.gitDirectory) {
		throw new MissionWorkspaceError(
			"git_metadata_not_isolated",
			"Mission workspace Git metadata changed or escaped its checkout",
		);
	}
	const gitIdentity = await assertOwnedDirectoryIdentity(gitDirectory, "workspace Git directory");
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
	await assertMissionWorkspaceStorageIsolated({
		root: workspace.root,
		gitDirectory: workspace.gitDirectory,
		rootDevice: workspace.rootIdentity.device,
	});
}

export async function assertMissionWorkspaceClean(
	workspace: PreparedMissionWorkspace,
	dependencies: Pick<MissionWorkspaceDependencies, "runCommand"> = {},
): Promise<void> {
	const runCommand = dependencies.runCommand ?? defaultWorkspaceCommandRunner;
	const statusArgv = ["status", "--porcelain=v1", "--untracked-files=all"] as const;
	const status = await runCommand({
		file: "git",
		argv: statusArgv,
		cwd: workspace.root,
		shell: false,
	});
	assertGitSuccess(status.exitCode, statusArgv, "Git cleanliness inspection failed");
	if (status.stdout.length > 0) {
		throw new MissionWorkspaceError(
			"workspace_dirty",
			"A fresh Mission containment requires the admitted clean workspace",
		);
	}

	const ignoredArgv = ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"] as const;
	const ignored = await runCommand({
		file: "git",
		argv: ignoredArgv,
		cwd: workspace.root,
		shell: false,
	});
	assertGitSuccess(ignored.exitCode, ignoredArgv, "Git ignored-file inspection failed");
	if (ignored.stdout.length > 0) {
		throw new MissionWorkspaceError(
			"workspace_dirty",
			"A fresh Mission workspace cannot contain ignored files or directories",
		);
	}
}

async function inspectStandaloneGitDirectory(
	root: string,
	runCommand: WorkspaceCommandRunner,
	realpath: (path: string) => Promise<string>,
): Promise<string> {
	const expected = join(root, ".git");
	const entry = await lstat(expected).catch(() => null);
	if (entry === null || !entry.isDirectory() || entry.isSymbolicLink()) {
		throw new MissionWorkspaceError(
			"git_metadata_not_isolated",
			"Mission workspace must use a real, checkout-local .git directory",
		);
	}
	const gitDirectory = await canonicalGitPath(
		runCommand,
		root,
		["rev-parse", "--absolute-git-dir"],
		realpath,
	);
	const commonDirectory = await canonicalGitPath(
		runCommand,
		root,
		["rev-parse", "--path-format=absolute", "--git-common-dir"],
		realpath,
	);
	if (gitDirectory !== expected || commonDirectory !== expected) {
		throw new MissionWorkspaceError(
			"git_metadata_not_isolated",
			"Mission workspace Git metadata must be fully contained in its own checkout",
		);
	}
	return gitDirectory;
}

async function canonicalGitPath(
	runCommand: WorkspaceCommandRunner,
	cwd: string,
	argv: readonly string[],
	realpath: (path: string) => Promise<string>,
): Promise<string> {
	const result = await runCommand({ file: "git", argv, cwd, shell: false });
	assertGitSuccess(result.exitCode, argv, "Git metadata inspection failed");
	const value = result.stdout.replace(/\r?\n$/, "");
	if (value.length === 0 || value.includes("\n") || value.includes("\r")) {
		throw new MissionWorkspaceError("git_command_failed", "Git returned an invalid metadata path");
	}
	return realpath(value);
}

async function singleGitLine(
	runCommand: WorkspaceCommandRunner,
	cwd: string,
	argv: readonly string[],
): Promise<string> {
	const result = await runCommand({ file: "git", argv, cwd, shell: false });
	assertGitSuccess(result.exitCode, argv, "Git identity inspection failed");
	const value = result.stdout.replace(/\r?\n$/, "");
	if (value.length === 0 || value.includes("\n") || value.includes("\r")) {
		throw new MissionWorkspaceError("git_command_failed", "Git returned invalid identity output");
	}
	return value;
}

function assertGitSuccess(exitCode: number, argv: readonly string[], message: string): void {
	if (exitCode !== 0) {
		throw new MissionWorkspaceError("git_command_failed", message, {
			argv: [...argv],
			exit_code: exitCode,
		});
	}
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
