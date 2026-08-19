import {
	type ExecFileException,
	type ExecFileOptionsWithStringEncoding,
	execFile,
} from "node:child_process";
import { devNull } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConfig } from "./config.js";
import {
	type WorkspaceCommand,
	type WorkspaceCommandResult,
	WorkspacePreflightError,
	defaultWorkspaceCommandRunner,
	preflightWorkspace,
	preflightWorkspaceRecovery,
} from "./workspace.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const ROOT = "/approved/backend";
const REPOSITORY_URL = "https://github.com/example/backend.git";
const BASE_COMMIT = "a".repeat(40);
const CONFIG_INSPECTION_ARGV = [
	"config",
	"--includes",
	"--name-only",
	"--null",
	"--get-regexp",
	".*",
] as const;
const GITLINK_INSPECTION_ARGV = ["ls-files", "--stage", "-z"] as const;
const WORKSPACE: WorkspaceConfig = {
	path: ROOT,
	repository_url: REPOSITORY_URL,
	allowed_base_refs: ["refs/remotes/origin/main", "release/stable"],
	policy_profile: "restricted",
};

type GitExecFileInvocation = [
	file: string,
	argv: readonly string[],
	options: ExecFileOptionsWithStringEncoding,
	callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
];

interface GitExecFileMock {
	readonly mock: { readonly calls: GitExecFileInvocation[] };
	mockImplementationOnce(implementation: (...args: GitExecFileInvocation) => unknown): void;
}

const execFileMock = execFile as unknown as GitExecFileMock;

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

