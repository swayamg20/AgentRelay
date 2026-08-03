import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireProcessLock } from "./process-lock.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("acquireProcessLock", () => {
	it("creates a mode-0600 singleton lock and rejects a live owner", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "run.lock");
		const first = await acquireProcessLock(
			path,
			fixedOptions("10000000-0000-4000-8000-000000000001"),
		);

		expect((await stat(path)).mode & 0o777).toBe(0o600);
		await expect(
			acquireProcessLock(path, {
				...fixedOptions("10000000-0000-4000-8000-000000000002"),
				isProcessAlive: () => true,
			}),
		).rejects.toMatchObject({
			name: "ProcessLockError",
			reason: "already_running",
		});

		await first.release();
	});

	it("reports a stale lock without deleting or replacing it", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "run.lock");
		const stale = {
			schema_version: 1,
			lock_id: "10000000-0000-4000-8000-000000000001",
			pid: 999,
			started_at: "2026-08-03T00:00:00.000Z",
		};
		await writeFile(path, JSON.stringify(stale), { mode: 0o600 });

		await expect(
			acquireProcessLock(path, {
				...fixedOptions("10000000-0000-4000-8000-000000000002"),
				isProcessAlive: () => false,
			}),
		).rejects.toMatchObject({
			name: "ProcessLockError",
			reason: "stale_lock",
			owner: stale,
			message: expect.stringContaining("remove it only after confirming"),
		});
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(stale);
	});

	it("fails closed on malformed lock metadata", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "run.lock");
		await writeFile(path, "not-json", { mode: 0o600 });

		await expect(acquireProcessLock(path, fixedOptions())).rejects.toMatchObject({
			name: "ProcessLockError",
			reason: "invalid_lock",
		});
	});

	it("release is idempotent and permits a later owner", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "run.lock");
		const first = await acquireProcessLock(path, fixedOptions());
		await first.release();
		await first.release();

		const second = await acquireProcessLock(
			path,
			fixedOptions("10000000-0000-4000-8000-000000000002"),
		);
		await second.release();
	});

	it("does not remove a lock file replaced by a different owner", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "run.lock");
		const first = await acquireProcessLock(path, fixedOptions());
		const replacement = {
			schema_version: 1,
			lock_id: "10000000-0000-4000-8000-000000000099",
			pid: 99,
			started_at: "2026-08-03T00:00:00.000Z",
		};
		await writeFile(path, JSON.stringify(replacement), { mode: 0o600 });

		await first.release();

		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(replacement);
	});
});

function fixedOptions(id = "10000000-0000-4000-8000-000000000001") {
	return {
		pid: 42,
		id: () => id,
		now: () => new Date("2026-08-03T00:00:00.000Z"),
		isProcessAlive: (pid: number) => pid === 42,
	};
}

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "agentrelay-node-lock-"));
	temporaryDirectories.push(path);
	return path;
}
