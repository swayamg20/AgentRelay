import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLiveStore } from "./store.js";

const directories: string[] = [];
const stores: Awaited<ReturnType<typeof openLiveStore>>[] = [];
afterEach(async () => {
	await Promise.all(stores.splice(0).map((store) => store.close()));
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});
async function fixture() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "ar-live-store-")));
	directories.push(directory);
	return {
		path: join(directory, "state.json"),
		scope: {
			relayUrl: "https://relay.example",
			agentId: randomUUID(),
			localHandle: "a@team",
			peerHandle: "b@team",
			threadId: randomUUID(),
		},
		maxTurns: 3,
		expiresAt: Date.now() + 60_000,
	};
}
describe("live journal ownership and durability", () => {
	it("excludes another writer and preserves progress and expiry after reopening", async () => {
		const input = await fixture();
		const first = await openLiveStore(input);
		stores.push(first);
		await expect(openLiveStore(input)).rejects.toMatchObject({ kind: "already_running" });
		await first.save({ ...first.read(), lastSequence: 3 });
		await first.close();
		const second = await openLiveStore({ ...input, expiresAt: input.expiresAt + 100_000 });
		stores.push(second);
		expect(second.read()).toMatchObject({ lastSequence: 3, expiresAt: input.expiresAt });
		expect((await lstat(input.path)).mode & 0o777).toBe(0o600);
		await expect(second.save({ ...second.read(), lastSequence: 2 })).rejects.toThrow(
			"cannot be rewritten",
		);
	});
	it("refuses changed scope or limits without modifying the journal", async () => {
		const input = await fixture();
		const first = await openLiveStore(input);
		await first.close();
		const original = await readFile(input.path, "utf8");
		await expect(openLiveStore({ ...input, maxTurns: 4 })).rejects.toThrow("scope changed");
		await expect(
			openLiveStore({ ...input, scope: { ...input.scope, peerHandle: "c@team" } }),
		).rejects.toThrow("scope changed");
		expect(await readFile(input.path, "utf8")).toBe(original);
	});
	it("does not reset malformed state or follow a symlink", async () => {
		const input = await fixture();
		await writeFile(input.path, "not json", { mode: 0o600 });
		await expect(openLiveStore(input)).rejects.toThrow("not reset");
		const linked = { ...input, path: `${input.path}.linked` };
		await symlink(input.path, linked.path);
		await expect(openLiveStore(linked)).rejects.toThrow("safely open");
		expect(await readFile(input.path, "utf8")).toBe("not json");
	});
});
