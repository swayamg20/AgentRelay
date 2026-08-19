import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { isAbsolute, normalize } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { buildCodexAppServerArguments } from "./codex-app-server-command.js";
import {
	MAX_CODEX_APP_SERVER_FRAME_BYTES,
	SUPPORTED_CODEX_CLI_VERSION,
} from "./codex-app-server-protocol.js";
import type { CodexProcessBoundary } from "./codex-process-boundary.js";
import {
	isProcessGroupAlive,
	killProcessGroupAndProveTerminated,
	proveProcessGroupTerminated,
} from "./process-group-termination.js";

const VERSION_PROBE_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 2_000;
const processStops = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();

export interface CodexAppServerCommand {
	readonly executable: string;
}

export interface CodexAppServerProcessOptions {
	readonly command: CodexAppServerCommand;
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly boundary: CodexProcessBoundary;
	readonly authoritySignal: AbortSignal;
}

export interface CodexAppServerProcess {
	readonly child: ChildProcessWithoutNullStreams;
	readonly cwd: string;
	readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	readonly inputError: Promise<Error>;
	/** Settles only after the direct process terminal owner has proven quiescence. */
	readonly authorityTermination?: Promise<void>;
	/** Optional lifecycle owner used when the visible child is a supervising process. */
	readonly stop?: (reason?: CodexAppServerStopReason) => Promise<void>;
}

export type CodexAppServerStopReason = "closed" | "failure" | "unresponsive";

export type CodexAppServerProcessFactory = (
	options: CodexAppServerProcessOptions,
) => Promise<CodexAppServerProcess>;

export class CodexAppServerError extends Error {
	constructor(
		readonly reason:
			| "spawn"
			| "transport"
			| "protocol"
			| "provider"
			| "authentication"
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
	options.authoritySignal.throwIfAborted();
	await verifyCodexCliVersion(
		executable,
		cwd,
		options.env,
		options.boundary,
		options.authoritySignal,
	);
	options.authoritySignal.throwIfAborted();

	const prepared = await prepareContainedProcess(
		options.boundary,
		{
			executable,
			argv: buildCodexAppServerArguments(),
			cwd,
			env: options.env,
		},
		options.authoritySignal,
	);
	options.authoritySignal.throwIfAborted();
	const child = spawn(prepared.executable, [...prepared.argv], {
		cwd: prepared.cwd,
		detached: true,
		env: { ...prepared.env },
		stdio: ["pipe", "pipe", "pipe"],
		shell: false,
	});
	const inputError = writableError(child.stdin);
	const exited = childExit(child);
	const closed = childClose(child);
	const spawned = waitForSpawn(child);
	const terminal = ownDirectProcessTerminal(
		options.authoritySignal,
		child,
		spawned,
		exited,
		closed,
	);
	void terminal.authorityTermination.catch(() => undefined);
	try {
		await spawned;
	} catch (error) {
		await terminal.stop();
		if (options.authoritySignal.aborted) await terminal.authorityTermination;
		throw new CodexAppServerError("spawn", "Failed to start the supported Codex app-server", {
			cause: error,
		});
	}
	if (options.authoritySignal.aborted) await terminal.authorityTermination;
	child.stderr.resume();
	return {
		child,
		cwd,
		exited,
		closed,
		inputError,
		authorityTermination: terminal.authorityTermination,
		stop: () => terminal.stop(),
	};
}

export function stopCodexAppServerProcess(
	processRef: CodexAppServerProcess,
	reason: CodexAppServerStopReason = "closed",
): Promise<void> {
	const existingStop = processStops.get(processRef.child);
	if (existingStop !== undefined) return existingStop;
	const stop =
		processRef.stop?.(reason) ??
		stopProcessGroup(processRef.child, processRef.exited, processRef.closed);
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
	try {
		signalProcessGroup(pid, "SIGTERM");
		await Promise.race([exited, delay(STOP_GRACE_MS, undefined, { ref: false })]);
		if (isProcessGroupAlive(pid)) {
			await killProcessGroupAndProveTerminated(pid, closed, STOP_GRACE_MS, () =>
				child.kill("SIGKILL"),
			);
		} else {
			await proveProcessGroupTerminated(pid, closed, STOP_GRACE_MS);
		}
	} catch (error) {
		throw new CodexAppServerError("transport", "Codex process group did not terminate", {
			cause: error,
		});
	}
}

interface DirectProcessTerminal {
	readonly authorityTermination: Promise<void>;
	stop(): Promise<void>;
}

function ownDirectProcessTerminal(
	signal: AbortSignal,
	child: ChildProcess,
	spawned: Promise<void>,
	exited: Promise<unknown>,
	closed: Promise<unknown>,
): DirectProcessTerminal {
	let terminal: Promise<void> | null = null;
	let abortObserved = false;
	const signalFailures: unknown[] = [];
	let resolveAuthority!: () => void;
	let rejectAuthority!: (reason: unknown) => void;
	const authorityTermination = new Promise<void>((resolve, reject) => {
		resolveAuthority = resolve;
		rejectAuthority = reject;
	});

	const finish = (error?: unknown) => {
		signal.removeEventListener("abort", onAbort);
		child.removeListener("spawn", onSpawn);
		if (error !== undefined) {
			rejectAuthority(error);
		} else if (signal.aborted) {
			rejectAuthority(signal.reason);
		} else {
			resolveAuthority();
		}
	};
	const claim = (operation: () => Promise<void>): Promise<void> => {
		if (terminal !== null) return terminal;
		terminal = operation();
		void terminal.then(() => finish(), finish);
		return terminal;
	};
	const onSpawn = () => {
		if (signal.aborted) signalAuthorityProcessGroup(child, signalFailures);
	};
	const onAbort = () => {
		if (abortObserved) return;
		abortObserved = true;
		signalAuthorityProcessGroup(child, signalFailures);
		void claim(() => proveAuthorityProcessGroupTerminated(child, spawned, closed, signalFailures));
	};

	child.once("spawn", onSpawn);
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();

	return {
		authorityTermination,
		stop: () => claim(() => stopProcessGroup(child, exited, closed)),
	};
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

export async function verifyCodexCliVersion(
	executable: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	boundary: CodexProcessBoundary,
	signal: AbortSignal,
): Promise<void> {
	const prepared = await prepareContainedProcess(
		boundary,
		{
			executable,
			argv: ["--version"],
			cwd,
			env,
		},
		signal,
	);
	signal.throwIfAborted();
	const child = spawn(prepared.executable, [...prepared.argv], {
		cwd: prepared.cwd,
		detached: true,
		env: { ...prepared.env },
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
	});
	const exited = childExit(child);
	const closed = childClose(child);
	const spawned = waitForSpawn(child);
	const terminal = ownDirectProcessTerminal(signal, child, spawned, exited, closed);
	void terminal.authorityTermination.catch(() => undefined);
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
		await spawned;
		await Promise.race([
			closed.then(() => undefined),
			terminal.authorityTermination,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new CodexAppServerError("version", "Codex version probe timed out")),
					VERSION_PROBE_TIMEOUT_MS,
				);
			}),
		]);
		await terminal.stop();
		if (signal.aborted) await terminal.authorityTermination;
		const result = await closed;
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
		await terminal.stop();
		if (signal.aborted) await terminal.authorityTermination;
		if (error instanceof CodexAppServerError) throw error;
		throw new CodexAppServerError("spawn", "Failed to probe the Codex CLI version", {
			cause: error,
		});
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

