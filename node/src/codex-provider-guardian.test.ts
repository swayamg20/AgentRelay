import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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
	CodexProviderGenerationStore,
} from "./codex-provider-generation-state.js";
import {
	CODEX_PROVIDER_LOCK_FILE,
	type CodexProviderGuardianOptions,
	SupervisedCodexProviderGuardian,
} from "./codex-provider-guardian.js";
import { CodexSupervisedProcess, type CodexSupervisorCommand } from "./codex-supervised-process.js";
import { PROVIDER_GENERATION_LOCK_KIND, acquireProcessLock } from "./process-lock.js";

const CAPSULE_ID = "10000000-0000-4000-8000-000000000001";
const GUARDIAN_TEST_TIMEOUT_MS = 30_000;
const fixtures: FakeAppServerFixture[] = [];
const generations: CodexProviderGeneration[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.allSettled(
		generations.splice(0).map((generation) => generation.terminate("capsule_shutdown")),
	);
	await Promise.all(fixtures.splice(0).map((fixture) => fixture.remove()));
});

describe("SupervisedCodexProviderGuardian", () => {
	it(
		"owns one OS provider process lifecycle and records redacted quiescence",
		async () => {
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
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

	it(
		"allows only one concurrent generation owner across guardian instances",
		async () => {
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
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

	it(
		"rejects a second open while the same guardian is still opening",
		async () => {
			const fixture = await fakeAppServer();
			const guardian = createGuardian(fixture);
			const firstOpening = guardian.openGeneration();

			await expect(guardian.openGeneration()).rejects.toMatchObject({
				reason: "ownership",
			});
			const generation = await firstOpening;
			generations.push(generation);
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

	it(
		"kills provider descendants when authority is revoked",
		async () => {
			const fixture = await fakeAppServer({ spawnDescendant: true, ignoreSigterm: true });
			const authority = new AbortController();
			const generation = await openGeneration(fixture, { authoritySignal: authority.signal });
			const descendantPid = await waitForPid(fixture.childPidPath);
			let terminationProven = false;
			void generation.termination.then(() => {
				terminationProven = true;
			});

			authority.abort("expired");
			await expect(generation.client.readThread("thread-after-revocation")).rejects.toBe("expired");
			expect(terminationProven).toBe(true);
			await settleWithin(generation.termination, 1_500);
			await waitForProcessExit(descendantPid, 5_000);
			await generation.termination;
			expect(await generationState(fixture)).toMatchObject({
				phase: "quiescent",
			});
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

	it("does not admit a provider when authority is revoked during preparation", async () => {
		const fixture = await fakeAppServer();
		const authority = new AbortController();
		let prepareCalls = 0;
		const boundary = {
			async prepare(
				request: Parameters<typeof directCodexProcessBoundaryForTests.prepare>[0],
				signal: AbortSignal,
			) {
				expect(signal).toBe(authority.signal);
				prepareCalls += 1;
				if (prepareCalls === 1) authority.abort("expired");
				return directCodexProcessBoundaryForTests.prepare(request, signal);
			},
		};

		await expect(
			createGuardian(fixture, {
				authoritySignal: authority.signal,
				boundary,
			}).openGeneration(),
		).rejects.toMatchObject({
			name: "RuntimeAuthorityDeniedError",
			code: "expired",
		});
		await expect(readFile(fixture.argvPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("retires a spawned supervisor before initialization when authority is revoked", async () => {
		const fixture = await fakeAppServer();
		const authority = new AbortController();
		const lockPath = join(fixture.directory, CODEX_PROVIDER_LOCK_FILE);
		const lock = await acquireProcessLock(lockPath, { kind: PROVIDER_GENERATION_LOCK_KIND });
		const store = await CodexProviderGenerationStore.open(fixture.directory, CAPSULE_ID);
		let supervised: CodexSupervisedProcess | null = null;
		const nativeKill = process.kill.bind(process);
		const kill = vi
			.spyOn(process, "kill")
			.mockImplementation((pid, signal) => nativeKill(pid, signal));

		try {
			await expect(
				CodexSupervisedProcess.start(
					{
						capsuleId: CAPSULE_ID,
						capsuleDirectory: fixture.directory,
						generationId: randomUUID(),
						supervisor: sourceSupervisorCommand(),
						process: {
							command: { executable: fixture.scriptPath },
							cwd: fixture.directory,
							env: fixture.env,
							boundary: directCodexProcessBoundaryForTests,
							authoritySignal: authority.signal,
						},
						lock,
						store,
						deadlineAtMs: Date.now() + 60_000,
					},
					(value) => {
						supervised = value;
						const supervisorGroupId = value.process.child.pid;
						expect(supervisorGroupId).toBeTypeOf("number");
						authority.abort("expired");
						expect(kill).toHaveBeenCalledWith(-supervisorGroupId!, "SIGKILL");
					},
				),
			).rejects.toBe("expired");

			await expect(readFile(fixture.argvPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			const replacement = await acquireProcessLock(lockPath, {
				kind: PROVIDER_GENERATION_LOCK_KIND,
			});
			await replacement.release();
		} finally {
			authority.abort("revoked");
			await (supervised as CodexSupervisedProcess | null)
				?.stop("authority_revoked")
				.catch(() => undefined);
			await lock.release().catch(() => undefined);
		}
	});

	it(
		"writes no start barrier when the teardown witness cannot arm",
		async () => {
			const fixture = await fakeAppServer();

			await expect(
				createGuardian(fixture, {
					reaper: {
						executable: process.execPath,
						args: ["--eval", "process.exit(1)"],
					},
				}).openGeneration(),
			).rejects.toMatchObject({
				name: "CodexProviderGuardianError",
				reason: "startup",
				message: "Codex provider generation failed to start",
			});
			await expect(
				readFile(`${fixture.directory}/${CODEX_PROVIDER_GENERATION_FILE}`, "utf8"),
			).rejects.toMatchObject({ code: "ENOENT" });
			await expect(readFile(fixture.argvPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

			const replacement = await openGeneration(fixture);
			await replacement.terminate("capsule_shutdown");
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

	it(
		"enforces its absolute deadline against an unresponsive provider tree",
		async () => {
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
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

	it(
		"classifies an unresponsive provider request and tears down its authority",
		async () => {
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
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

	it(
		"escalates an in-flight graceful stop when authority is revoked",
		async () => {
			const fixture = await fakeAppServer({
				ignoreRead: true,
				ignoreSigterm: true,
				spawnDescendant: true,
			});
			const authority = new AbortController();
			const generation = await openGeneration(fixture, {
				authoritySignal: authority.signal,
				requestTimeoutMs: 100,
			});
			const descendantPid = await waitForPid(fixture.childPidPath);
			const request = generation.client.readThread("thread-1").catch((error: unknown) => error);

			await delay(150);
			authority.abort("expired");

			await waitForProcessExit(descendantPid, 1_500);
			await settleWithin(generation.termination, 5_000);
			expect(await request).toBe("expired");
			expect(await generationState(fixture)).toMatchObject({
				stop_cause: "provider_unresponsive",
				observation: "unresponsive",
			});
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

	it(
		"preserves a durable provider failure when authority races its terminal event",
		async () => {
			const fixture = await fakeAppServer({ exitAfterRead: true });
			const authority = new AbortController();
			const generation = await openGeneration(fixture, {
				authoritySignal: authority.signal,
				supervisor: await suppressedTerminalSupervisorCommand(fixture.directory),
				reaper: sourceReaperCommand(),
			});

			await expect(generation.client.readThread("thread-1")).resolves.toMatchObject({
				id: "thread-1",
			});
			await expect
				.poll(() => generationState(fixture))
				.toMatchObject({ phase: "stop_requested", stop_cause: "provider_failure" });

			authority.abort("expired");

			await expect(generation.client.readThread("thread-after-revocation")).rejects.toBe("expired");
			expect(await generation.termination).toEqual({ kind: "crashed" });
			expect(await generationState(fixture)).toMatchObject({
				phase: "quiescent",
				stop_cause: "provider_failure",
				observation: "crashed",
			});
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

	it(
		"escalates a graceful stop when its absolute deadline arrives",
		async () => {
			const fixture = await fakeAppServer({ ignoreSigterm: true });
			const generation = await openGeneration(fixture, {
				deadlineAtMs: Date.now() + 1_000,
			});
			const providerPid = await waitForPid(fixture.appServerPidPath);

			const termination = generation.terminate("capsule_shutdown");
			await waitForProcessExit(providerPid, 1_500);
			await settleWithin(termination, 5_000);

			expect(await generation.termination).toEqual({ kind: "stopped" });
			expect(await generationState(fixture)).toMatchObject({
				phase: "quiescent",
				stop_cause: "capsule_shutdown",
				observation: "stopped",
			});
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

	it(
		"reports an escaped supervisor pipe before publishing an authority denial",
		async () => {
			const fixture = await fakeAppServer();
			const authority = new AbortController();
			const authorityReason = new Error("authority expired");
			const escapedPidPath = join(fixture.directory, "escaped-supervisor-pipe.pid");
			let escapedPid: number | null = null;
			try {
				const generation = await openGeneration(fixture, {
					authoritySignal: authority.signal,
					supervisor: await escapedPipeSupervisorCommand(fixture.directory, escapedPidPath),
					reaper: sourceReaperCommand(),
				});
				escapedPid = await waitForPid(escapedPidPath);

				authority.abort(authorityReason);
				const proofFailure = await settleWithin(
					generation.termination.catch((error: unknown) => error),
					5_000,
				);
				const clientFailure = await generation.client
					.readThread("thread-after-revocation")
					.catch((error: unknown) => error);

				expect(proofFailure).toMatchObject({
					message: "Codex provider termination could not be proven",
				});
				expect(clientFailure).not.toBe(authorityReason);
				expect(clientFailure).toBe(proofFailure);
			} finally {
				authority.abort("revoked");
				killProcessIfAlive(escapedPid);
				if (escapedPid !== null) {
					await waitForProcessExit(escapedPid).catch(() => undefined);
				}
			}
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

	it(
		"classifies an unexpected provider exit and leaves no reusable authority",
		async () => {
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
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);

	it(
		"redacts startup failure details and durably closes the generation",
		async () => {
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
		},
		GUARDIAN_TEST_TIMEOUT_MS,
	);
});

type GuardianOverrides = Partial<
	Pick<
		CodexProviderGuardianOptions,
		"authoritySignal" | "boundary" | "deadlineAtMs" | "reaper" | "requestTimeoutMs" | "supervisor"
	>
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
		authoritySignal: new AbortController().signal,
		deadlineAtMs: Date.now() + 60_000,
		supervisor: sourceSupervisorCommand(),
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

function sourceReaperCommand(): CodexSupervisorCommand {
	const supervisor = sourceSupervisorCommand();
	return { ...supervisor, args: [...supervisor.args, "--reaper"] };
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

function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	const timedOut = new Promise<never>((_, reject) => {
		timeout = setTimeout(
			() => reject(new Error(`Operation did not settle within ${timeoutMs}ms`)),
			timeoutMs,
		);
		timeout.unref();
	});
	return Promise.race([promise, timedOut]).finally(() => clearTimeout(timeout));
}

async function escapedPipeSupervisorCommand(
	directory: string,
	escapedPidPath: string,
): Promise<CodexSupervisorCommand> {
	const wrapperPath = join(directory, "escaped-pipe-supervisor.mjs");
	const supervisorModuleUrl = new URL("./codex-provider-supervisor.ts", import.meta.url).href;
	await writeFile(
		wrapperPath,
		`import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const escaped = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
});
escaped.unref();
writeFileSync(${JSON.stringify(escapedPidPath)}, String(escaped.pid), { mode: 0o600 });
const { CodexProviderSupervisor } = await import(${JSON.stringify(supervisorModuleUrl)});
new CodexProviderSupervisor().run();
`,
		{ mode: 0o600 },
	);
	return {
		executable: process.execPath,
		args: ["--import", createRequire(import.meta.url).resolve("tsx"), wrapperPath],
	};
}

async function suppressedTerminalSupervisorCommand(
	directory: string,
): Promise<CodexSupervisorCommand> {
	const wrapperPath = join(directory, "suppressed-terminal-supervisor.mjs");
	const supervisorModuleUrl = new URL("./codex-provider-supervisor.ts", import.meta.url).href;
	await writeFile(
		wrapperPath,
		`const send = process.send?.bind(process);
if (send === undefined) throw new Error("Supervisor IPC is unavailable");
process.send = (message, ...args) => {
  if (message?.kind === "terminal") {
    const callback = args.findLast((value) => typeof value === "function");
    if (callback !== undefined) queueMicrotask(() => callback(null));
    return true;
  }
  return send(message, ...args);
};
const { CodexProviderSupervisor } = await import(${JSON.stringify(supervisorModuleUrl)});
new CodexProviderSupervisor().run();
`,
		{ mode: 0o600 },
	);
	return {
		executable: process.execPath,
		args: ["--import", createRequire(import.meta.url).resolve("tsx"), wrapperPath],
	};
}

function killProcessIfAlive(pid: number | null): void {
	if (pid === null) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if (errorCode(error) !== "ESRCH") throw error;
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
