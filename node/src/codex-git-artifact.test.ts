import { lstatSync, realpathSync } from "node:fs";
import { chmod, link, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertPinnedOwnerGitExecutable, pinOwnerGitExecutable } from "./codex-git-artifact.js";

const temporaryDirectories: string[] = [];
const rootOwnedExecutable = findRootOwnedExecutable();

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe.runIf(process.platform !== "win32")("owner-selected Git artifact", () => {
	it("pins and exactly revalidates a stable trusted executable", async () => {
		const fixture = await createExecutable();

		const pinned = await pinOwnerGitExecutable(fixture.executable);

		expect(pinned).toMatchObject({
			executable: {
				path: fixture.executable,
				identity: { device: expect.stringMatching(/^\d+$/), inode: expect.stringMatching(/^\d+$/) },
			},
			sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(Object.isFrozen(pinned)).toBe(true);
		expect(Object.isFrozen(pinned.executable)).toBe(true);
		expect(Object.isFrozen(pinned.executable.identity)).toBe(true);
		await expect(assertPinnedOwnerGitExecutable(pinned)).resolves.toBeUndefined();

		await chmod(fixture.executable, 0o700);
		await writeFile(fixture.executable, "changed-git", { mode: 0o500 });
		await chmod(fixture.executable, 0o500);
		await expect(assertPinnedOwnerGitExecutable(pinned)).rejects.toThrow(
			"changed after it was pinned",
		);
	});

	it.runIf(rootOwnedExecutable !== null && process.getuid?.() !== 0)(
		"accepts a trusted root-owned executable selected by a non-root owner",
		async () => {
			if (rootOwnedExecutable === null) throw new Error("root-owned fixture is unavailable");
			await expect(pinOwnerGitExecutable(rootOwnedExecutable)).resolves.toMatchObject({
				executable: { path: rootOwnedExecutable },
			});
		},
	);

	it.each([
		["non-executable", 0o400],
		["group-writable", 0o520],
		["world-writable", 0o502],
		["set-user-ID", 0o4500],
	] as const)("rejects a %s owner path", async (_name, mode) => {
		const fixture = await createExecutable();
		await chmod(fixture.executable, mode);

		await expect(pinOwnerGitExecutable(fixture.executable)).rejects.toThrow(
			"not a trusted executable file",
		);
	});

	it("rejects symlinks, hard links, and oversized executables", async () => {
		const symlinkFixture = await createExecutable();
		const alias = join(symlinkFixture.root, "git-alias");
		await symlink(symlinkFixture.executable, alias);
		await expect(pinOwnerGitExecutable(alias)).rejects.toThrow("canonical path");

		const hardlinkFixture = await createExecutable();
		await link(hardlinkFixture.executable, join(hardlinkFixture.root, "git-hardlink"));
		await expect(pinOwnerGitExecutable(hardlinkFixture.executable)).rejects.toThrow(
			"not a trusted executable file",
		);

		const oversizedFixture = await createExecutable();
		await chmod(oversizedFixture.executable, 0o700);
		await truncate(oversizedFixture.executable, 64 * 1_048_576 + 1);
		await chmod(oversizedFixture.executable, 0o500);
		await expect(pinOwnerGitExecutable(oversizedFixture.executable)).rejects.toThrow(
			"not a trusted executable file",
		);
	});
});

async function createExecutable(): Promise<{ root: string; executable: string }> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-git-artifact-")));
	temporaryDirectories.push(root);
	const executable = join(root, "git");
	await writeFile(executable, "test-git", { mode: 0o500 });
	return { root, executable };
}

function findRootOwnedExecutable(): string | null {
	try {
		const path = realpathSync("/bin/ls");
		const stats = lstatSync(path);
		return stats.uid === 0 && stats.nlink === 1 ? path : null;
	} catch {
		return null;
	}
}
