import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireConnectorLock } from "./lock.js";

const subprocesses: ChildProcess[] = [];

const PROCESS_WORKER_SOURCE = String.raw`
import { acquireConnectorLock } from "./lock.ts";

let heldLock;
try {
	heldLock = await acquireConnectorLock({ path: process.argv[1] });
} catch (error) {
	process.stdout.write(JSON.stringify({ acquired: false, kind: error?.kind }) + "\n");
	process.exit(0);
}
process.stdout.write(JSON.stringify({ acquired: true }) + "\n");
setInterval(() => void heldLock, 1_000);
`;

describe("connector process ownership", () => {
	let dir: string;
	let path: string;

	beforeEach(async () => {
		dir = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-connector-lock-")));
		path = join(dir, "watch.lock");
	});

	afterEach(async () => {
		for (const child of subprocesses.splice(0)) await killWorker(child);
		await rm(dir, { recursive: true, force: true });
	});

	it("allows one watcher and releases ownership for the next", async () => {
		const first = await acquireConnectorLock({ path });
		await expect(acquireConnectorLock({ path })).rejects.toMatchObject({
			kind: "already_running",
		});

		await first.release();
		await first.release();
		const second = await acquireConnectorLock({ path });
		await second.release();
	});

	it("enforces ownership across processes and releases it when the owner exits", async () => {
		const worker = startWorker(path);
		await expect(workerReady(worker)).resolves.toEqual({ acquired: true });
		await expect(acquireConnectorLock({ path })).rejects.toMatchObject({
			kind: "already_running",
		});

		worker.kill();
		await waitForExit(worker);
		const next = await acquireConnectorLock({ path });
		await next.release();
	});

	it.skipIf(process.platform === "win32")(
		"releases ownership immediately when the watcher is killed",
		async () => {
			const worker = startWorker(path);
			await expect(workerReady(worker)).resolves.toEqual({ acquired: true });
			await expect(acquireConnectorLock({ path })).rejects.toMatchObject({
				kind: "already_running",
			});
			if (worker.pid === undefined) throw new Error("Worker PID is unavailable");

			process.kill(worker.pid, "SIGKILL");
			await waitForExit(worker);
			const next = await acquireConnectorLock({ path });
			await next.release();
		},
	);

	it("refuses a symlink lock path without touching its target", async () => {
		const target = join(dir, "target");
		await writeFile(target, "do not alter", { encoding: "utf8", mode: 0o600 });
		await symlink(target, path);

		await expect(acquireConnectorLock({ path })).rejects.toMatchObject({ kind: "unavailable" });
		expect(await readFile(target, "utf8")).toBe("do not alter");
	});

	it.skipIf(process.platform === "win32")(
		"refuses a lock file under a group- or world-writable directory",
		async () => {
			await chmod(dir, 0o777);
			await expect(acquireConnectorLock({ path })).rejects.toMatchObject({ kind: "unavailable" });
			await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);
});

function startWorker(path: string): ChildProcess {
	const child = spawn(
		process.execPath,
		["--import", "tsx", "--input-type=module", "--eval", PROCESS_WORKER_SOURCE, path],
		{
			cwd: dirname(fileURLToPath(import.meta.url)),
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	subprocesses.push(child);
	return child;
}

async function workerReady(child: ChildProcess): Promise<Record<string, unknown>> {
	if (child.stdout === null || child.stderr === null) {
		throw new Error("Worker pipes are unavailable");
	}
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
	try {
		process.kill(child.pid, "SIGKILL");
	} catch (error) {
		if (errorCode(error) !== "ESRCH") throw error;
	}
	await waitForExit(child).catch(() => undefined);
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
