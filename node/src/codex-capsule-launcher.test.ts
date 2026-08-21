import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type FakeCodexOwnerCredential,
	createFakeCodexOwnerCredential,
} from "../test-support/fake-codex-owner-credential.js";
import {
	CODEX_CAPSULE_RUNTIME_CONTRACT,
	capsuleSocketPath,
	codexCapsuleLaunchDescriptorSchema,
	fakeCapsuleLaunchDescriptorSchema,
} from "./capsule-launch-descriptor.js";
import { createDetachedCodexCapsuleLauncher } from "./codex-capsule-launcher.js";
import {
	type CodexOwnerCredential,
	MAX_CODEX_OWNER_CREDENTIAL_BYTES,
} from "./codex-owner-credential.js";

const FILE_WAIT_MS = 4_000;
const SECRET_ENV_NAME = "AGENTRELAY_LAUNCHER_SECRET_CANARY";
const DESCRIPTOR_IDS = {
	capsule: "10000000-0000-4000-8000-000000000001",
	mission: "10000000-0000-4000-8000-000000000002",
	participant: "10000000-0000-4000-8000-000000000003",
	containment: "10000000-0000-4000-8000-000000000004",
} as const;

const temporaryDirectories: string[] = [];
const processGroups = new Set<number>();
const ownerProcesses = new Set<ChildProcess>();
const environmentRestores: Array<() => void> = [];

