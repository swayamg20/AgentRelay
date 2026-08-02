import { spawn } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";

const FIXTURE_NAME = /^[a-z][a-z0-9-]*$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;
const GIT_IDENTITY = {
	GIT_AUTHOR_NAME: "AgentRelay Fixture",
	GIT_AUTHOR_EMAIL: "fixture@agentrelay.dev",
	GIT_COMMITTER_NAME: "AgentRelay Fixture",
	GIT_COMMITTER_EMAIL: "fixture@agentrelay.dev",
} as const;

export interface FrozenRepositoryDefinition {
	readonly name: string;
	readonly baseDirectory: string;
	readonly expectedDirectory: string;
	readonly baseCommit: string;
	readonly expectedCommit: string;
}

export interface MaterializedFrozenRepository {
	readonly name: string;
	readonly basePath: string;
	readonly expectedPath: string;
	readonly baseCommit: string;
	readonly expectedCommit: string;
}

/** Materializes and verifies the two fixed commits used by a local test fixture. */
export async function materializeFrozenRepository(
	definition: FrozenRepositoryDefinition,
	parentDirectory: string,
): Promise<MaterializedFrozenRepository> {
	assertDefinition(definition);
	const basePath = join(parentDirectory, `${definition.name}-base`);
	const expectedPath = join(parentDirectory, `${definition.name}-expected`);
	const expectedIndex = join(parentDirectory, `${definition.name}-expected.index`);

	await mkdir(basePath, { recursive: false });
	await runGit(["init", "--quiet", "--initial-branch=main", "--object-format=sha1"], {
		cwd: basePath,
	});
	await runGit(["config", "core.autocrlf", "false"], { cwd: basePath });
	await cp(definition.baseDirectory, basePath, { recursive: true });
	await runGit(["add", "--all"], { cwd: basePath });
	await runGit(
		[
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--quiet",
			"-m",
			`fixture: freeze ${definition.name} base`,
		],
		{
			cwd: basePath,
			env: {
				...GIT_IDENTITY,
				GIT_AUTHOR_DATE: "2026-08-02T00:00:00Z",
				GIT_COMMITTER_DATE: "2026-08-02T00:00:00Z",
			},
		},
	);
	const baseCommit = await runGit(["rev-parse", "HEAD"], { cwd: basePath });
	assertLockedCommit(definition.name, "base", definition.baseCommit, baseCommit);

	const gitDirectory = join(basePath, ".git");
	await runGit(
		[
			`--git-dir=${gitDirectory}`,
			`--work-tree=${definition.expectedDirectory}`,
			"-c",
			"core.autocrlf=false",
			"add",
			"--all",
		],
		{ env: { GIT_INDEX_FILE: expectedIndex } },
	);
	const expectedTree = await runGit([`--git-dir=${gitDirectory}`, "write-tree"], {
		env: { GIT_INDEX_FILE: expectedIndex },
	});
	const expectedCommit = await runGit(
		[
			`--git-dir=${gitDirectory}`,
			"-c",
			"commit.gpgsign=false",
			"commit-tree",
			expectedTree,
			"-p",
			baseCommit,
			"-m",
			`fixture: apply ${definition.name} expected result`,
		],
		{
			env: {
				...GIT_IDENTITY,
				GIT_AUTHOR_DATE: "2026-08-02T00:01:00Z",
				GIT_COMMITTER_DATE: "2026-08-02T00:01:00Z",
			},
		},
	);
	assertLockedCommit(definition.name, "expected", definition.expectedCommit, expectedCommit);

	await runGit(["worktree", "add", "--quiet", "--detach", expectedPath, expectedCommit], {
		cwd: basePath,
	});
	return {
		name: definition.name,
		basePath,
		expectedPath,
		baseCommit,
		expectedCommit,
	};
}

export interface FixedCommand {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
}

export async function runFixedCommand(command: FixedCommand): Promise<string> {
	return run(command.executable, command.args, { cwd: command.cwd, preserveStdout: true });
}

function assertDefinition(definition: FrozenRepositoryDefinition): void {
	if (!FIXTURE_NAME.test(definition.name)) {
		throw new Error(`Invalid frozen repository name: ${definition.name}`);
	}
	if (!GIT_COMMIT.test(definition.baseCommit) || !GIT_COMMIT.test(definition.expectedCommit)) {
		throw new Error(`Invalid frozen repository commit lock: ${definition.name}`);
	}
}

function assertLockedCommit(
	name: string,
	kind: "base" | "expected",
	expected: string,
	received: string,
): void {
	if (received !== expected) {
		throw new Error(
			`Frozen ${name} ${kind} commit mismatch: expected ${expected}, received ${received}`,
		);
	}
}

interface RunOptions {
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly preserveStdout?: boolean;
}

function runGit(args: readonly string[], options: RunOptions = {}): Promise<string> {
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
	);
	return run("git", args, {
		...options,
		env: {
			...inherited,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_SYSTEM: devNull,
			GIT_CONFIG_GLOBAL: devNull,
			GIT_ATTR_NOSYSTEM: "1",
			...options.env,
		},
	});
}

async function run(
	executable: string,
	args: readonly string[],
	options: RunOptions = {},
): Promise<string> {
	return await new Promise((resolve, reject) => {
		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("error", reject);
		child.once("close", (code) => {
			const rawOutput = Buffer.concat(stdout).toString("utf8");
			const output = options.preserveStdout ? rawOutput : rawOutput.trim();
			if (code === 0) {
				resolve(output);
				return;
			}
			reject(
				new Error(
					`${executable} exited ${code ?? "without a status"}: ${Buffer.concat(stderr)
						.toString("utf8")
						.trim()}`,
				),
			);
		});
	});
}
