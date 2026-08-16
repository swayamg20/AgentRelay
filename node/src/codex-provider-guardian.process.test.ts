import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
const owners: ChildProcess[] = [];

afterEach(async () => {
	for (const owner of owners.splice(0)) {
		if (owner.exitCode !== null || owner.signalCode !== null) continue;
		owner.kill("SIGCONT");
		owner.kill("SIGKILL");
		await Promise.race([childClose(owner), delay(2_000)]);
	}
	await Promise.all(fixtures.splice(0).map((fixture) => fixture.remove()));
});

describe.runIf(process.platform !== "win32")("Codex provider guardian owner death", () => {
	it("kills the provider tree when its Capsule owner is SIGKILLed", async () => {
		const fixture = await fakeAppServer({ spawnDescendant: true, ignoreSigterm: true });
		const owner = startOwner(fixture);
		await waitForOwner(fixture);
		const descendantPid = await waitForPid(fixture.childPidPath);

		owner.kill("SIGKILL");
		await childClose(owner);
		await expect(createGuardian(fixture).openGeneration()).rejects.toMatchObject({
			reason: "ownership",
		});
		await waitForProcessExit(descendantPid, 5_000);
		await expect
			.poll(() => generationState(fixture))
			.toMatchObject({
				phase: "quiescent",
				stop_cause: "owner_lost",
				observation: "stopped",
			});

		const replacement = await createGuardian(fixture).openGeneration();
		await replacement.terminate("capsule_shutdown");
	}, 10_000);

	it("revokes provider authority when the Capsule heartbeat stalls", async () => {
		const fixture = await fakeAppServer({ spawnDescendant: true });
		const owner = startOwner(fixture);
		await waitForOwner(fixture);
		const descendantPid = await waitForPid(fixture.childPidPath);

		owner.kill("SIGSTOP");
		await waitForProcessExit(descendantPid);
		await expect
			.poll(() => generationState(fixture))
			.toMatchObject({
				phase: "quiescent",
				stop_cause: "heartbeat_timeout",
				observation: "unresponsive",
			});
		await expect(createGuardian(fixture).openGeneration()).rejects.toMatchObject({
			reason: "ownership",
		});

		owner.kill("SIGKILL");
		await childClose(owner);
		const replacement = await createGuardian(fixture).openGeneration();
		await replacement.terminate("capsule_shutdown");
	});

	it.runIf(process.platform === "linux")(
		"kills remaining descendants when the guardian itself is SIGKILLed",
		async () => {
			const fixture = await fakeAppServer({ spawnDescendant: true });
			const owner = startOwner(fixture);
			await waitForOwner(fixture);
			const descendantPid = await waitForPid(fixture.childPidPath);
			const guardianPid = await directChildPid(owner.pid!);

			process.kill(guardianPid, "SIGKILL");
			await waitForProcessExit(descendantPid);
			await expect
				.poll(() => generationState(fixture))
				.toMatchObject({
					phase: "quiescent",
					stop_cause: "provider_failure",
					observation: "crashed",
				});

			const replacement = await createGuardian(fixture).openGeneration();
			await replacement.terminate("capsule_shutdown");
			owner.kill("SIGKILL");
			await childClose(owner);
		},
	);
});

function startOwner(fixture: FakeAppServerFixture): ChildProcess {
	const owner = spawn(
		process.execPath,
		[
			"--import",
			createRequire(import.meta.url).resolve("tsx"),
			fileURLToPath(new URL("../test-support/codex-guardian-owner-worker.ts", import.meta.url)),
		],
		{
			cwd: fixture.directory,
			env: {
				PATH: process.env.PATH,
				TMPDIR: process.env.TMPDIR,
				LANG: process.env.LANG,
				TZ: process.env.TZ,
				AGENTRELAY_TEST_CAPSULE_ID: CAPSULE_ID,
				AGENTRELAY_TEST_CAPSULE_DIRECTORY: fixture.directory,
				AGENTRELAY_TEST_CODEX_BIN: fixture.scriptPath,
				AGENTRELAY_TEST_READY_PATH: join(fixture.directory, "owner-ready.json"),
				AGENTRELAY_NODE_TOKEN: "owner-death-token-canary",
				OPENAI_API_KEY: "owner-death-openai-canary",
			},
			stdio: "ignore",
		},
	);
	owners.push(owner);
	return owner;
}

async function waitForOwner(fixture: FakeAppServerFixture): Promise<void> {
	const path = join(fixture.directory, "owner-ready.json");
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const ready = await readFile(path, "utf8").catch(() => "");
		if (ready !== "") return;
		await delay(10);
	}
	throw new Error("Timed out waiting for the guardian owner worker");
}

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

async function generationState(
	fixture: FakeAppServerFixture,
): Promise<CodexProviderGenerationState> {
	return JSON.parse(
		await readFile(join(fixture.directory, CODEX_PROVIDER_GENERATION_FILE), "utf8"),
	) as CodexProviderGenerationState;
}

async function fakeAppServer(
	options: Parameters<typeof createFakeAppServer>[0] = {},
): Promise<FakeAppServerFixture> {
	const fixture = await createFakeAppServer(options);
	fixtures.push(fixture);
	return fixture;
}

function childClose(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.once("close", () => resolve()));
}

async function directChildPid(ownerPid: number): Promise<number> {
	const path = `/proc/${ownerPid}/task/${ownerPid}/children`;
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const children = (await readFile(path, "utf8")).trim().split(/\s+/).filter(Boolean).map(Number);
		if (children.length === 1 && Number.isInteger(children[0])) return children[0]!;
		await delay(10);
	}
	throw new Error("Could not identify the direct guardian child");
}