afterEach(async () => {
	for (const restore of environmentRestores.splice(0)) restore();
	const ownerStops = [...ownerProcesses].map((owner) => {
		const closed = waitForChildClose(owner);
		owner.kill("SIGKILL");
		return closed;
	});
	ownerProcesses.clear();
	await Promise.all(ownerStops);
	for (const pid of processGroups) killProcessGroupIfAlive(pid);
	processGroups.clear();
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe.runIf(process.platform !== "win32")("createDetachedCodexCapsuleLauncher", () => {
	it("rejects malformed commands, timeouts, and capsule directories with fixed errors", async () => {
		const descriptorDirectory = await temporaryDirectory();
		const lifetimeSignal = new AbortController().signal;
		const claimOwnerCredential = async () => createFakeCodexOwnerCredential("never-claimed");
		expect(() =>
			createDetachedCodexCapsuleLauncher({
				command: { executable: "relative-capsule", args: [] },
				lifetimeSignal,
				claimOwnerCredential,
			}),
		).toThrow("Codex Mission capsule command is invalid");
		expect(() =>
			createDetachedCodexCapsuleLauncher({
				command: nodeCommand(SPAWN_MARKER_SCRIPT, "/tmp/unused"),
				lifetimeSignal,
				claimOwnerCredential,
				credentialTimeoutMs: 9,
			}),
		).toThrow("Codex owner credential timeout is invalid");
		const launcher = createDetachedCodexCapsuleLauncher({
			command: nodeCommand(SPAWN_MARKER_SCRIPT, "/tmp/unused"),
			lifetimeSignal,
			claimOwnerCredential,
		});
		await expect(
			launcher.start("relative-directory", codexDescriptor(descriptorDirectory)),
		).rejects.toMatchObject({
			message: "Codex Mission capsule directory is invalid",
		});
	});

	it("rejects a schema-v1 descriptor before claiming or spawning", async () => {
		const directory = await temporaryDirectory();
		const markerPath = join(directory, "spawned");
		let claims = 0;
		const launcher = createDetachedCodexCapsuleLauncher({
			command: nodeCommand(SPAWN_MARKER_SCRIPT, markerPath),
			lifetimeSignal: new AbortController().signal,
			claimOwnerCredential: async () => {
				claims += 1;
				return createFakeCodexOwnerCredential("must-not-be-claimed");
			},
		});

		await expect(launcher.start(directory, fakeDescriptor())).rejects.toMatchObject({
			message: "Codex Mission capsule launcher requires a schema-v3 descriptor",
		});
		expect(claims).toBe(0);
		await delay(50);
		expect(await fileExists(markerPath)).toBe(false);
	});

	it("hands off a delayed maximum-size credential without exposing it in argv or env", async () => {
		const directory = await temporaryDirectory();
		const outputPath = join(directory, "received.json");
		const topologyPath = join(directory, "topology.json");
		const secret = `sk-owner-${"x".repeat(MAX_CODEX_OWNER_CREDENTIAL_BYTES - 9)}`;
		const expectedDigest = digest(secret);
		setTemporaryEnvironment(SECRET_ENV_NAME, secret);
		const underlying = createFakeCodexOwnerCredential(secret);
		const credential = settlingCredential(underlying);
		const launcher = createDetachedCodexCapsuleLauncher({
			command: descriptorProbeCommand(topologyPath, outputPath),
			lifetimeSignal: new AbortController().signal,
			claimOwnerCredential: async () => credential,
			credentialTimeoutMs: 2_000,
		});

		await launcher.start(directory, codexDescriptor(directory));

		expect(await fileExists(outputPath)).toBe(false);
		const topology = await waitForJson<DescriptorTopology>(topologyPath);
		const received = await waitForJson<ReceivedCredential>(outputPath);
		expect(["fifo", "socket"]).toContain(topology.fd3);
		expect(topology).toMatchObject({ fd4: "EBADF", stdio: "char,char,char" });
		expect(received).toMatchObject({
			bytes: MAX_CODEX_OWNER_CREDENTIAL_BYTES,
			digest: expectedDigest,
			argv: ["serve", "--directory", directory],
		});
		expect(received.environmentValueDigests).not.toContain(expectedDigest);
		expect(JSON.stringify(received)).not.toContain(secret);
		expect(underlying.disposeCount).toBe(1);
		await waitForProcessAbsence(received.pid);
	});

	it("claims a fresh opaque credential for every actual start", async () => {
		const firstDirectory = await temporaryDirectory();
		const secondDirectory = await temporaryDirectory();
		const signals: AbortSignal[] = [];
		let claims = 0;
		const launcher = createDetachedCodexCapsuleLauncher({
			command: nodeCommand(DIRECTORY_READER_SCRIPT),
			lifetimeSignal: new AbortController().signal,
			claimOwnerCredential: async (signal) => {
				signals.push(signal);
				claims += 1;
				return settlingCredential(createFakeCodexOwnerCredential(`owner-credential-${claims}`));
			},
		});

		await launcher.start(firstDirectory, codexDescriptor(firstDirectory));
		await launcher.start(secondDirectory, codexDescriptor(secondDirectory));

		const first = await waitForJson<ReceivedCredential>(join(firstDirectory, "received.json"));
		const second = await waitForJson<ReceivedCredential>(join(secondDirectory, "received.json"));
		expect(claims).toBe(2);
		expect(signals[0]).not.toBe(signals[1]);
		expect(first.digest).toBe(digest("owner-credential-1"));
		expect(second.digest).toBe(digest("owner-credential-2"));
		await Promise.all([waitForProcessAbsence(first.pid), waitForProcessAbsence(second.pid)]);
	});

	it("never spawns when the credential source fails and sanitizes its error", async () => {
		const directory = await temporaryDirectory();
		const markerPath = join(directory, "spawned");
		const secret = "sk-source-failure-must-not-escape";
		const launcher = createDetachedCodexCapsuleLauncher({
			command: nodeCommand(SPAWN_MARKER_SCRIPT, markerPath),
			lifetimeSignal: new AbortController().signal,
			claimOwnerCredential: () => Promise.reject(new Error(secret)),
		});

		const error = await rejectedError(launcher.start(directory, codexDescriptor(directory)));

		expect(error).toMatchObject({
			name: "CodexCapsuleLaunchError",
			message: "Codex owner credential is unavailable",
		});
		expect(renderError(error)).not.toContain(secret);
		expect(error).not.toHaveProperty("cause");
		await delay(50);
		expect(await fileExists(markerPath)).toBe(false);
	});

	it("sanitizes a process spawn failure and disposes the claimed credential", async () => {
		const directory = await temporaryDirectory();
		const secret = "sk-spawn-failure-must-not-escape";
		const credential = createFakeCodexOwnerCredential(secret);
		const launcher = createDetachedCodexCapsuleLauncher({
			command: { executable: join(directory, "missing-capsule"), args: [] },
			lifetimeSignal: new AbortController().signal,
			claimOwnerCredential: async () => credential,
		});

		const error = await rejectedError(launcher.start(directory, codexDescriptor(directory)));

		expect(error).toMatchObject({ message: "Codex Mission capsule could not be started" });
		expect(renderError(error)).not.toContain(secret);
		expect(error).not.toHaveProperty("cause");
		expect(credential.disposeCount).toBe(1);
	});

	it("bounds an abort-ignoring credential source and disposes its late result", async () => {
		const directory = await temporaryDirectory();
		const markerPath = join(directory, "spawned");
		const lateCredential = createFakeCodexOwnerCredential("late-owner-credential");
		const launcher = createDetachedCodexCapsuleLauncher({
			command: nodeCommand(SPAWN_MARKER_SCRIPT, markerPath),
			lifetimeSignal: new AbortController().signal,
			claimOwnerCredential: () =>
				new Promise((resolve) => setTimeout(() => resolve(lateCredential), 100)),
			credentialTimeoutMs: 25,
		});

		await expect(launcher.start(directory, codexDescriptor(directory))).rejects.toMatchObject({
			message: "Codex owner credential transfer timed out",
		});
		await delay(125);
		expect(lateCredential.disposeCount).toBe(1);
		expect(await fileExists(markerPath)).toBe(false);
	});

	it("keeps the total launch deadline refed and clears it on settlement", async () => {
		const directory = await temporaryDirectory();
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		let deadline: NodeJS.Timeout | null = null;
		let deadlineCleared = false;
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: (...args: any[]) => void,
			milliseconds?: number,
			...args: any[]
		) => {
			const timer = originalSetTimeout(callback, milliseconds, ...args);
			if (milliseconds === 40 && deadline === null) deadline = timer;
			return timer;
		}) as typeof globalThis.setTimeout);
		const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((
			timer: NodeJS.Timeout,
		) => {
			if (timer === deadline) deadlineCleared = true;
			originalClearTimeout(timer);
		}) as typeof globalThis.clearTimeout);
		try {
			const launcher = createDetachedCodexCapsuleLauncher({
				command: nodeCommand(SPAWN_MARKER_SCRIPT, join(directory, "spawned")),
				lifetimeSignal: new AbortController().signal,
				claimOwnerCredential: () => new Promise(() => undefined),
				credentialTimeoutMs: 40,
			});
			const start = launcher.start(directory, codexDescriptor(directory));
			await waitUntil(() => deadline !== null);

			expect(deadline?.hasRef()).toBe(true);
			await expect(start).rejects.toMatchObject({
				message: "Codex owner credential transfer timed out",
			});
			expect(deadlineCleared).toBe(true);
		} finally {
			clearTimeoutSpy.mockRestore();
			setTimeoutSpy.mockRestore();
		}
	});

	it("cancels an abort-ignoring claim before spawn and disposes its late result", async () => {
		const directory = await temporaryDirectory();
		const markerPath = join(directory, "spawned");
		const lifetime = new AbortController();
		const lateCredential = createFakeCodexOwnerCredential("late-after-node-shutdown");
		let claimSignal: AbortSignal | null = null;
		const launcher = createDetachedCodexCapsuleLauncher({
			command: nodeCommand(SPAWN_MARKER_SCRIPT, markerPath),
			lifetimeSignal: lifetime.signal,
			claimOwnerCredential: (signal) => {
				claimSignal = signal;
				return new Promise((resolve) => setTimeout(() => resolve(lateCredential), 100));
			},
			credentialTimeoutMs: 1_000,
		});
		const start = launcher.start(directory, codexDescriptor(directory));
		await waitUntil(() => claimSignal !== null);

		lifetime.abort(new Error("private shutdown reason"));

		await expect(start).rejects.toMatchObject({
			message: "Codex Mission capsule launch was cancelled",
		});
		expect(claimSignal?.aborted).toBe(true);
		await delay(125);
		expect(lateCredential.disposeCount).toBe(1);
		expect(await fileExists(markerPath)).toBe(false);
	});

	it("finishes a bounded handoff after spawn when the Node lifetime ends", async () => {
		const directory = await temporaryDirectory();
		const outputPath = join(directory, "received.json");
		const lifetime = new AbortController();
		const transfer = deferred<void>();
		const underlying = createFakeCodexOwnerCredential("survives-normal-node-shutdown");
		const credential = delayedCredential(underlying, transfer.resolve, 75);
		const launcher = createDetachedCodexCapsuleLauncher({
			command: nodeCommand(IMMEDIATE_READER_SCRIPT, outputPath),
			lifetimeSignal: lifetime.signal,
			claimOwnerCredential: async () => credential,
			credentialTimeoutMs: 1_000,
		});
		const start = launcher.start(directory, codexDescriptor(directory));
		await transfer.promise;

		lifetime.abort();

		await expect(start).resolves.toBeUndefined();
		const received = await waitForJson<ReceivedCredential>(outputPath);
		expect(received.digest).toBe(digest("survives-normal-node-shutdown"));
		await waitForProcessAbsence(received.pid);
	});

	it("leaves fd3 readable after the intermediate Node owner exits", async () => {
		const directory = await temporaryDirectory();
		const outputPath = join(directory, "received-after-owner-exit.json");
		const secret = "owner-process-exits-before-capsule-read";
		const owner = startIntermediateOwner(directory, outputPath);
		ownerProcesses.add(owner);
		owner.stdin?.on("error", () => undefined);
		owner.stdin?.end(secret);
		const stdout = collectOutput(owner.stdout);
		const stderr = collectOutput(owner.stderr);

		const outcome = await waitForChildClose(owner);
		ownerProcesses.delete(owner);

		expect(outcome).toEqual({ code: 0, signal: null });
		expect(await stdout).toBe("started\n");
		expect(await stderr).not.toContain(secret);
		expect(await fileExists(outputPath)).toBe(false);
		const received = await waitForJson<ReceivedCredential>(outputPath);
		expect(received.digest).toBe(digest(secret));
		expect(JSON.stringify(received)).not.toContain(secret);
		await waitForProcessAbsence(received.pid);
	});

	it("kills the detached group and closes fd3 when transfer times out", async () => {
		const directory = await temporaryDirectory();
		const pidPath = join(directory, "pid");
		const originalSetTimeout = globalThis.setTimeout;
		let expireTransfer: (() => void) | null = null;
		let deadlineTimer: NodeJS.Timeout | null = null;
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: (...args: any[]) => void,
			milliseconds?: number,
			...args: any[]
		) => {
			if (milliseconds === 150 && expireTransfer === null) {
				expireTransfer = () => callback(...args);
				deadlineTimer = originalSetTimeout(callback, 30_000, ...args);
				return deadlineTimer;
			}
			return originalSetTimeout(callback, milliseconds, ...args);
		}) as typeof globalThis.setTimeout);
		let disposeCount = 0;
		const credential: CodexOwnerCredential = {
			use: async () => undefined,
			writeTo: () => new Promise(() => undefined),
			dispose: () => {
				disposeCount += 1;
			},
		};
		const launcher = createDetachedCodexCapsuleLauncher({
			command: nodeCommand(HANGING_READER_SCRIPT, pidPath),
			lifetimeSignal: new AbortController().signal,
			claimOwnerCredential: async () => credential,
			credentialTimeoutMs: 150,
		});
		const start = launcher.start(directory, codexDescriptor(directory));
		try {
			const pid = Number(await waitForText(pidPath));
			processGroups.add(pid);
			expireTransfer?.();
			const error = await rejectedError(start);

			expect(error).toMatchObject({ message: "Codex owner credential transfer timed out" });
			expect(disposeCount).toBe(1);
			expect(isProcessGroupAlive(pid)).toBe(false);
			processGroups.delete(pid);
		} finally {
			expireTransfer?.();
			await start.catch(() => undefined);
			if (deadlineTimer !== null) clearTimeout(deadlineTimer);
			setTimeoutSpy.mockRestore();
		}
	});

	it("kills the detached group when a credential resolves without closing fd3", async () => {
		const directory = await temporaryDirectory();
		const pidPath = join(directory, "pid");
		let disposeCount = 0;
		const credential: CodexOwnerCredential = {
			use: async () => undefined,
			writeTo: async () => {
				await waitForText(pidPath);
			},
			dispose: () => {
				disposeCount += 1;
			},
		};
		const launcher = createDetachedCodexCapsuleLauncher({
			command: nodeCommand(HANGING_READER_SCRIPT, pidPath),
			lifetimeSignal: new AbortController().signal,
			claimOwnerCredential: async () => credential,
			credentialTimeoutMs: 1_000,
		});

		const error = await rejectedError(launcher.start(directory, codexDescriptor(directory)));
		const pid = Number(await waitForText(pidPath));
		processGroups.add(pid);

		expect(error).toMatchObject({ message: "Codex owner credential transfer failed" });
		expect(disposeCount).toBe(1);
		expect(isProcessGroupAlive(pid)).toBe(false);
		processGroups.delete(pid);
	});

	it("sanitizes EPIPE and proves the child process group is gone", async () => {
		const directory = await temporaryDirectory();
		const pidPath = join(directory, "pid");
		const secret = "sk-epipe-must-not-escape";
		const credential: CodexOwnerCredential = {
			use: async () => undefined,
			writeTo: async (destination) => {
				await waitForText(pidPath);
				const failure = Object.assign(new Error(secret), { code: "EPIPE" });
				destination.emit("error", failure);
				throw failure;
			},
			dispose: () => undefined,
		};
		const launcher = createDetachedCodexCapsuleLauncher({
			command: nodeCommand(HANGING_READER_SCRIPT, pidPath),
			lifetimeSignal: new AbortController().signal,
			claimOwnerCredential: async () => credential,
			credentialTimeoutMs: 1_000,
		});

		const error = await rejectedError(launcher.start(directory, codexDescriptor(directory)));
		const pid = Number(await waitForText(pidPath));
		processGroups.add(pid);

		expect(error).toMatchObject({ message: "Codex owner credential transfer failed" });
		expect(renderError(error)).not.toContain(secret);
		expect(error).not.toHaveProperty("cause");
		expect(isProcessGroupAlive(pid)).toBe(false);
		processGroups.delete(pid);
	});

	it("reports teardown proof failure instead of the functional transfer error", async () => {
		const directory = await temporaryDirectory();
		const pidPath = join(directory, "pid");
		const secret = "sk-functional-error-must-not-win";
		const realKill = process.kill.bind(process);
		const kill = vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
			if (pid < 0 && signal === "SIGKILL") return true;
			return realKill(pid, signal);
		}) as typeof process.kill);
		const credential: CodexOwnerCredential = {
			use: async () => undefined,
			writeTo: async () => {
				await waitForText(pidPath);
				throw new Error(secret);
			},
			dispose: () => undefined,
		};
		const launcher = createDetachedCodexCapsuleLauncher({
			command: nodeCommand(HANGING_READER_SCRIPT, pidPath),
			lifetimeSignal: new AbortController().signal,
			claimOwnerCredential: async () => credential,
			credentialTimeoutMs: 4_000,
		});

		const error = await rejectedError(launcher.start(directory, codexDescriptor(directory)));
		const pid = Number(await waitForText(pidPath));
		processGroups.add(pid);
		kill.mockRestore();

		expect(error).toMatchObject({
			message: "Codex Mission capsule termination could not be proven",
		});
		expect(renderError(error)).not.toContain(secret);
		expect(error).not.toHaveProperty("cause");
		killProcessGroupIfAlive(pid);
		await waitForProcessAbsence(pid);
		processGroups.delete(pid);
	});
});

