import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { directCodexProcessBoundaryForTests } from "../test-support/direct-codex-process-boundary.js";
import {
	type FakeAppServerFixture,
	createFakeAppServer,
	waitForPid,
	waitForProcessExit,
} from "../test-support/fake-codex-app-server.js";
import {
	CODEX_PROVIDER_GENERATION_FILE,
	type CodexProviderGenerationState,
} from "./codex-provider-generation-state.js";
import { SupervisedCodexProviderGuardian } from "./codex-provider-guardian.js";
import type { CodexSupervisorCommand } from "./codex-supervised-process.js";

const CAPSULE_ID = "10000000-0000-4000-8000-000000000001";
const fixtures: FakeAppServerFixture[] = [];

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((fixture) => fixture.remove()));
});

describe("SupervisedCodexProviderGuardian", () => {
	it("owns one real provider process lifecycle and records redacted quiescence", async () => {
		const fixture = await fakeAppServer();
		const guardian = createGuardian(fixture);
		const generation = await guardian.openGeneration();

		expect(await generation.client.startThread()).toMatchObject({
			thread: { id: "thread-1" },
		});
		await generation.terminate("capsule_shutdown");
		await expect(generation.termination).resolves.toEqual({ kind: "stopped" });

		const state = await generationState(fixture);
		expect(state).toMatchObject({
			generation_id: generation.generationId,
			phase: "quiescent",
			stop_cause: "capsule_shutdown",
			observation: "stopped",
		});
		const serialized = JSON.stringify(state);
		expect(serialized).not.toContain(fixture.directory);
		expect(serialized).not.toContain("pid");
		expect(serialized).not.toContain("OPENAI_API_KEY");
	});

	it("allows only one concurrent generation owner", async () => {
		const fixture = await fakeAppServer();
		const first = await createGuardian(fixture).openGeneration();

		await expect(createGuardian(fixture).openGeneration()).rejects.toMatchObject({
			name: "CodexProviderGuardianError",
			reason: "ownership",
			message: "Codex provider generation ownership is unavailable",
		});

		await first.terminate("capsule_shutdown");
		const replacement = await createGuardian(fixture).openGeneration();
		expect(replacement.generationId).not.toBe(first.generationId);
		await replacement.terminate("capsule_shutdown");
	});

	it("kills provider descendants when authority is revoked", async () => {
		const fixture = await fakeAppServer({ spawnDescendant: true });
		const generation = await createGuardian(fixture).openGeneration();
		const descendantPid = await waitForPid(fixture.childPidPath);

		await generation.terminate("authority_revoked");
		await waitForProcessExit(descendantPid);
		expect(await generation.termination).toEqual({ kind: "stopped" });
		expect(await generationState(fixture)).toMatchObject({
			stop_cause: "authority_revoked",
			phase: "quiescent",
		});
	});

	it("classifies an unexpected provider exit and leaves no reusable authority", async () => {
		const fixture = await fakeAppServer({ exitAfterRead: true });
		const generation = await createGuardian(fixture).openGeneration();

		await expect(generation.client.readThread("thread-1")).resolves.toMatchObject({
			id: "thread-1",
		});
		await expect(generation.termination).resolves.toEqual({ kind: "crashed" });
		expect(await generationState(fixture)).toMatchObject({
			phase: "quiescent",
			stop_cause: "provider_failure",
			observation: "crashed",
		});
	});
});

function createGuardian(fixture: FakeAppServerFixture): SupervisedCodexProviderGuardian {
	return new SupervisedCodexProviderGuardian({
		capsuleId: CAPSULE_ID,
		command: { executable: fixture.scriptPath },
		cwd: fixture.directory,
		capsuleDirectory: fixture.directory,
		env: fixture.env,
		boundary: directCodexProcessBoundaryForTests,
		supervisor: sourceSupervisorCommand(),
		startupTimeoutMs: 5_000,
		heartbeatIntervalMs: 50,
		heartbeatTimeoutMs: 500,
		heartbeatRecordMs: 100,
	});
}

function sourceSupervisorCommand(): CodexSupervisorCommand {
	return {
		executable: process.execPath,
		args: [
			"--import",
			createRequire(import.meta.url).resolve("tsx"),
			fileURLToPath(new URL("./bin/agentrelay-codex-guardian.ts", import.meta.url)),
		],
	};
}

async function fakeAppServer(
	options: Parameters<typeof createFakeAppServer>[0] = {},
): Promise<FakeAppServerFixture> {
	const fixture = await createFakeAppServer(options);
	fixtures.push(fixture);
	return fixture;
}

async function generationState(
	fixture: FakeAppServerFixture,
): Promise<CodexProviderGenerationState> {
	return JSON.parse(
		await readFile(`${fixture.directory}/${CODEX_PROVIDER_GENERATION_FILE}`, "utf8"),
	) as CodexProviderGenerationState;
}
