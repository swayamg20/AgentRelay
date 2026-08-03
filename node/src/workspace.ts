import { execFile } from "node:child_process";
import { realpath as fsRealpath } from "node:fs/promises";
import { devNull } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { WorkspaceConfig } from "./config.js";

const GIT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 15_000;
const GIT_ENVIRONMENT_ALLOWLIST = [
	"PATH",
	"Path",
	"PATHEXT",
	"SystemRoot",
	"SYSTEMROOT",
	"WINDIR",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
] as const;
const BASE_COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REPOSITORY_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export type WorkspacePreflightErrorCode =
	| "invalid_workspace_config"
	| "invalid_mission_workspace"
	| "workspace_root_not_canonical"
	| "repository_root_mismatch"
	| "repository_url_mismatch"
	| "base_commit_mismatch"
	| "base_commit_not_allowed"
	| "workspace_dirty"
	| "unsupported_submodules"
	| "unsafe_git_configuration"
	| "git_command_failed";

export class WorkspacePreflightError extends Error {
	constructor(
		readonly code: WorkspacePreflightErrorCode,
		message: string,
		readonly details: Readonly<Record<string, unknown>> = {},
	) {
		super(message);
		this.name = "WorkspacePreflightError";
	}
}

export interface MissionWorkspaceExpectation {
	readonly repository_url: string;
	readonly expected_base_commit: string;
}

export interface WorkspaceCommand {
	readonly file: "git";
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly shell: false;
}

export interface WorkspaceCommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export type WorkspaceCommandRunner = (command: WorkspaceCommand) => Promise<WorkspaceCommandResult>;

export interface WorkspacePreflightDependencies {
	readonly runCommand?: WorkspaceCommandRunner;
	readonly realpath?: (path: string) => Promise<string>;
}

export interface WorkspacePreflightResult {
	readonly root: string;
	readonly repository_url: string;
	readonly head_commit: string;
	readonly reachable_from_ref: string;
	readonly clean: true;
}

/**
 * Verifies one owner-configured checkout without accepting a remote cwd or command.
 * All Git invocations use a canonical local root, fixed argv, and shell:false.
 */
export async function preflightWorkspace(
	workspace: WorkspaceConfig,
	expectation: MissionWorkspaceExpectation,
	dependencies: WorkspacePreflightDependencies = {},
): Promise<WorkspacePreflightResult> {
	assertLocalWorkspaceConfig(workspace);
	assertMissionExpectation(expectation);

	if (workspace.repository_url !== expectation.repository_url) {
		throw new WorkspacePreflightError(
			"repository_url_mismatch",
			"Mission repository URL does not match the local workspace binding",
		);
	}

	const realpath = dependencies.realpath ?? fsRealpath;
	const configuredRoot = resolve(workspace.path);
	const canonicalRoot = await realpath(workspace.path);
	if (canonicalRoot !== configuredRoot) {
		throw new WorkspacePreflightError(
			"workspace_root_not_canonical",
			"Workspace path must name its exact canonical root",
			{ configured_root: configuredRoot, canonical_root: canonicalRoot },
		);
	}

	const runCommand = dependencies.runCommand ?? defaultWorkspaceCommandRunner;
	const runGit = (argv: readonly string[]) =>
		runCommand({ file: "git", argv: [...argv], cwd: canonicalRoot, shell: false });
	await assertNoExecutableGitFilters(runGit);
	await assertNoGitlinks(runGit);

	const repositoryRoot = singleLine(
		await requireGitSuccess(runGit, ["rev-parse", "--show-toplevel"]),
		"repository root",
	);
	const canonicalRepositoryRoot = await realpath(repositoryRoot);
	if (canonicalRepositoryRoot !== canonicalRoot) {
		throw new WorkspacePreflightError(
			"repository_root_mismatch",
			"Configured workspace must be the exact Git repository root",
			{ configured_root: canonicalRoot, repository_root: canonicalRepositoryRoot },
		);
	}

	const originUrl = singleLine(
		await requireGitSuccess(runGit, ["remote", "get-url", "origin"]),
		"origin URL",
	);
	if (originUrl !== workspace.repository_url) {
		throw new WorkspacePreflightError(
			"repository_url_mismatch",
			"Git origin does not match the local workspace binding",
		);
	}

	const headCommit = singleLine(
		await requireGitSuccess(runGit, ["rev-parse", "--verify", "HEAD^{commit}"]),
		"HEAD commit",
	);
	if (headCommit !== expectation.expected_base_commit) {
		throw new WorkspacePreflightError(
			"base_commit_mismatch",
			"Workspace HEAD does not match the Mission base commit",
			{ actual_head: headCommit, expected_base_commit: expectation.expected_base_commit },
		);
	}

	let reachableFromRef: string | null = null;
	for (const allowedRef of workspace.allowed_base_refs) {
		const result = await runGit(["merge-base", "--is-ancestor", "HEAD", allowedRef]);
		if (result.exitCode === 0) {
			reachableFromRef = allowedRef;
			break;
		}
		if (result.exitCode !== 1) {
			throw gitCommandFailed(["merge-base", "--is-ancestor", "HEAD", allowedRef], result);
		}
	}
	if (reachableFromRef === null) {
		throw new WorkspacePreflightError(
			"base_commit_not_allowed",
			"Workspace HEAD is not reachable from an allowed local base ref",
		);
	}

	const status = await requireGitSuccess(runGit, [
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
	]);
	if (status.stdout.length > 0) {
		throw new WorkspacePreflightError("workspace_dirty", "Workspace contains uncommitted changes");
	}

	return Object.freeze({
		root: canonicalRoot,
		repository_url: originUrl,
		head_commit: headCommit,
		reachable_from_ref: reachableFromRef,
		clean: true,
	});
}

