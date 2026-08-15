import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquireProcessLock } from "./process-lock.js";

const temporaryDirectories: string[] = [];
const subprocesses: ChildProcess[] = [];
const detachedProcessIds: number[] = [];

const PROCESS_WORKER_SOURCE = String.raw`
import { spawn } from "node:child_process";
import { acquireProcessLock } from "./process-lock.ts";

const lockPath = process.argv[1];
const mode = process.argv[2];
let heldLock;
try {
	heldLock = await acquireProcessLock(lockPath);
} catch (error) {
	await new Promise((resolve) => {
		process.stdout.write(JSON.stringify({ acquired: false, reason: error?.reason }) + "\n", resolve);
	});
	process.exit(0);
}

if (mode === "detached-child") {
	const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1_000)"], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	process.stdout.write(JSON.stringify({ acquired: true, childPid: child.pid }) + "\n");
} else {
	process.stdout.write(JSON.stringify({ acquired: true, pid: process.pid }) + "\n");
}
setInterval(() => void heldLock, 1_000);
`;

afterEach(async () => {
	for (const child of subprocesses.splice(0)) await killWorker(child);
	for (const pid of detachedProcessIds.splice(0)) killProcess(pid, "SIGKILL");
	const { rm } = await import("node:fs/promises");
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("process lock ownership across processes", () => {
	it("allows exactly one of two simultaneous contenders", async () => {
		const path = join(await temporaryDirectory(), "run.lock");
		const first = startWorker(path, "hold");
		const second = startWorker(path, "hold");
		const results = await Promise.all([workerReady(first), workerReady(second)]);

		expect(results.filter((result) => result.acquired === true)).toHaveLength(1);
		expect(results.filter((result) => result.reason === "already_running")).toHaveLength(1);
	});

	it.skipIf(process.platform === "win32")(
		"denies another process while the owner is stopped",
		async () => {
			const path = join(await temporaryDirectory(), "run.lock");
			const worker = startWorker(path, "hold");
			await expect(workerReady(worker)).resolves.toMatchObject({ acquired: true });
			if (worker.pid === undefined) throw new Error("Worker PID is unavailable");
			process.kill(worker.pid, "SIGSTOP");

			await expect(acquireProcessLock(path)).rejects.toMatchObject({
				name: "ProcessLockError",
				reason: "already_running",
			});
		},
	);

	it.skipIf(process.platform === "win32")(
		"reacquires the same inode immediately after the owner is killed",
		async () => {
			const path = join(await temporaryDirectory(), "run.lock");
			const worker = startWorker(path, "hold");
			await expect(workerReady(worker)).resolves.toMatchObject({ acquired: true });
			const inode = (await stat(path)).ino;
			if (worker.pid === undefined) throw new Error("Worker PID is unavailable");

			process.kill(worker.pid, "SIGKILL");
			await waitForExit(worker);
			const lock = await acquireProcessLock(path);
			expect((await stat(path)).ino).toBe(inode);
			await lock.release();
		},
	);

	it.skipIf(process.platform === "win32")(
		"does not let a detached child inherit Node ownership",
		async () => {
			const path = join(await temporaryDirectory(), "run.lock");
			const worker = startWorker(path, "detached-child");
			const ready = await workerReady(worker);
			if (typeof ready.childPid !== "number") throw new Error("Detached child PID is unavailable");
			detachedProcessIds.push(ready.childPid);
			if (worker.pid === undefined) throw new Error("Worker PID is unavailable");

			process.kill(worker.pid, "SIGKILL");
			await waitForExit(worker);
			expect(isProcessAlive(ready.childPid)).toBe(true);

			const lock = await acquireProcessLock(path);
			await lock.release();
		},
	);
});

async function temporaryDirectory(): Promise<string> {
	const path = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-node-lock-process-")));
	temporaryDirectories.push(path);
	return path;
}

function startWorker(path: string, mode: "hold" | "detached-child"): ChildProcess {
	const child = spawn(
		process.execPath,
		["--import", "tsx", "--input-type=module", "--eval", PROCESS_WORKER_SOURCE, path, mode],
		{
			cwd: dirname(fileURLToPath(import.meta.url)),
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	subprocesses.push(child);
	return child;
}

async function workerReady(child: ChildProcess): Promise<Record<string, unknown>> {
	if (child.stdout === null || child.stderr === null)
		throw new Error("Worker pipes are unavailable");
	return await new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(
			() => reject(new Error(`Worker readiness timed out: ${stderr}`)),
			5_000,
		);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			const newline = stdout.indexOf("\n");
			if (newline === -1) return;
			clearTimeout(timeout);
			try {
				resolve(JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>);
			} catch (error) {
				reject(error);
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			reject(new Error(`Worker exited before readiness (${code ?? signal}): ${stderr}`));
		});
	});
}

async function killWorker(child: ChildProcess): Promise<void> {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	killProcess(child.pid, "SIGCONT");
	killProcess(child.pid, "SIGKILL");
	await waitForExit(child).catch(() => undefined);
}

function killProcess(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch (error) {
		if (errorCode(error) !== "ESRCH") throw error;
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

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await once(child, "exit");
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