interface ReceivedCredential {
	readonly pid: number;
	readonly bytes: number;
	readonly digest: string;
	readonly argv: readonly string[];
	readonly environmentValueDigests?: readonly string[];
}

interface DescriptorTopology {
	readonly fd3: "fifo" | "socket" | "other";
	readonly fd4: "EBADF" | "open";
	readonly stdio: string;
}

function nodeCommand(script: string, ...args: string[]) {
	return { executable: process.execPath, args: ["--input-type=module", "--eval", script, ...args] };
}

function codexDescriptor(directory: string) {
	return codexCapsuleLaunchDescriptorSchema.parse({
		schema_version: 3,
		capsule_id: DESCRIPTOR_IDS.capsule,
		capability_token: `ar_capsule_${"a".repeat(64)}`,
		socket_path: capsuleSocketPath(DESCRIPTOR_IDS.capsule),
		session: {
			missionId: DESCRIPTOR_IDS.mission,
			participantId: DESCRIPTOR_IDS.participant,
			workspaceAlias: "backend-primary",
		},
		runtime: {
			kind: "codex",
			runtime_contract: CODEX_CAPSULE_RUNTIME_CONTRACT,
			codex_cli_version: "0.146.0",
			containment: {
				manifestPath: join(directory, "containment.json"),
				instanceId: DESCRIPTOR_IDS.containment,
				bindingSha256: "b".repeat(64),
			},
		},
	});
}

