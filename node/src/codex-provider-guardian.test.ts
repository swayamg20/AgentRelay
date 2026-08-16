import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { directCodexProcessBoundaryForTests } from "../test-support/direct-codex-process-boundary.js";
import {
	type FakeAppServerFixture,
	createFakeAppServer,
	waitForEnvironment,
	waitForPid,
	waitForProcessExit,
} from "../test-support/fake-codex-app-server.js";
import type { CodexProviderGeneration } from "./codex-capsule-runner-contract.js";
import {
	CODEX_PROVIDER_GENERATION_FILE,
	type CodexProviderGenerationState,
} from "./codex-provider-generation-state.js";
import {
	type CodexProviderGuardianOptions,
	SupervisedCodexProviderGuardian,
} from "./codex-provider-guardian.js";
import type { CodexSupervisorCommand } from "./codex-supervised-process.js";

const CAPSULE_ID = "10000000-0000-4000-8000-000000000001";
const fixtures: FakeAppServerFixture[] = [];
const generations: CodexProviderGeneration[] = [];

afterEach(async () => {
	await Promise.allSettled(
		generations.splice(0).map((generation) => generation.terminate("capsule_shutdown")),
	);
	await Promise.all(fixtures.splice(0).map((fixture) => fixture.remove()));
});

describe("SupervisedCodexProviderGuardian", () => {
	it("owns one OS provider process lifecycle and records redacted quiescence", async () => {
		const fixture = await fakeAppServer();
		const generation = await openGeneration(fixture);

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
		const providerEnvironment = await waitForEnvironment(fixture.environmentPath);
		expect(providerEnvironment).not.toHaveProperty("AGENTRELAY_NODE_TOKEN");
		expect(providerEnvironment).not.toHaveProperty("OPENAI_API_KEY");
		expect(providerEnvironment).not.toHaveProperty("CODEX_API_KEY");
	});

	it("allows only one concurrent generation owner across guardian instances", async () => {
		const fixture = await fakeAppServer();
		const contenders = await Promise.allSettled([
			createGuardian(fixture).openGeneration(),
			createGuardian(fixture).openGeneration(),
		]);
		const admitted = contenders.filter(
			(result): result is PromiseFulfilledResult<CodexProviderGeneration> =>
				result.status === "fulfilled",
		);
		const rejected = contenders.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		expect(admitted).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(rejected[0]?.reason).toMatchObject({
			name: "CodexProviderGuardianError",
			reason: "ownership",
			message: "Codex provider generation ownership is unavailable",
		});
		const first = admitted[0]!.value;
		generations.push(first);

		await first.terminate("capsule_shutdown");
		const replacement = await openGeneration(fixture);
		expect(replacement.generationId).not.toBe(first.generationId);
		await replacement.terminate("capsule_shutdown");
	});

	it("rejects a second open while the same guardian is still opening", async () => {
		const fixture = await fakeAppServer();
		const guardian = createGuardian(fixture);
		const firstOpening = guardian.openGeneration();

		await expect(guardian.openGeneration()).rejects.toMatchObject({
			reason: "ownership",
		});
		const generation = await firstOpening;
		generations.push(generation);
	});

	it("kills provider descendants when authority is revoked", async () => {
		const fixture = await fakeAppServer({ spawnDescendant: true, ignoreSigterm: true });
		const authority = new AbortController();
		const generation = await openGeneration(fixture, { authoritySignal: authority.signal });
		const descendantPid = await waitForPid(fixture.childPidPath);

		authority.abort();
		await generation.termination;
		await waitForProcessExit(descendantPid, 5_000);
		expect(await generation.termination).toEqual({ kind: "stopped" });
		expect(await generationState(fixture)).toMatchObject({
			stop_cause: "authority_revoked",
			phase: "quiescent",
		});
	});

	it("enforces its absolute deadline against an unresponsive provider tree", async () => {
		const fixture = await fakeAppServer({ spawnDescendant: true, ignoreSigterm: true });
		const generation = await openGeneration(fixture, { deadlineAtMs: Date.now() + 1_000 });
		const descendantPid = await waitForPid(fixture.childPidPath);

		await expect(generation.termination).resolves.toEqual({ kind: "unresponsive" });
		await waitForProcessExit(descendantPid, 5_000);
		expect(await generationState(fixture)).toMatchObject({
			phase: "quiescent",
			stop_cause: "deadline_exceeded",
			observation: "unresponsive",
		});
	}, 8_000);

	it("classifies an unresponsive provider request and tears down its authority", async () => {
		const fixture = await fakeAppServer({ ignoreRead: true });
		const generation = await openGeneration(fixture, { requestTimeoutMs: 100 });

		await expect(generation.client.readThread("thread-1")).rejects.toThrow(
			"Timed out waiting for Codex app-server method thread/read",
		);
		await expect(generation.termination).resolves.toEqual({ kind: "unresponsive" });
		expect(await generationState(fixture)).toMatchObject({
			phase: "quiescent",
			stop_cause: "provider_unresponsive",
			observation: "unresponsive",
		});
	});

	it("classifies an unexpected provider exit and leaves no reusable authority", async () => {
		const fixture = await fakeAppServer({ exitAfterRead: true });
		const generation = await openGeneration(fixture);

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

	it("redacts startup failure details and durably closes the generation", async () => {
		const fixture = await fakeAppServer({ version: "0.0.0-secret-path" });

		await expect(createGuardian(fixture).openGeneration()).rejects.toMatchObject({
			name: "CodexProviderGuardianError",
			reason: "startup",
			message: "Codex provider generation failed to start",
		});
		const state = await generationState(fixture);
		expect(state).toMatchObject({
			phase: "quiescent",
			stop_cause: "startup_failure",
			observation: "crashed",
		});
		expect(JSON.stringify(state)).not.toContain(fixture.directory);
	});
});

type GuardianOverrides = Partial<
	Pick<CodexProviderGuardianOptions, "authoritySignal" | "deadlineAtMs" | "requestTimeoutMs">
>;

function createGuardian(
	fixture: FakeAppServerFixture,
	overrides: GuardianOverrides = {},
): SupervisedCodexProviderGuardian {
	return new SupervisedCodexProviderGuardian({
		capsuleId: CAPSULE_ID,
		command: { executable: fixture.scriptPath },
		cwd: fixture.directory,
		capsuleDirectory: fixture.directory,
		env: fixture.env,
		boundary: directCodexProcessBoundaryForTests,
		deadlineAtMs: Date.now() + 60_000,
		supervisor: sourceSupervisorCommand(),
		startupTimeoutMs: 5_000,
		heartbeatIntervalMs: 50,
		heartbeatTimeoutMs: 500,
		heartbeatRecordMs: 100,
		...overrides,
	});
}

async function openGeneration(
	fixture: FakeAppServerFixture,
	overrides: GuardianOverrides = {},
): Promise<CodexProviderGeneration> {
	const generation = await createGuardian(fixture, overrides).openGeneration();
	generations.push(generation);
	return generation;
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
