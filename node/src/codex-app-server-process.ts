import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { isAbsolute, normalize } from "node:path";
import type { Readable, Writable } from "node:stream";
import { buildCodexAppServerArguments } from "./codex-app-server-command.js";
import {
	MAX_CODEX_APP_SERVER_FRAME_BYTES,
	SUPPORTED_CODEX_CLI_VERSION,
} from "./codex-app-server-protocol.js";

const VERSION_PROBE_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 2_000;
const GROUP_POLL_MS = 10;
const processStops = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();

export interface CodexAppServerCommand {
	readonly executable: string;
}

export interface CodexAppServerProcessOptions {
	readonly command: CodexAppServerCommand;
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}

export interface CodexAppServerProcess {
	readonly child: ChildProcessWithoutNullStreams;
	readonly cwd: string;
	readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	readonly inputError: Promise<Error>;
}

export class CodexAppServerError extends Error {
	constructor(
		readonly reason:
			| "spawn"
			| "transport"
			| "protocol"
			| "provider"
			| "version"
			| "policy"
			| "closed",
		message: string,
		options: ErrorOptions = {},
	) {
		super(message, options);
		this.name = "CodexAppServerError";
	}
}

export async function startCodexAppServerProcess(
	options: CodexAppServerProcessOptions,
): Promise<CodexAppServerProcess> {
	if (process.platform === "win32") {
		throw new CodexAppServerError("policy", "Codex Mission Capsules currently require Unix");
	}
	const executable = validateCommand(options.command);
	const cwd = validateAbsolutePath(options.cwd, "Codex working directory");
	await verifyCodexCliVersion(executable, cwd, options.env);

	const child = spawn(executable, buildCodexAppServerArguments(), {
		cwd,
		detached: true,
		env: { ...options.env },
		stdio: ["pipe", "pipe", "pipe"],
		shell: false,
	});
	const inputError = writableError(child.stdin);
	const exited = childExit(child);
	const closed = childClose(child);
	try {
		await waitForSpawn(child);
	} catch (error) {
		throw new CodexAppServerError("spawn", "Failed to start the supported Codex app-server", {
			cause: error,
		});
	}
	child.stderr.resume();
	return { child, cwd, exited, closed, inputError };
}

export function stopCodexAppServerProcess(processRef: CodexAppServerProcess): Promise<void> {
	const existingStop = processStops.get(processRef.child);
	if (existingStop !== undefined) return existingStop;
	const stop = stopProcessGroup(processRef.child, processRef.exited, processRef.closed);
	processStops.set(processRef.child, stop);
	return stop;
}

async function stopProcessGroup(
	child: ChildProcess,
	exited: Promise<unknown>,
	closed: Promise<unknown>,
): Promise<void> {
	const pid = child.pid;
	if (pid === undefined) return;
	signalProcessGroup(pid, "SIGTERM");
	await Promise.race([exited, delay(STOP_GRACE_MS)]);
	if (isProcessGroupAlive(pid)) signalProcessGroup(pid, "SIGKILL");
	await waitForProcessGroupExit(pid);
	await Promise.race([
		closed,
		delay(STOP_GRACE_MS).then(() => {
			throw new CodexAppServerError("transport", "Codex process pipes did not close");
		}),
	]);
}

export async function* readCodexLines(stream: Readable): AsyncIterable<string> {
	stream.setEncoding("utf8");
	let pending = "";
	for await (const chunk of stream) {
		pending += String(chunk);
		let newline = pending.indexOf("\n");
		while (newline >= 0) {
			const line = pending.slice(0, newline);
			assertFrameSize(line, "response");
			if (line.length > 0) yield line;
			pending = pending.slice(newline + 1);
			newline = pending.indexOf("\n");
		}
		assertFrameSize(pending, "response");
	}
	if (pending.length > 0) {
		throw new CodexAppServerError("protocol", "Codex response ended with an incomplete frame");
	}
}

export function writeCodexFrame(stream: Writable, message: unknown): Promise<void> {
	const frame = `${JSON.stringify(message)}\n`;
	assertFrameSize(frame, "request");
	return new Promise((resolve, reject) => {
		stream.write(frame, "utf8", (error) => (error ? reject(error) : resolve()));
	});
}

function assertFrameSize(value: string, direction: "request" | "response"): void {
	if (Buffer.byteLength(value, "utf8") > MAX_CODEX_APP_SERVER_FRAME_BYTES) {
		throw new CodexAppServerError("protocol", `Codex ${direction} exceeds frame limit`);
	}
}

async function verifyCodexCliVersion(
	executable: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const child = spawn(executable, ["--version"], {
		cwd,
		detached: true,
		env: { ...env },
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
	});
	const exited = childExit(child);
	const closed = childClose(child);
	child.stderr.resume();
	let stdout = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
		if (Buffer.byteLength(stdout, "utf8") > 1_024 && child.pid !== undefined) {
			signalProcessGroup(child.pid, "SIGKILL");
		}
	});

	let timeout: NodeJS.Timeout | undefined;
	try {
		await waitForSpawn(child);
		const result = await Promise.race([
			closed,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new CodexAppServerError("version", "Codex version probe timed out")),
					VERSION_PROBE_TIMEOUT_MS,
				);
			}),
		]);
		if (result.code !== 0 || result.signal !== null) {
			throw new CodexAppServerError("version", "Codex version probe failed");
		}
		if (stdout.trim() !== `codex-cli ${SUPPORTED_CODEX_CLI_VERSION}`) {
			throw new CodexAppServerError(
				"version",
				`Unsupported Codex CLI; expected ${SUPPORTED_CODEX_CLI_VERSION}`,
			);
		}
	} catch (error) {
		await stopProcessGroup(child, exited, closed);
		if (error instanceof CodexAppServerError) throw error;
		throw new CodexAppServerError("spawn", "Failed to probe the Codex CLI version", {
			cause: error,
		});
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

function validateCommand(command: CodexAppServerCommand): string {
	return validateAbsolutePath(command.executable, "Codex executable");
}

function validateAbsolutePath(path: string, label: string): string {
	if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0")) {
		throw new Error(`${label} must be an absolute normalized path without NUL`);
	}
	return path;
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
	return new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
}

function writableError(stream: Writable): Promise<Error> {
	return new Promise((resolve) => stream.once("error", resolve));
}

function childExit(
	child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
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

async function waitForProcessGroupExit(pid: number): Promise<void> {
	const deadline = Date.now() + STOP_GRACE_MS;
	while (isProcessGroupAlive(pid)) {
		if (Date.now() >= deadline) {
			throw new CodexAppServerError("transport", "Codex process group did not terminate");
		}
		await delay(GROUP_POLL_MS);
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
