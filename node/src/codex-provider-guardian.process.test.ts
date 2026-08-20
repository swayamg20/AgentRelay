import { type ChildProcess, spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { directCodexProcessBoundaryForTests } from "../test-support/direct-codex-process-boundary.js";
import {
	type FakeAppServerFixture,
	createFakeAppServer,
	isProcessAlive,
	waitForPid,
	waitForProcessExit,
} from "../test-support/fake-codex-app-server.js";
import { createFakeCodexOwnerCredential } from "../test-support/fake-codex-owner-credential.js";
import type { CodexProviderGeneration } from "./codex-capsule-runner-contract.js";
import {
	CODEX_PROVIDER_GENERATION_FILE,
	type CodexProviderGenerationState,
} from "./codex-provider-generation-state.js";
import {
	CodexProviderGuardianError,
	SupervisedCodexProviderGuardian,
} from "./codex-provider-guardian.js";
import type { CodexSupervisorCommand } from "./codex-supervised-process.js";

const CAPSULE_ID = "10000000-0000-4000-8000-000000000001";
const GUARDIAN_TEST_TIMEOUT_MS = 30_000;
const fixtures: FakeAppServerFixture[] = [];
const owners: ChildProcess[] = [];
const generations: CodexProviderGeneration[] = [];
const failClosedReapers = new Set<number>();

afterEach(async () => {
	for (const owner of owners.splice(0)) {
		if (owner.exitCode !== null || owner.signalCode !== null) continue;
		owner.kill("SIGCONT");
		owner.kill("SIGKILL");
		await Promise.race([childClose(owner), delay(2_000)]);
	}
	await Promise.allSettled(
		generations.splice(0).map((generation) => generation.terminate("capsule_shutdown")),
	);
	await Promise.all([...failClosedReapers].map(stopFailClosedReaper));
	await Promise.all(fixtures.splice(0).map((fixture) => fixture.remove()));
});

describe.runIf(process.platform !== "win32")("Codex provider guardian owner death", () => {
	it(
		"leaves no durable start barrier when its owner dies before guardian spawn",
		async () => {
			const fixture = await fakeAppServer();
			const prepareStartedPath = join(fixture.directory, "prepare-started");
			const owner = startOwner(fixture, { prepareDelayMs: 5_000, prepareStartedPath });
			await waitForFile(prepareStartedPath);

			owner.kill("SIGKILL");
			await childClose(owner);
			await expect(
				readFile(join(fixture.directory, CODEX_PROVIDER_GENERATION_FILE), "utf8"),
			).rejects.toMatchObject({ code: "ENOENT" });
			const replacement = await openGenerationWhenAvailable(fixture);
			await replacement.terminate("capsule_shutdown");
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

	it(
		"records owner loss when death races the version probe",
		async () => {
			const fixture = await fakeAppServer({ versionDelayMs: 1_000 });
			const owner = startOwner(fixture);
			await expect
				.poll(() => generationState(fixture), { timeout: 5_000 })
				.toMatchObject({ phase: "spawn_maybe_started" });

			owner.kill("SIGKILL");
			await childClose(owner);
			await expect
				.poll(() => generationState(fixture), { timeout: 5_000 })
				.toMatchObject({
					phase: "quiescent",
					stop_cause: "owner_lost",
					observation: "stopped",
				});
			const replacement = await openGenerationWhenAvailable(fixture);
			await replacement.terminate("capsule_shutdown");
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

	it(
		"records owner loss when provider EOF races IPC disconnect after readiness",
		async () => {
			const fixture = await fakeAppServer();
			const owner = startOwner(fixture);
			await waitForOwner(fixture);

			owner.kill("SIGKILL");
			await childClose(owner);
			await expect
				.poll(() => generationState(fixture), { timeout: 5_000 })
				.toMatchObject({
					phase: "quiescent",
					stop_cause: "owner_lost",
					observation: "stopped",
				});

			const replacement = await openGenerationWhenAvailable(fixture);
			await replacement.terminate("capsule_shutdown");
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

	it(
		"kills the provider tree when its Capsule owner is SIGKILLed",
		async () => {
			const fixture = await fakeAppServer({
				spawnDescendant: true,
				ignoreSigterm: true,
				continuousOutput: true,
				gateContinuousOutput: true,
			});
			const owner = startOwner(fixture);
			await waitForOwner(fixture);
			const descendantPid = await waitForPid(fixture.childPidPath);

			owner.kill("SIGKILL");
			await childClose(owner);
			await writeFile(fixture.continuousOutputGatePath, "go", { mode: 0o600 });
			await expect(createGuardian(fixture).openGeneration()).rejects.toMatchObject({
				reason: "ownership",
			});
			await waitForProcessExit(descendantPid, 5_000);
			await expect
				.poll(() => generationState(fixture), { timeout: 5_000 })
				.toMatchObject({
					phase: "quiescent",
					stop_cause: "owner_lost",
					observation: "stopped",
				});

			const replacement = await openGenerationWhenAvailable(fixture);
			await replacement.terminate("capsule_shutdown");
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

	it(
		"revokes provider authority when the Capsule heartbeat stalls",
		async () => {
			const fixture = await fakeAppServer({ spawnDescendant: true });
			const owner = startOwner(fixture);
			await waitForOwner(fixture);
			const descendantPid = await waitForPid(fixture.childPidPath);

			owner.kill("SIGSTOP");
			await waitForProcessExit(descendantPid, 5_000);
			await expect
				.poll(() => generationState(fixture))
				.toMatchObject({
					phase: "stop_requested",
					stop_cause: "heartbeat_timeout",
					observation: null,
				});
			await expect(createGuardian(fixture).openGeneration()).rejects.toMatchObject({
				reason: "ownership",
			});

			owner.kill("SIGCONT");
			await expect
				.poll(() => generationState(fixture), { timeout: 15_000 })
				.toMatchObject({
					phase: "quiescent",
					stop_cause: "heartbeat_timeout",
					observation: "unresponsive",
				});
			owner.kill("SIGKILL");
			await childClose(owner);
			const replacement = await openGenerationWhenAvailable(fixture);
			await replacement.terminate("capsule_shutdown");
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

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
				.poll(() => generationState(fixture), { timeout: 5_000 })
				.toMatchObject({
					phase: "quiescent",
					stop_cause: "provider_failure",
					observation: "crashed",
				});

			const replacement = await openGenerationWhenAvailable(fixture);
			await replacement.terminate("capsule_shutdown");
			owner.kill("SIGKILL");
			await childClose(owner);
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

	it.runIf(process.platform === "linux")(
		"uses the teardown witness when Capsule and guardian die together",
		async () => {
			const fixture = await fakeAppServer({ spawnDescendant: true, ignoreSigterm: true });
			const owner = startOwner(fixture);
			await waitForOwner(fixture);
			const descendantPid = await waitForPid(fixture.childPidPath);
			const guardianPid = await directChildPid(owner.pid!);

			owner.kill("SIGSTOP");
			await waitForStoppedProcess(owner.pid!);
			process.kill(guardianPid, "SIGKILL");
			owner.kill("SIGKILL");
			await childClose(owner);
			await expect(createGuardian(fixture).openGeneration()).rejects.toMatchObject({
				reason: "ownership",
			});
			await waitForProcessExit(descendantPid, 5_000);
			await expect
				.poll(() => generationState(fixture), { timeout: 5_000 })
				.toMatchObject({
					phase: "quiescent",
					stop_cause: "provider_failure",
					observation: "crashed",
				});

			const replacement = await openGenerationWhenAvailable(fixture);
			await replacement.terminate("capsule_shutdown");
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

	it.runIf(process.platform === "linux")(
		"retains ownership when durable generation state disappears after startup",
		async () => {
			await expectCorruptedStateToFailClosed("missing");
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

	it.runIf(process.platform === "linux")(
		"retains ownership when durable generation identity changes after startup",
		async () => {
			await expectCorruptedStateToFailClosed("replaced");
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);
});

async function expectCorruptedStateToFailClosed(mode: "missing" | "replaced"): Promise<void> {
	const fixture = await fakeAppServer({ spawnDescendant: true });
	const owner = startOwner(fixture);
	await waitForOwner(fixture);
	const guardianPid = await directChildPid(owner.pid!);
	const reaperPid = await childPidContaining(guardianPid, "--reaper");
	failClosedReapers.add(reaperPid);

	owner.kill("SIGSTOP");
	await waitForStoppedProcess(owner.pid!);
	await corruptGenerationState(fixture, mode);
	owner.kill("SIGKILL");
	await childClose(owner);
	await waitForProcessExit(guardianPid, 5_000);

	await expect(createGuardian(fixture).openGeneration()).rejects.toMatchObject({
		reason: "ownership",
	});
	expect(isProcessAlive(reaperPid)).toBe(true);

	await stopFailClosedReaper(reaperPid);
	const replacement = await openGenerationWhenAvailable(fixture);
	await replacement.terminate("capsule_shutdown");
}

async function corruptGenerationState(
	fixture: FakeAppServerFixture,
	mode: "missing" | "replaced",
): Promise<void> {
	const path = join(fixture.directory, CODEX_PROVIDER_GENERATION_FILE);
	if (mode === "missing") {
		await rm(path);
		return;
	}
	const state = JSON.parse(await readFile(path, "utf8")) as CodexProviderGenerationState;
	await writeFile(
		path,
		`${JSON.stringify({
			...state,
			generation_id: "10000000-0000-4000-8000-000000000099",
			phase: "quiescent",
			stop_cause: "owner_lost",
			observation: "stopped",
		})}\n`,
		{ mode: 0o600 },
	);
}

function startOwner(
	fixture: FakeAppServerFixture,
	options: { readonly prepareDelayMs?: number; readonly prepareStartedPath?: string } = {},
): ChildProcess {
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
				AGENTRELAY_TEST_PREPARE_DELAY_MS: String(options.prepareDelayMs ?? 0),
				AGENTRELAY_TEST_PREPARE_STARTED_PATH: options.prepareStartedPath,
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
	await waitForFile(join(fixture.directory, "owner-ready.json"));
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const ready = await readFile(path, "utf8").catch(() => "");
		if (ready !== "") return;
		await delay(10);
	}
	throw new Error(`Timed out waiting for ${path}`);
}

function createGuardian(fixture: FakeAppServerFixture): SupervisedCodexProviderGuardian {
	return new SupervisedCodexProviderGuardian({
		capsuleId: CAPSULE_ID,
		command: { executable: fixture.scriptPath },
		workspaceCwd: fixture.directory,
		capsuleDirectory: fixture.directory,
		env: fixture.env,
		boundary: directCodexProcessBoundaryForTests,
		authoritySignal: new AbortController().signal,
		claimOwnerCredential: async () => createFakeCodexOwnerCredential("guardian-process-owner"),
		deadlineAtMs: Date.now() + 60_000,
		supervisor: sourceSupervisorCommand(),
	});
}

async function openGeneration(fixture: FakeAppServerFixture): Promise<CodexProviderGeneration> {
	const generation = await createGuardian(fixture).openGeneration();
	generations.push(generation);
	return generation;
}

async function openGenerationWhenAvailable(
	fixture: FakeAppServerFixture,
): Promise<CodexProviderGeneration> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		try {
			return await openGeneration(fixture);
		} catch (error) {
			if (!(error instanceof CodexProviderGuardianError) || error.reason !== "ownership") {
				throw error;
			}
			if (Date.now() >= deadline) throw error;
			await delay(10);
		}
	}
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

async function childPidContaining(parentPid: number, marker: string): Promise<number> {
	const path = `/proc/${parentPid}/task/${parentPid}/children`;
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const children = (await readFile(path, "utf8")).trim().split(/\s+/).filter(Boolean).map(Number);
		for (const pid of children) {
			const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
			if (command.includes(marker)) return pid;
		}
		await delay(10);
	}
	throw new Error(`Could not identify child process containing ${marker}`);
}

async function stopFailClosedReaper(pid: number): Promise<void> {
	const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
	if (command.includes("--reaper")) {
		process.kill(pid, "SIGKILL");
		await waitForProcessExit(pid, 5_000);
	}
	failClosedReapers.delete(pid);
}

async function waitForStoppedProcess(pid: number): Promise<void> {
	const path = `/proc/${pid}/status`;
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const status = await readFile(path, "utf8");
		if (/^State:\s+T/m.test(status)) return;
		await delay(10);
	}
	throw new Error(`Process ${pid} did not stop`);
}
