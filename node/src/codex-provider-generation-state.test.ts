import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CODEX_PROVIDER_GENERATION_FILE,
	CodexProviderGenerationStore,
} from "./codex-provider-generation-state.js";

const CAPSULE_ID = "10000000-0000-4000-8000-000000000001";
const FIRST_GENERATION = "10000000-0000-4000-8000-000000000002";
const SECOND_GENERATION = "10000000-0000-4000-8000-000000000003";
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("CodexProviderGenerationStore", () => {
	it("persists a bounded lifecycle and preserves its first stop cause", async () => {
		const directory = await temporaryDirectory();
		const times = [
			"2026-08-17T00:00:00.000Z",
			"2026-08-17T00:00:01.000Z",
			"2026-08-17T00:00:02.000Z",
			"2026-08-17T00:00:03.000Z",
			"2026-08-17T00:00:04.000Z",
		];
		const store = await CodexProviderGenerationStore.open(
			directory,
			CAPSULE_ID,
			() => new Date(times.shift()!),
		);

		await store.begin(FIRST_GENERATION);
		await store.markRunning(FIRST_GENERATION);
		await store.recordHeartbeat(FIRST_GENERATION);
		await store.requestStop(FIRST_GENERATION, "deadline_exceeded");
		await store.markQuiescent(FIRST_GENERATION, "provider_failure", "stopped");

		expect(await store.snapshot()).toEqual({
			schema_version: 1,
			capsule_id: CAPSULE_ID,
			generation_id: FIRST_GENERATION,
			phase: "quiescent",
			started_at: "2026-08-17T00:00:00.000Z",
			updated_at: "2026-08-17T00:00:04.000Z",
			last_heartbeat_at: "2026-08-17T00:00:02.000Z",
			stop_cause: "deadline_exceeded",
			observation: "stopped",
		});
		const decoded = JSON.parse(
			await readFile(join(directory, CODEX_PROVIDER_GENERATION_FILE), "utf8"),
		);
		expect(JSON.stringify(decoded)).not.toContain("provider_pid");
		expect(JSON.stringify(decoded)).not.toContain(directory);
	});

	it("admits a replacement only after durable quiescence", async () => {
		const directory = await temporaryDirectory();
		const first = await CodexProviderGenerationStore.open(directory, CAPSULE_ID);
		await first.begin(FIRST_GENERATION);

		const replacement = await CodexProviderGenerationStore.open(directory, CAPSULE_ID);
		await expect(replacement.begin(SECOND_GENERATION)).rejects.toThrow(
			"Previous Codex provider generation is not durably quiescent",
		);

		await first.markQuiescent(FIRST_GENERATION, "owner_lost", "stopped");
		await expect(replacement.begin(SECOND_GENERATION)).resolves.toMatchObject({
			generation_id: SECOND_GENERATION,
			phase: "spawn_maybe_started",
		});
	});

	it("fails closed on malformed or non-private lifecycle state", async () => {
		const malformedDirectory = await temporaryDirectory();
		const malformedPath = join(malformedDirectory, CODEX_PROVIDER_GENERATION_FILE);
		await writeFile(malformedPath, "not-json", { mode: 0o600 });
		const malformed = await CodexProviderGenerationStore.open(malformedDirectory, CAPSULE_ID);
		await expect(malformed.begin(FIRST_GENERATION)).rejects.toBeDefined();

		const publicDirectory = await temporaryDirectory();
		const publicPath = join(publicDirectory, CODEX_PROVIDER_GENERATION_FILE);
		await writeFile(publicPath, "{}", { mode: 0o644 });
		const publicState = await CodexProviderGenerationStore.open(publicDirectory, CAPSULE_ID);
		await expect(publicState.snapshot()).rejects.toThrow("mode 0600");
		await chmod(publicPath, 0o600);
	});
});

async function temporaryDirectory(): Promise<string> {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-provider-state-")));
	directories.push(directory);
	return directory;
}
