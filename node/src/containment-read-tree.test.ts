import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertContainmentReadTreesIsolated } from "./containment-read-tree.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
	);
});

describe("containment read tree isolation", () => {
	it("accepts immutable owner-controlled files", async () => {
		const fixture = await createFixture();
		await writeFile(join(fixture.readRoot, "runtime.bin"), "runtime");

		await expect(
			assertContainmentReadTreesIsolated({
				roots: [fixture.readRoot],
				deniedRoots: [fixture.deniedRoot],
			}),
		).resolves.toBeUndefined();
	});

	it("rejects files hard-linked outside an approved tree", async () => {
		const fixture = await createFixture();
		const outside = join(fixture.root, "outside-secret");
		await writeFile(outside, "secret");
		await link(outside, join(fixture.readRoot, "alias"));

		await expect(
			assertContainmentReadTreesIsolated({
				roots: [fixture.readRoot],
				deniedRoots: [fixture.deniedRoot],
			}),
		).rejects.toThrow("hard-linked elsewhere");
	});

	it("rejects symbolic links into denied roots", async () => {
		const fixture = await createFixture();
		const secret = join(fixture.deniedRoot, "secret");
		await writeFile(secret, "secret");
		await symlink(secret, join(fixture.readRoot, "alias"));

		await expect(
			assertContainmentReadTreesIsolated({
				roots: [fixture.readRoot],
				deniedRoots: [fixture.deniedRoot],
			}),
		).rejects.toThrow("cannot target denied roots");
	});

	it("rejects host-writable entries", async () => {
		const fixture = await createFixture();
		const writable = join(fixture.readRoot, "writable");
		await writeFile(writable, "mutable");
		await chmod(writable, 0o666);

		await expect(
			assertContainmentReadTreesIsolated({
				roots: [fixture.readRoot],
				deniedRoots: [fixture.deniedRoot],
			}),
		).rejects.toThrow("writable host entries");
	});
});

async function createFixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-read-tree-")));
	temporaryRoots.push(root);
	const readRoot = join(root, "read");
	const deniedRoot = join(root, "denied");
	await Promise.all([mkdir(readRoot), mkdir(deniedRoot)]);
	return { root, readRoot, deniedRoot };
}