function fakeDescriptor() {
	return fakeCapsuleLaunchDescriptorSchema.parse({
		schema_version: 1,
		capsule_id: DESCRIPTOR_IDS.capsule,
		capability_token: `ar_capsule_${"c".repeat(64)}`,
		socket_path: capsuleSocketPath(DESCRIPTOR_IDS.capsule),
		session: {
			missionId: DESCRIPTOR_IDS.mission,
			participantId: DESCRIPTOR_IDS.participant,
			workspaceAlias: "backend-primary",
		},
		runtime: { kind: "fake", outcome: "ready", completion_delay_ms: 0 },
	});
}

function descriptorProbeCommand(topologyPath: string, outputPath: string) {
	return {
		executable: "/bin/sh",
		args: [
			"-c",
			DESCRIPTOR_PROBE_SCRIPT,
			"agentrelay-descriptor-probe",
			process.execPath,
			topologyPath,
			outputPath,
			DELAYED_READER_SCRIPT,
		],
	};
}

function startIntermediateOwner(directory: string, outputPath: string): ChildProcess {
	const require = createRequire(import.meta.url);
	const tsxImport = require.resolve("tsx");
	const launcherUrl = new URL("./codex-capsule-launcher.ts", import.meta.url).href;
	const credentialUrl = new URL("../test-support/fake-codex-owner-credential.ts", import.meta.url)
		.href;
	const script = intermediateOwnerScript(launcherUrl, credentialUrl, codexDescriptor(directory));
	return spawn(
		process.execPath,
		["--import", tsxImport, "--input-type=module", "--eval", script, directory, outputPath],
		{ shell: false, stdio: ["pipe", "pipe", "pipe"] },
	);
}

