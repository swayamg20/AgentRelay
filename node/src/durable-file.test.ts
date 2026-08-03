import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeDurableJson } from "./durable-file.js";

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

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "agentrelay-node-durable-"));
	temporaryDirectories.push(path);
	return path;
}
