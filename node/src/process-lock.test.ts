import { renameSync, writeFileSync } from "node:fs";
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { kernelFileLock } from "./kernel-file-lock.js";
import { PROVIDER_GENERATION_LOCK_KIND, acquireProcessLock } from "./process-lock.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("acquireProcessLock", () => {
	it("keeps one private kernel-lock inode across release and reacquisition", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "run.lock");
		const ownerPath = join(root, "run.owner.json");
		const first = await acquireProcessLock(
			path,
			fixedOptions("10000000-0000-4000-8000-000000000001"),
		);
		const firstStats = await stat(path);

		expect(firstStats.mode & 0o777).toBe(0o600);
		expect((await stat(root)).mode & 0o777).toBe(0o700);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			schema_version: 2,
			kind: "agentrelay_node_kernel_lock",
		});
		expect(JSON.parse(await readFile(ownerPath, "utf8"))).toEqual({
			schema_version: 2,
			lock_id: "10000000-0000-4000-8000-000000000001",
			pid: 42,
			started_at: "2026-08-03T00:00:00.000Z",
		});
		expect((await stat(ownerPath)).mode & 0o777).toBe(0o600);

		await expect(
			acquireProcessLock(path, fixedOptions("10000000-0000-4000-8000-000000000002")),
		).rejects.toMatchObject({
			name: "ProcessLockError",
			reason: "already_running",
			owner: { pid: 42 },
			message: expect.stringContaining("last reported owner PID 42"),
		});

		await first.release();
		await first.release();
		const second = await acquireProcessLock(
			path,
			fixedOptions("10000000-0000-4000-8000-000000000002"),
		);
		expect((await stat(path)).ino).toBe(firstStats.ino);
		await second.release();
	});

	it("uses malformed owner metadata only as unavailable diagnostics", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "run.lock");
		const first = await acquireProcessLock(path, fixedOptions());
		await writeFile(join(root, "run.owner.json"), "not-json", { mode: 0o600 });

		await expect(acquireProcessLock(path, fixedOptions())).rejects.toMatchObject({
			name: "ProcessLockError",
			reason: "already_running",
			owner: undefined,
			message: expect.stringContaining("owner diagnostics are unavailable"),
		});

		await first.release();
	});

	it("keeps provider generation ownership distinct from Node ownership", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "provider.lock");
		const provider = await acquireProcessLock(path, {
			...fixedOptions(),
			kind: PROVIDER_GENERATION_LOCK_KIND,
		});

		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			schema_version: 2,
			kind: PROVIDER_GENERATION_LOCK_KIND,
		});
		expect(provider.inheritFileDescriptor()).toBeGreaterThanOrEqual(0);
		await expect(acquireProcessLock(path, fixedOptions())).rejects.toMatchObject({
			name: "ProcessLockError",
			reason: "invalid_lock",
		});

		await provider.release();
		expect(() => provider.inheritFileDescriptor()).toThrow("already releasing");
	});

	it("fails closed on schema-1 ownership even when its PID appears absent", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "run.lock");
		const legacy = legacyMetadata(999_999_999);
		await writeFile(path, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

		await expect(acquireProcessLock(path, fixedOptions())).rejects.toMatchObject({
			name: "ProcessLockError",
			reason: "invalid_lock",
			owner: legacy,
			message: expect.stringContaining("cannot be reclaimed safely from PID metadata"),
		});
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(legacy);
	});

	it("finishes an interrupted schema-2 hard-link publication", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "run.lock");
		const initial = await acquireProcessLock(path, fixedOptions());
		await initial.release();
		const temporaryAlias = join(root, ".run.lock.999.10000000-0000-4000-8000-000000000001.tmp");
		await link(path, temporaryAlias);

		const recovered = await acquireProcessLock(path, fixedOptions());
		expect((await stat(path)).nlink).toBe(1);
		await expect(stat(temporaryAlias)).rejects.toMatchObject({ code: "ENOENT" });
		await recovered.release();
	});

	it("fails closed on an unknown extra link to the schema-2 inode", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "run.lock");
		const initial = await acquireProcessLock(path, fixedOptions());
		await initial.release();
		await link(path, join(root, "unknown-alias.lock"));

		await expect(acquireProcessLock(path, fixedOptions())).rejects.toMatchObject({
			name: "ProcessLockError",
			reason: "invalid_lock",
			message: expect.stringContaining("exactly one filesystem link"),
		});
	});

	it("fails closed if the stable path is replaced after native lock acquisition", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "run.lock");
		const movedPath = join(root, "moved.lock");
		const initial = await acquireProcessLock(path, fixedOptions());
		await initial.release();

		await expect(
			acquireProcessLock(path, {
				...fixedOptions(),
				kernelLock: {
					tryLock: (fileDescriptor) => {
						const acquired = kernelFileLock.tryLock(fileDescriptor);
						if (!acquired) return false;
						renameSync(path, movedPath);
						writeFileSync(
							path,
							`${JSON.stringify({ schema_version: 2, kind: "agentrelay_node_kernel_lock" })}\n`,
							{ mode: 0o600 },
						);
						return true;
					},
					unlock: (fileDescriptor) => kernelFileLock.unlock(fileDescriptor),
				},
			}),
		).rejects.toMatchObject({
			name: "ProcessLockError",
			reason: "invalid_lock",
			message: expect.stringContaining("path changed"),
		});

		const recovered = await acquireProcessLock(path, fixedOptions());
		await recovered.release();
	});

	it("fails closed on malformed, linked, or insecure lock state", async () => {
		const malformedRoot = await temporaryDirectory();
		const malformedPath = join(malformedRoot, "run.lock");
		await writeFile(malformedPath, "not-json", { mode: 0o600 });
		await expect(acquireProcessLock(malformedPath, fixedOptions())).rejects.toMatchObject({
			reason: "invalid_lock",
		});

		const symlinkRoot = await temporaryDirectory();
		const target = join(symlinkRoot, "target.lock");
		const symlinkPath = join(symlinkRoot, "run.lock");
		await writeFile(target, JSON.stringify(legacyMetadata(999)), { mode: 0o600 });
		await symlink(target, symlinkPath);
		await expect(acquireProcessLock(symlinkPath, fixedOptions())).rejects.toMatchObject({
			reason: "invalid_lock",
		});

		const modeRoot = await temporaryDirectory();
		const modePath = join(modeRoot, "run.lock");
		await writeFile(modePath, JSON.stringify(legacyMetadata(999)), { mode: 0o644 });
		await expect(acquireProcessLock(modePath, fixedOptions())).rejects.toMatchObject({
			reason: "invalid_lock",
		});

		const publicRoot = await temporaryDirectory();
		await chmod(publicRoot, 0o755);
		await expect(
			acquireProcessLock(join(publicRoot, "run.lock"), fixedOptions()),
		).rejects.toMatchObject({ reason: "invalid_lock" });
		await chmod(publicRoot, 0o700);

		const directoryRoot = await temporaryDirectory();
		const directoryPath = join(directoryRoot, "run.lock");
		await mkdir(directoryPath, { mode: 0o700 });
		await expect(acquireProcessLock(directoryPath, fixedOptions())).rejects.toMatchObject({
			reason: "invalid_lock",
		});
	});

	it("releases the descriptor when the native lock primitive fails", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "run.lock");

		await expect(
			acquireProcessLock(path, {
				...fixedOptions(),
				kernelLock: {
					tryLock: () => {
						throw new Error("unsupported kernel primitive");
					},
					unlock: () => undefined,
				},
			}),
		).rejects.toMatchObject({
			name: "ProcessLockError",
			reason: "unavailable",
		});

		const lock = await acquireProcessLock(path, fixedOptions());
		await lock.release();
	});

	it("closes the descriptor even if explicit unlock fails", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "run.lock");
		const lock = await acquireProcessLock(path, {
			...fixedOptions(),
			kernelLock: {
				tryLock: (fileDescriptor) => kernelFileLock.tryLock(fileDescriptor),
				unlock: () => {
					throw new Error("unlock failed");
				},
			},
		});

		const firstRelease = lock.release();
		expect(lock.release()).toBe(firstRelease);
		await expect(firstRelease).rejects.toThrow("unlock failed");

		const next = await acquireProcessLock(path, fixedOptions());
		await next.release();
	});

	it("releases the kernel lock if durable owner diagnostics cannot be written", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "run.lock");
		const ownerPath = join(root, "run.owner.json");
		await mkdir(ownerPath, { mode: 0o700 });

		await expect(acquireProcessLock(path, fixedOptions())).rejects.toMatchObject({
			name: "ProcessLockError",
			reason: "unavailable",
			message: expect.stringContaining("owner diagnostics"),
		});

		const { rm } = await import("node:fs/promises");
		await rm(ownerPath, { recursive: true });
		const lock = await acquireProcessLock(path, fixedOptions());
		await lock.release();
	});
});

function fixedOptions(id = "10000000-0000-4000-8000-000000000001") {
	return {
		pid: 42,
		id: () => id,
		now: () => new Date("2026-08-03T00:00:00.000Z"),
	};
}

function legacyMetadata(pid: number) {
	return {
		schema_version: 1,
		lock_id: "10000000-0000-4000-8000-000000000001",
		pid,
		started_at: "2026-08-03T00:00:00.000Z",
	};
}

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "agentrelay-node-lock-"));
	const canonicalPath = await realpath(path);
	temporaryDirectories.push(canonicalPath);
	return canonicalPath;
}