function intermediateOwnerScript(
	launcherUrl: string,
	credentialUrl: string,
	descriptor: ReturnType<typeof codexDescriptor>,
): string {
	return `
import { readFileSync } from "node:fs";
import { createDetachedCodexCapsuleLauncher } from ${JSON.stringify(launcherUrl)};
import { createFakeCodexOwnerCredential } from ${JSON.stringify(credentialUrl)};
const secret = readFileSync(0, "utf8");
const directory = process.argv[1];
const output = process.argv[2];
const descriptor = ${JSON.stringify(descriptor)};
const ownerCredential = createFakeCodexOwnerCredential(secret);
const launcher = createDetachedCodexCapsuleLauncher({
  command: {
    executable: process.execPath,
    args: ["--input-type=module", "--eval", ${JSON.stringify(POST_OWNER_READER_SCRIPT)}, output],
  },
  lifetimeSignal: new AbortController().signal,
  claimOwnerCredential: async () => ({
    use: (operation) => ownerCredential.use(operation),
    writeTo: async (destination) => {
      await ownerCredential.writeTo(destination);
      if (!destination.closed) {
        const closed = new Promise((resolve) => destination.once("close", resolve));
        destination.destroy();
        await closed;
      }
    },
    dispose: () => ownerCredential.dispose(),
  }),
  credentialTimeoutMs: 2_000,
});
await launcher.start(directory, descriptor);
process.stdout.write("started\\n", () => process.exit(0));
`;
}