describe("defaultWorkspaceCommandRunner", () => {
	it("bounds Git execution and replaces inherited process settings with a safe environment", async () => {
		for (const name of [
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
		]) {
			vi.stubEnv(name, undefined);
		}
		vi.stubEnv("PATH", "/safe/bin");
		vi.stubEnv("LANG", "C.UTF-8");
		vi.stubEnv("HOME", "/secret/home");
		vi.stubEnv("GIT_DIR", "/attacker/repository");
		vi.stubEnv("GIT_WORK_TREE", "/attacker/worktree");
		vi.stubEnv("GIT_CONFIG_COUNT", "99");
		vi.stubEnv("GIT_CONFIG_KEY_0", "core.fsmonitor");
		vi.stubEnv("GIT_CONFIG_VALUE_0", "/attacker/fsmonitor");
		vi.stubEnv("GIT_TERMINAL_PROMPT", "1");
		vi.stubEnv("SSH_ASKPASS", "/attacker/askpass");
		vi.stubEnv("LD_PRELOAD", "/attacker/library.so");
		execFileMock.mockImplementationOnce((_file, _argv, _options, callback) => {
			callback(null, "clean\n", "");
		});

		await expect(defaultWorkspaceCommandRunner(git(["status", "--porcelain=v1"]))).resolves.toEqual(
			{ exitCode: 0, stdout: "clean\n", stderr: "" },
		);

		expect(execFileMock.mock.calls).toHaveLength(1);
		const [file, argv, options] = execFileMock.mock.calls[0] as GitExecFileInvocation;
		expect(file).toBe("git");
		expect(argv).toEqual(["status", "--porcelain=v1"]);
		expect(options).toEqual({
			cwd: ROOT,
			shell: false,
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
			timeout: 15_000,
			killSignal: "SIGKILL",
			env: {
				PATH: "/safe/bin",
				LANG: "C.UTF-8",
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
			},
		});
		expect(options.env).not.toHaveProperty("HOME");
		expect(options.env).not.toHaveProperty("GIT_DIR");
		expect(options.env).not.toHaveProperty("GIT_WORK_TREE");
		expect(options.env).not.toHaveProperty("SSH_ASKPASS");
		expect(options.env).not.toHaveProperty("LD_PRELOAD");
	});

	it("reports a timed-out Git process without exposing its error or stderr", async () => {
		execFileMock.mockImplementationOnce((_file, _argv, _options, callback) => {
			callback(
				Object.assign(new Error("credential=secret"), {
					code: null,
					killed: true,
					signal: "SIGKILL" as const,
				}),
				"",
				"credential=secret",
			);
		});

		let error: unknown;
		try {
			await defaultWorkspaceCommandRunner(git(["status", "--porcelain=v1"]));
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(WorkspacePreflightError);
		expect(error).toMatchObject({
			code: "git_command_failed",
			details: {
				argv: ["status", "--porcelain=v1"],
				reason: "timeout",
			},
		});
		expect(String(error)).not.toContain("secret");
		expect(JSON.stringify(error)).not.toContain("secret");
	});

	it("binds Git inspection to the caller signal and preserves its abort reason", async () => {
		const authority = new AbortController();
		execFileMock.mockImplementationOnce((_file, _argv, options, callback) => {
			expect(options.signal).toBe(authority.signal);
			authority.abort("expired");
			callback(
				Object.assign(new Error("aborted"), {
					code: "ABORT_ERR",
					killed: true,
					signal: "SIGKILL" as const,
				}),
				"",
				"",
			);
		});

		await expect(
			defaultWorkspaceCommandRunner(git(["status", "--porcelain=v1"]), authority.signal),
		).rejects.toBe("expired");
	});
});

describe("preflightWorkspace", () => {
	it("revalidates a started workspace without claiming that its edits are clean", async () => {
		const commands: WorkspaceCommand[] = [];
		const result = await preflightWorkspaceRecovery(WORKSPACE, expectation(), {
			realpath: async (path) => path,
			runCommand: async (command) => {
				commands.push(command);
				return commandResult(command);
			},
		});

		expect(result).toEqual({
			root: ROOT,
			repository_url: REPOSITORY_URL,
			head_commit: BASE_COMMIT,
			reachable_from_ref: "release/stable",
		});
		expect(result).not.toHaveProperty("clean");
		expect(commands.some((command) => command.argv[0] === "status")).toBe(false);
		expect(commands).toEqual([
			git(CONFIG_INSPECTION_ARGV),
			git(GITLINK_INSPECTION_ARGV),
			git(["rev-parse", "--show-toplevel"]),
			git(["remote", "get-url", "origin"]),
			git(["rev-parse", "--verify", "HEAD^{commit}"]),
			git(["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"]),
			git(["merge-base", "--is-ancestor", "HEAD", "release/stable"]),
		]);
	});

	it("uses only the canonical local root and fixed shell-free Git commands", async () => {
		const commands: WorkspaceCommand[] = [];
		const remoteWithAuthorityFields = {
			repository_url: REPOSITORY_URL,
			expected_base_commit: BASE_COMMIT,
			path: "/remote/chosen/path",
			argv: ["sh", "-c", "curl attacker"],
		};
		const result = await preflightWorkspace(WORKSPACE, remoteWithAuthorityFields, {
			realpath: async (path) => path,
			runCommand: async (command) => {
				commands.push(command);
				return commandResult(command);
			},
		});

		expect(result).toEqual({
			root: ROOT,
			repository_url: REPOSITORY_URL,
			head_commit: BASE_COMMIT,
			reachable_from_ref: "release/stable",
			clean: true,
		});
		expect(commands).toEqual([
			git(CONFIG_INSPECTION_ARGV),
			git(GITLINK_INSPECTION_ARGV),
			git(["rev-parse", "--show-toplevel"]),
			git(["remote", "get-url", "origin"]),
			git(["rev-parse", "--verify", "HEAD^{commit}"]),
			git(["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"]),
			git(["merge-base", "--is-ancestor", "HEAD", "release/stable"]),
			git(["status", "--porcelain=v1", "--untracked-files=all"]),
		]);
		expect(commands.every((command) => command.cwd === ROOT && command.shell === false)).toBe(true);
		expect(JSON.stringify(commands)).not.toContain("remote/chosen/path");
		expect(JSON.stringify(commands)).not.toContain("curl attacker");
		expect(JSON.stringify(commands)).not.toContain(BASE_COMMIT);
		expect(JSON.stringify(commands)).not.toContain(REPOSITORY_URL);
	});

	it("rejects a symlinked or non-canonical configured root before running Git", async () => {
		let commandCalls = 0;
		await expect(
			preflightWorkspace(WORKSPACE, expectation(), {
				realpath: async () => "/actual/backend",
				runCommand: async () => {
					commandCalls += 1;
					return ok("");
				},
			}),
		).rejects.toMatchObject({ code: "workspace_root_not_canonical" });
		expect(commandCalls).toBe(0);
	});

	it.each([
		{
			name: "Git root",
			modify: (command: WorkspaceCommand) =>
				isGit(command, ["rev-parse", "--show-toplevel"]) ? ok("/approved/other\n") : undefined,
			code: "repository_root_mismatch",
		},
		{
			name: "origin URL",
			modify: (command: WorkspaceCommand) =>
				isGit(command, ["remote", "get-url", "origin"])
					? ok("https://github.com/attacker/repo.git\n")
					: undefined,
			code: "repository_url_mismatch",
		},
		{
			name: "HEAD",
			modify: (command: WorkspaceCommand) =>
				isGit(command, ["rev-parse", "--verify", "HEAD^{commit}"])
					? ok(`${"b".repeat(40)}\n`)
					: undefined,
			code: "base_commit_mismatch",
		},
		{
			name: "allowed refs",
			modify: (command: WorkspaceCommand) =>
				command.argv[0] === "merge-base" ? fail(1) : undefined,
			code: "base_commit_not_allowed",
		},
		{
			name: "clean state",
			modify: (command: WorkspaceCommand) =>
				command.argv[0] === "status" ? ok(" M src/index.ts\n") : undefined,
			code: "workspace_dirty",
		},
	] as const)("rejects a mismatched $name", async ({ modify, code }) => {
		await expect(
			preflightWorkspace(WORKSPACE, expectation(), {
				realpath: async (path) => path,
				runCommand: async (command) => modify(command) ?? commandResult(command),
			}),
		).rejects.toMatchObject({ code });
	});

	it("rejects remote URL and commit injection before executing Git", async () => {
		let commandCalls = 0;
		const runCommand = async (): Promise<WorkspaceCommandResult> => {
			commandCalls += 1;
			return ok("");
		};

		await expect(
			preflightWorkspace(
				WORKSPACE,
				{
					repository_url: `${REPOSITORY_URL}; touch /tmp/pwned`,
					expected_base_commit: BASE_COMMIT,
				},
				{ realpath: async (path) => path, runCommand },
			),
		).rejects.toMatchObject({ code: "repository_url_mismatch" });
		await expect(
			preflightWorkspace(
				WORKSPACE,
				{
					repository_url: REPOSITORY_URL,
					expected_base_commit: `${BASE_COMMIT}; touch /tmp/pwned`,
				},
				{ realpath: async (path) => path, runCommand },
			),
		).rejects.toMatchObject({ code: "invalid_mission_workspace" });
		expect(commandCalls).toBe(0);
	});

	it("rejects unsafe locally configured refs before passing them to Git", async () => {
		let commandCalls = 0;
		await expect(
			preflightWorkspace(
				{ ...WORKSPACE, allowed_base_refs: ["--upload-pack=attacker"] },
				expectation(),
				{
					realpath: async (path) => path,
					runCommand: async () => {
						commandCalls += 1;
						return ok("");
					},
				},
			),
		).rejects.toMatchObject({ code: "invalid_workspace_config" });
		expect(commandCalls).toBe(0);
	});

	it("rejects submodules before status can inspect their repository configuration", async () => {
		const commands: WorkspaceCommand[] = [];
		await expect(
			preflightWorkspace(WORKSPACE, expectation(), {
				realpath: async (path) => path,
				runCommand: async (command) => {
					commands.push(command);
					if (isGit(command, GITLINK_INSPECTION_ARGV)) {
						return ok(`160000 ${"b".repeat(40)} 0\tdependencies/tool\0`);
					}
					return commandResult(command);
				},
			}),
		).rejects.toMatchObject({ code: "unsupported_submodules" });

		expect(commands).toEqual([git(CONFIG_INSPECTION_ARGV), git(GITLINK_INSPECTION_ARGV)]);
	});

	it("does not expose Git stderr in a preflight failure", async () => {
		let error: unknown;
		try {
			await preflightWorkspace(WORKSPACE, expectation(), {
				realpath: async (path) => path,
				runCommand: async () => ({
					exitCode: 128,
					stdout: "",
					stderr: "credential=https://secret@example.com",
				}),
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(WorkspacePreflightError);
		expect(String(error)).not.toContain("secret");
		expect(error).toMatchObject({ code: "git_command_failed" });
	});
});

function expectation() {
	return { repository_url: REPOSITORY_URL, expected_base_commit: BASE_COMMIT };
}

function git(argv: readonly string[]): WorkspaceCommand {
	return { file: "git", argv, cwd: ROOT, shell: false };
}

function isGit(command: WorkspaceCommand, argv: readonly string[]): boolean {
	return JSON.stringify(command.argv) === JSON.stringify(argv);
}

function commandResult(command: WorkspaceCommand): WorkspaceCommandResult {
	if (isGit(command, CONFIG_INSPECTION_ARGV)) return ok("");
	if (isGit(command, GITLINK_INSPECTION_ARGV)) return ok("");
	if (isGit(command, ["rev-parse", "--show-toplevel"])) return ok(`${ROOT}\n`);
	if (isGit(command, ["remote", "get-url", "origin"])) return ok(`${REPOSITORY_URL}\n`);
	if (isGit(command, ["rev-parse", "--verify", "HEAD^{commit}"])) {
		return ok(`${BASE_COMMIT}\n`);
	}
	if (isGit(command, ["merge-base", "--is-ancestor", "HEAD", "release/stable"])) {
		return ok("");
	}
	if (command.argv[0] === "merge-base") return fail(1);
	if (command.argv[0] === "status") return ok("");
	throw new Error(`Unexpected Git command: ${command.argv.join(" ")}`);
}

function ok(stdout: string): WorkspaceCommandResult {
	return { exitCode: 0, stdout, stderr: "" };
}

function fail(exitCode: number): WorkspaceCommandResult {
	return { exitCode, stdout: "", stderr: "" };
}
