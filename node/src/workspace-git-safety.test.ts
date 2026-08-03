import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceConfig } from "./config.js";
import { preflightWorkspace } from "./workspace.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const REPOSITORY_URL = "https://github.com/example/backend.git";

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("workspace Git configuration safety", () => {
	it("rejects an included local clean filter before Git can execute it", async () => {
		const temporaryRoot = await realpath(
			await mkdtemp(join(tmpdir(), "agentrelay-node-git-safety-")),
		);
		temporaryDirectories.push(temporaryRoot);
		const repositoryRoot = join(temporaryRoot, "repository");
		const includedConfig = join(temporaryRoot, "included.gitconfig");
		const filterScript = join(temporaryRoot, "filter.mjs");
		const marker = join(temporaryRoot, "filter-ran");
		await mkdir(repositoryRoot);

		await git(repositoryRoot, ["init", "--initial-branch=main", "."]);
		await git(repositoryRoot, ["config", "user.name", "AgentRelay Review"]);
		await git(repositoryRoot, ["config", "user.email", "review@agentrelay.test"]);
		await git(repositoryRoot, ["remote", "add", "origin", REPOSITORY_URL]);
		await writeFile(join(repositoryRoot, ".gitattributes"), "*.txt filter=review\n");
		await writeFile(join(repositoryRoot, "tracked.txt"), "base\n");
		await git(repositoryRoot, ["add", ".gitattributes", "tracked.txt"]);
		await git(repositoryRoot, ["commit", "-m", "fixture"]);
		const headCommit = (await git(repositoryRoot, ["rev-parse", "HEAD"])).trim();

		await writeFile(
			filterScript,
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nprocess.stdin.pipe(process.stdout);\n`,
		);
		await git(repositoryRoot, [
			"config",
			"--file",
			includedConfig,
			"filter.review.clean",
			`${shellQuote(process.execPath)} ${shellQuote(filterScript)}`,
		]);
		await git(repositoryRoot, ["config", "--local", "include.path", includedConfig]);
		await writeFile(join(repositoryRoot, "tracked.txt"), "evil\n");
		const future = new Date(Date.now() + 2_000);
		await utimes(join(repositoryRoot, "tracked.txt"), future, future);

		const workspace: WorkspaceConfig = {
			path: repositoryRoot,
			repository_url: REPOSITORY_URL,
			allowed_base_refs: ["refs/heads/main"],
			policy_profile: "restricted",
		};
		await expect(
			preflightWorkspace(workspace, {
				repository_url: REPOSITORY_URL,
				expected_base_commit: headCommit,
			}),
		).rejects.toMatchObject({
			code: "unsafe_git_configuration",
			details: { config_keys: ["filter.review.clean"] },
		});
		await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readFile(join(repositoryRoot, "tracked.txt"), "utf8")).resolves.toBe("evil\n");
	});
});

async function git(cwd: string, argv: readonly string[]): Promise<string> {
	const result = await execFileAsync("git", [...argv], {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
		},
	});
	return result.stdout;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