function delayedCredential(
	underlying: FakeCodexOwnerCredential,
	onWrite: () => void,
	delayMs: number,
): CodexOwnerCredential {
	return {
		use: (operation) => underlying.use(operation),
		async writeTo(destination: Writable) {
			onWrite();
			await delay(delayMs);
			await underlying.writeTo(destination);
			await ensureDestinationClosed(destination);
		},
		dispose: () => underlying.dispose(),
	};
}

function settlingCredential(underlying: FakeCodexOwnerCredential): CodexOwnerCredential {
	return {
		use: (operation) => underlying.use(operation),
		async writeTo(destination) {
			await underlying.writeTo(destination);
			await ensureDestinationClosed(destination);
		},
		dispose: () => underlying.dispose(),
	};
}

async function ensureDestinationClosed(destination: Writable): Promise<void> {
	if (destination.closed) return;
	const closed = new Promise<void>((resolve) => destination.once("close", resolve));
	destination.destroy();
	await closed;
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "agentrelay-codex-launcher-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function waitForJson<T>(path: string): Promise<T> {
	return JSON.parse(await waitForText(path)) as T;
}

async function waitForText(path: string): Promise<string> {
	const deadline = Date.now() + FILE_WAIT_MS;
	while (true) {
		try {
			return await readFile(path, "utf8");
		} catch (error) {
			if (errorCode(error) !== "ENOENT" || Date.now() >= deadline) throw error;
			await delay(10);
		}
	}
}

