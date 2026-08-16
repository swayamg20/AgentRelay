import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { SUPPORTED_CODEX_CLI_VERSION } from "./codex-app-server-protocol.js";
import type { CodexPreparedProcess } from "./codex-provider-supervisor-protocol.js";

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

export async function verifyPreparedCodexVersion(command: CodexPreparedProcess): Promise<void> {
	const child = spawnPrepared(command, ["ignore", "pipe", "pipe"]);
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
	command: CodexPreparedProcess,
): Promise<ChildProcessWithoutNullStreams> {
	const child = spawnPrepared(command, ["pipe", "pipe", "pipe"]);
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

function spawnPrepared(
	command: CodexPreparedProcess,
	stdio: ["ignore" | "pipe", "pipe", "pipe"],
): ChildProcessWithoutNullStreams {
	return spawn(command.executable, [...command.argv], {
		cwd: command.cwd,
		detached: false,
		env: { ...command.env },
		stdio,
		shell: false,
	}) as ChildProcessWithoutNullStreams;
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
