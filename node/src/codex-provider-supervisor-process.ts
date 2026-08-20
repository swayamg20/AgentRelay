import { type ChildProcess, type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { SUPPORTED_CODEX_CLI_VERSION } from "./codex-app-server-protocol.js";
import type { CodexProviderPreparedProcess } from "./codex-provider-supervisor-protocol.js";

const VERSION_PROBE_TIMEOUT_MS = 5_000;

export class CodexSupervisorProcessError extends Error {
	constructor(
		readonly code: "version" | "spawn",
		message: string,
		options: ErrorOptions = {},
	) {
		super(message, options);
		this.name = "CodexSupervisorProcessError";
	}
}

export async function verifyPreparedCodexVersion(
	command: CodexProviderPreparedProcess,
): Promise<void> {
	const child = spawnPreparedVersionProbe(command);
	const closed = childClose(child);
	child.stderr.resume();
	let stdout = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
		if (Buffer.byteLength(stdout, "utf8") > 1_024) child.kill("SIGKILL");
	});

	try {
		await waitForSpawn(child);
		const result = await Promise.race([
			closed,
			delay(VERSION_PROBE_TIMEOUT_MS, undefined, { ref: false }).then(() => {
				throw new CodexSupervisorProcessError("version", "Codex version probe timed out");
			}),
		]);
		if (
			result.code !== 0 ||
			result.signal !== null ||
			stdout.trim() !== `codex-cli ${SUPPORTED_CODEX_CLI_VERSION}`
		) {
			throw new CodexSupervisorProcessError("version", "Codex version probe failed");
		}
	} catch (error) {
		child.kill("SIGKILL");
		if (error instanceof CodexSupervisorProcessError) throw error;
		throw new CodexSupervisorProcessError("spawn", "Codex version probe could not start", {
			cause: error,
		});
	}
}

export async function startPreparedCodexProvider(
	command: CodexProviderPreparedProcess,
): Promise<ChildProcess> {
	const child = spawnPreparedProvider(command);
	try {
		await waitForSpawn(child);
		return child;
	} catch (error) {
		throw new CodexSupervisorProcessError("spawn", "Codex app-server could not start", {
			cause: error,
		});
	}
}

export function assertSupervisorProcessGroup(): void {
	try {
		process.kill(-process.pid, 0);
	} catch (error) {
		throw new CodexSupervisorProcessError(
			"spawn",
			"Codex supervisor is not its process-group leader",
			{ cause: error },
		);
	}
}

function spawnPreparedVersionProbe(
	command: CodexProviderPreparedProcess,
): ChildProcessByStdio<null, Readable, Readable> {
	return spawn(command.executable, [...command.argv], {
		cwd: command.cwd,
		detached: false,
		env: { ...command.env },
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
	});
}

function spawnPreparedProvider(command: CodexProviderPreparedProcess): ChildProcess {
	// Keep protocol bytes in inherited OS pipes; the guardian owns only lifecycle control.
	return spawn(command.executable, [...command.argv], {
		cwd: command.cwd,
		detached: false,
		env: { ...command.env },
		stdio: [0, 1, "ignore"],
		shell: false,
	});
}

function waitForSpawn(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		const onSpawn = () => {
			child.removeListener("error", onError);
			resolve();
		};
		const onError = (error: Error) => {
			child.removeListener("spawn", onSpawn);
			reject(error);
		};
		child.once("spawn", onSpawn);
		child.once("error", onError);
	});
}

function childClose(
	child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	}
	return new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
}
