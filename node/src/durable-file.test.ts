import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishDurableJsonExclusive, writeDurableJson } from "./durable-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("writeDurableJson", () => {
	it("creates parent directories and a mode-0600 JSON file", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "state", "config.json");

		await writeDurableJson(path, { schema_version: 1, value: "ok" });

		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ schema_version: 1, value: "ok" });
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(await readdir(join(root, "state"))).toEqual(["config.json"]);
	});

	it("creates and persists a nested directory chain before writing the file", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "state", "missions", "active", "journal.json");

		await writeDurableJson(path, { schema_version: 1 });

		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ schema_version: 1 });
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	it("atomically replaces an existing file without leaving temporary siblings", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "config.json");
		await writeFile(path, '{"old":true}\n', { mode: 0o644 });

		await writeDurableJson(path, { old: false, generation: 2 });

		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ old: false, generation: 2 });
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(await readdir(root)).toEqual(["config.json"]);
	});

	it("leaves the previous target untouched when serialization fails", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "config.json");
		await writeFile(path, '{"stable":true}\n', { mode: 0o600 });
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;

		await expect(writeDurableJson(path, cyclic)).rejects.toThrow();

		expect(await readFile(path, "utf8")).toBe('{"stable":true}\n');
		expect(await readdir(root)).toEqual(["config.json"]);
	});

	it("restores exact permissions even when the target was more permissive", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "config.json");
		await writeFile(path, "{}\n", { mode: 0o600 });
		await chmod(path, 0o666);

		await writeDurableJson(path, { protected: true });

		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});
});

describe("publishDurableJsonExclusive", () => {
	it("publishes a complete private file and removes its staging link", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "launch.json");

		await expect(publishDurableJsonExclusive(path, { generation: 1 })).resolves.toBe("created");

		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ generation: 1 });
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(path)).nlink).toBe(1);
		expect(await readdir(root)).toEqual(["launch.json"]);
	});

	it("never replaces an existing publication", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "launch.json");
		await writeFile(path, '{"generation":1}\n', { mode: 0o600 });

		await expect(publishDurableJsonExclusive(path, { generation: 2 })).resolves.toBe("exists");

		expect(await readFile(path, "utf8")).toBe('{"generation":1}\n');
		expect(await readdir(root)).toEqual(["launch.json"]);
	});

	it("converges concurrent publishers on one complete immutable value", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "launch.json");

		const results = await Promise.all([
			publishDurableJsonExclusive(path, { generation: 1, payload: "a".repeat(8_192) }),
			publishDurableJsonExclusive(path, { generation: 2, payload: "b".repeat(8_192) }),
		]);

		expect(results.sort()).toEqual(["created", "exists"]);
		const published = JSON.parse(await readFile(path, "utf8"));
		expect([1, 2]).toContain(published.generation);
		expect(published.payload).toBe(
			published.generation === 1 ? "a".repeat(8_192) : "b".repeat(8_192),
		);
		expect((await stat(path)).nlink).toBe(1);
		expect(await readdir(root)).toEqual(["launch.json"]);
	});
});

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "agentrelay-node-durable-"));
	temporaryDirectories.push(path);
	return path;
}