async function waitUntil(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + FILE_WAIT_MS;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Condition did not become true");
		await delay(5);
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
	try {
		await operation;
		throw new Error("Expected operation to reject");
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return error;
	}
}

async function collectOutput(stream: NodeJS.ReadableStream | null): Promise<string> {
	if (stream === null) return "";
	let output = "";
	for await (const chunk of stream) output += String(chunk);
	return output;
}

function waitForChildClose(
	child: ChildProcess,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	}
	return new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
}

function renderError(error: Error): string {
	return `${String(error)} ${JSON.stringify(error)} ${inspect(error)}`;
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function setTemporaryEnvironment(name: string, value: string): void {
	const previous = process.env[name];
	process.env[name] = value;
	environmentRestores.push(() => {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	});
}

function killProcessGroupIfAlive(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if (errorCode(error) !== "ESRCH") throw error;
	}
}

function isProcessGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		if (errorCode(error) === "ESRCH") return false;
		throw error;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (errorCode(error) === "ESRCH") return false;
		throw error;
	}
}

async function waitForProcessAbsence(pid: number): Promise<void> {
	const deadline = Date.now() + FILE_WAIT_MS;
	while (isProcessAlive(pid)) {
		if (Date.now() >= deadline) throw new Error("Process did not terminate");
		await delay(10);
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}

const DELAYED_READER_SCRIPT = String.raw`
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const output = process.argv[1];
setTimeout(() => {
  const credential = readFileSync(3);
  writeFileSync(output, JSON.stringify({
    pid: process.pid,
    bytes: credential.length,
    digest: createHash("sha256").update(credential).digest("hex"),
    argv: process.argv.slice(2),
    environmentValueDigests: Object.values(process.env).map((value) =>
      createHash("sha256").update(value).digest("hex")
    ),
  }));
  credential.fill(0);
}, 250);
`;

const DESCRIPTOR_PROBE_SCRIPT = String.raw`
fd3=other
if [ -p /dev/fd/3 ]; then fd3=fifo; elif [ -S /dev/fd/3 ]; then fd3=socket; fi
if ( : <&4 ) 2>/dev/null; then fd4=open; else fd4=EBADF; fi
stdio=other
if [ -c /dev/fd/0 ] && [ -c /dev/fd/1 ] && [ -c /dev/fd/2 ]; then stdio=char,char,char; fi
printf '{"fd3":"%s","fd4":"%s","stdio":"%s"}' "$fd3" "$fd4" "$stdio" > "$2"
exec "$1" --input-type=module --eval "$4" "$3" "$5" "$6" "$7"
`;

const DIRECTORY_READER_SCRIPT = String.raw`
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const directory = process.argv.at(-1);
const credential = readFileSync(3);
writeFileSync(join(directory, "received.json"), JSON.stringify({
  pid: process.pid,
  bytes: credential.length,
  digest: createHash("sha256").update(credential).digest("hex"),
  argv: process.argv.slice(1),
}));
credential.fill(0);
`;

const IMMEDIATE_READER_SCRIPT = String.raw`
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const credential = readFileSync(3);
writeFileSync(process.argv[1], JSON.stringify({
  pid: process.pid,
  bytes: credential.length,
  digest: createHash("sha256").update(credential).digest("hex"),
  argv: process.argv.slice(2),
}));
credential.fill(0);
`;

const POST_OWNER_READER_SCRIPT = String.raw`
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
setTimeout(() => {
  const credential = readFileSync(3);
  writeFileSync(process.argv[1], JSON.stringify({
    pid: process.pid,
    bytes: credential.length,
    digest: createHash("sha256").update(credential).digest("hex"),
    argv: process.argv.slice(2),
  }));
  credential.fill(0);
}, 750);
`;

const SPAWN_MARKER_SCRIPT = String.raw`
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[1], String(process.pid));
`;

const HANGING_READER_SCRIPT = String.raw`
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[1], String(process.pid));
setInterval(() => undefined, 1_000);
`;