async function spawnedPidWithinBound(
	child: ChildProcess,
	spawned: Promise<void>,
	closed: Promise<unknown>,
): Promise<number | null> {
	const unresolved = Symbol("unresolved-spawn");
	const result = await Promise.race([
		spawned.then(
			() => child.pid ?? null,
			() => null,
		),
		closed.then(() => null),
		delay(STOP_GRACE_MS, unresolved, { ref: false }),
	]);
	if (result === unresolved) {
		try {
			child.kill("SIGKILL");
		} catch {
			// The unresolved spawn is reported below; there is no PID to prove absent.
		}
		throw new CodexAppServerError(
			"transport",
			"Codex authority teardown could not resolve the spawned process",
		);
	}
	return result ?? child.pid ?? null;
}

async function proveAuthorityProcessGroupTerminated(
	child: ChildProcess,
	spawned: Promise<void>,
	closed: Promise<unknown>,
	signalFailures: readonly unknown[],
): Promise<void> {
	const pid = await spawnedPidWithinBound(child, spawned, closed);
	if (pid === null) return;
	try {
		await proveProcessGroupTerminated(pid, closed, STOP_GRACE_MS);
	} catch (proofFailure) {
		const cause =
			signalFailures.length === 0
				? proofFailure
				: new AggregateError(
						[...signalFailures, proofFailure],
						"Codex authority termination failed",
					);
		throw new CodexAppServerError("transport", "Codex authority teardown could not be proven", {
			cause,
		});
	}
}

function signalAuthorityProcessGroup(child: ChildProcess, failures: unknown[]): void {
	const pid = child.pid;
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGKILL");
		return;
	} catch (error) {
		if (errorCode(error) === "ESRCH") return;
		failures.push(error);
	}
	try {
		if (!child.kill("SIGKILL")) {
			throw new Error("Fallback process termination was not delivered");
		}
	} catch (error) {
		failures.push(error);
	}
}

async function prepareContainedProcess(
	boundary: CodexProcessBoundary,
	request: Parameters<CodexProcessBoundary["prepare"]>[0],
	signal: AbortSignal,
) {
	try {
		return await boundary.prepare(request, signal);
	} catch (error) {
		if (signal.aborted) signal.throwIfAborted();
		throw new CodexAppServerError("policy", "Codex process containment could not be prepared", {
			cause: error,
		});
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

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
