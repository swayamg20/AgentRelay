import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backendAndroidRepositories } from "./fixtures/backend-android.js";
import { materializeFrozenRepository, runFixedCommand } from "./frozen-repository.js";

let temporaryRoot: string | undefined;

afterEach(async () => {
	if (temporaryRoot !== undefined) {
		await rm(temporaryRoot, { recursive: true, force: true });
		temporaryRoot = undefined;
	}
});

describe("materializeFrozenRepository", () => {
	it("reproduces the locked commits independently of ambient Git configuration", async () => {
		temporaryRoot = await mkdtemp(join(tmpdir(), "agentrelay-frozen-repositories-"));
		const [backend, android] = await withAmbientCommitEncoding(async () =>
			Promise.all([
				materializeFrozenRepository(backendAndroidRepositories.backend, temporaryRoot),
				materializeFrozenRepository(backendAndroidRepositories.android, temporaryRoot),
			]),
		);

		expect(backend.baseCommit).toBe(backendAndroidRepositories.backend.baseCommit);
		expect(backend.expectedCommit).toBe(backendAndroidRepositories.backend.expectedCommit);
		expect(android.baseCommit).toBe(backendAndroidRepositories.android.baseCommit);
		expect(android.expectedCommit).toBe(backendAndroidRepositories.android.expectedCommit);
		expect(
			await runFixedCommand({
				executable: "git",
				args: ["status", "--porcelain"],
				cwd: backend.basePath,
			}),
		).toBe("");
		expect(
			await runFixedCommand({
				executable: "git",
				args: ["status", "--porcelain"],
				cwd: android.basePath,
			}),
		).toBe("");
	});

	it("runs the locally registered repository checks on the expected workspaces", async () => {
		temporaryRoot = await mkdtemp(join(tmpdir(), "agentrelay-frozen-repositories-"));
		const [backend, android] = await Promise.all([
			materializeFrozenRepository(backendAndroidRepositories.backend, temporaryRoot),
			materializeFrozenRepository(backendAndroidRepositories.android, temporaryRoot),
		]);

		await expect(
			runFixedCommand({
				executable: process.execPath,
				args: ["verify.mjs"],
				cwd: backend.expectedPath,
			}),
		).resolves.toBe("");
		await expect(
			runFixedCommand({
				executable: process.execPath,
				args: ["verify.mjs"],
				cwd: android.expectedPath,
			}),
		).resolves.toBe("");
	});

	it("preserves exact verification stdout and rejects nonzero commands", async () => {
		await expect(
			runFixedCommand({
				executable: process.execPath,
				args: ["-e", 'process.stdout.write("result\\n")'],
				cwd: tmpdir(),
			}),
		).resolves.toBe("result\n");
		await expect(
			runFixedCommand({
				executable: process.execPath,
				args: ["-e", 'process.stderr.write("failed\\n"); process.exit(7)'],
				cwd: tmpdir(),
			}),
		).rejects.toThrow(/exited 7: failed/);
	});

	it("rejects unsafe fixture names and stale commit locks", async () => {
		temporaryRoot = await mkdtemp(join(tmpdir(), "agentrelay-frozen-repositories-"));
		await expect(
			materializeFrozenRepository(
				{ ...backendAndroidRepositories.backend, name: "../backend" },
				temporaryRoot,
			),
		).rejects.toThrow(/Invalid frozen repository name/);
		await expect(
			materializeFrozenRepository(
				{ ...backendAndroidRepositories.backend, baseCommit: "0".repeat(40) },
				temporaryRoot,
			),
		).rejects.toThrow(/Frozen backend base commit mismatch/);
	});
});

async function withAmbientCommitEncoding<T>(callback: () => Promise<T>): Promise<T> {
	const previousGitConfig = {
		count: process.env.GIT_CONFIG_COUNT,
		key: process.env.GIT_CONFIG_KEY_0,
		value: process.env.GIT_CONFIG_VALUE_0,
	};
	process.env.GIT_CONFIG_COUNT = "1";
	process.env.GIT_CONFIG_KEY_0 = "i18n.commitEncoding";
	process.env.GIT_CONFIG_VALUE_0 = "ISO-8859-1";
	try {
		return await callback();
	} finally {
		restoreEnvironment("GIT_CONFIG_COUNT", previousGitConfig.count);
		restoreEnvironment("GIT_CONFIG_KEY_0", previousGitConfig.key);
		restoreEnvironment("GIT_CONFIG_VALUE_0", previousGitConfig.value);
	}
}

function restoreEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}