async function assertNoExecutableGitFilters(
	runGit: (argv: readonly string[]) => Promise<WorkspaceCommandResult>,
): Promise<void> {
	const argv = ["config", "--includes", "--name-only", "--null", "--get-regexp", ".*"];
	const result = await runGit(argv);
	if (result.exitCode !== 0 && result.exitCode !== 1) {
		throw gitCommandFailed(argv, result);
	}

	const unsafeKeys = result.stdout
		.split("\0")
		.filter((key) => /^filter\..+\.(?:clean|smudge|process|required)$/i.test(key));
	if (unsafeKeys.length > 0) {
		throw new WorkspacePreflightError(
			"unsafe_git_configuration",
			"Workspace Git configuration contains an external content filter",
			{ config_keys: unsafeKeys },
		);
	}
}

async function assertNoGitlinks(
	runGit: (argv: readonly string[]) => Promise<WorkspaceCommandResult>,
): Promise<void> {
	const argv = ["ls-files", "--stage", "-z"];
	const result = await requireGitSuccess(runGit, argv);
	if (result.stdout.split("\0").some((entry) => entry.startsWith("160000 "))) {
		throw new WorkspacePreflightError(
			"unsupported_submodules",
			"Workspace Git submodules are not supported by safe preflight",
		);
	}
}

export const defaultWorkspaceCommandRunner: WorkspaceCommandRunner = async (command) => {
	if (command.file !== "git" || command.shell !== false) {
		throw new Error("Workspace command runner accepts only git with shell:false");
	}

	return new Promise((resolveResult, reject) => {
		execFile(
			"git",
			[...command.argv],
			{
				cwd: command.cwd,
				shell: false,
				encoding: "utf8",
				maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
				timeout: GIT_COMMAND_TIMEOUT_MS,
				killSignal: "SIGKILL",
				env: gitEnvironment(process.env),
			},
			(error, stdout, stderr) => {
				const exitCode = error === null ? 0 : error.code;
				if (typeof exitCode !== "number") {
					const timedOut = error?.killed === true;
					reject(
						new WorkspacePreflightError(
							"git_command_failed",
							timedOut
								? "Git workspace inspection timed out"
								: "Git workspace inspection could not complete",
							{
								argv: [...command.argv],
								reason: timedOut ? "timeout" : "execution_failed",
							},
						),
					);
					return;
				}
				resolveResult({
					exitCode,
					stdout,
					stderr,
				});
			},
		);
	});
};

function gitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const name of GIT_ENVIRONMENT_ALLOWLIST) {
		const value = source[name];
		if (value !== undefined) {
			environment[name] = value;
		}
	}

	return {
		...environment,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_SYSTEM: devNull,
		GIT_CONFIG_GLOBAL: devNull,
		GIT_ATTR_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_CONFIG_COUNT: "2",
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: devNull,
		GIT_CONFIG_KEY_1: "core.fsmonitor",
		GIT_CONFIG_VALUE_1: "false",
	};
}

async function requireGitSuccess(
	runGit: (argv: readonly string[]) => Promise<WorkspaceCommandResult>,
	argv: readonly string[],
): Promise<WorkspaceCommandResult> {
	const result = await runGit(argv);
	if (result.exitCode !== 0) {
		throw gitCommandFailed(argv, result);
	}
	return result;
}

function gitCommandFailed(
	argv: readonly string[],
	result: WorkspaceCommandResult,
): WorkspacePreflightError {
	return new WorkspacePreflightError("git_command_failed", "Git workspace inspection failed", {
		argv: [...argv],
		exit_code: result.exitCode,
	});
}

function singleLine(result: WorkspaceCommandResult, label: string): string {
	const value = result.stdout.endsWith("\n")
		? result.stdout.slice(0, result.stdout.endsWith("\r\n") ? -2 : -1)
		: result.stdout;
	if (value.length === 0 || value.includes("\n") || value.includes("\r")) {
		throw new WorkspacePreflightError("git_command_failed", `Git returned an invalid ${label}`);
	}
	return value;
}

function assertLocalWorkspaceConfig(workspace: WorkspaceConfig): void {
	if (!isAbsolute(workspace.path) || resolve(workspace.path) !== workspace.path) {
		throw new WorkspacePreflightError(
			"invalid_workspace_config",
			"Local workspace path must be absolute and normalized",
		);
	}
	if (workspace.allowed_base_refs.length === 0) {
		throw new WorkspacePreflightError(
			"invalid_workspace_config",
			"Local workspace requires at least one allowed base ref",
		);
	}
	for (const ref of workspace.allowed_base_refs) {
		if (
			!REPOSITORY_REF_PATTERN.test(ref) ||
			ref.includes("..") ||
			ref.includes("//") ||
			ref.endsWith("/") ||
			ref.endsWith(".") ||
			ref.endsWith(".lock")
		) {
			throw new WorkspacePreflightError(
				"invalid_workspace_config",
				"Local workspace contains an unsafe allowed base ref",
			);
		}
	}
}

function assertMissionExpectation(expectation: MissionWorkspaceExpectation): void {
	if (!BASE_COMMIT_PATTERN.test(expectation.expected_base_commit)) {
		throw new WorkspacePreflightError(
			"invalid_mission_workspace",
			"Mission base commit must be a canonical commit hash",
		);
	}
}
