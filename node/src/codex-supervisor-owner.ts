import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { CodexProviderSupervisorCommand } from "./codex-provider-supervisor-protocol.js";
import {
	isProcessGroupAlive,
	killProcessGroupAndProveTerminated,
	proveOwnedPipesClosed,
	proveProcessGroupTerminated,
} from "./process-group-termination.js";

const STOP_GRACE_MS = 2_000;

export async function sendSupervisorCommand(
	child: ChildProcess,
	message: CodexProviderSupervisorCommand,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		if (!child.connected || child.send === undefined) {
			reject(new Error("Codex provider supervisor control channel is closed"));
			return;
		}
		child.send(message, (error) => (error === null ? resolve() : reject(error)));
	});
}

export async function stopSupervisorProcessGroup(
	child: ChildProcess,
	exited: Promise<unknown>,
	closed: Promise<unknown>,
	options: { readonly immediate?: boolean } = {},
): Promise<void> {
	const pid = child.pid;
	try {
		if (pid === undefined) {
			await proveOwnedPipesClosed(closed, STOP_GRACE_MS);
			return;
		}
		if (options.immediate === true) {
			await killProcessGroupAndProveTerminated(pid, closed, STOP_GRACE_MS, () =>
				child.kill("SIGKILL"),
			);
			return;
		}
		signalProcessGroup(pid, "SIGTERM");
		await Promise.race([exited, delay(STOP_GRACE_MS, undefined, { ref: false })]);
		if (isSupervisorProcessGroupAlive(pid)) {
			await killProcessGroupAndProveTerminated(pid, closed, STOP_GRACE_MS, () =>
				child.kill("SIGKILL"),
			);
			return;
		}
		await proveProcessGroupTerminated(pid, closed, STOP_GRACE_MS);
	} catch (error) {
		throw new Error("Codex provider process group did not terminate", { cause: error });
	}
}

export function isSupervisorProcessGroupAlive(pid: number): boolean {
	return isProcessGroupAlive(pid);
}

export function waitForChildSpawn(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", reject);
	});
}

export function childExit(
	child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

export function childClose(
	child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
}

export function writableError(child: ChildProcessWithoutNullStreams): Promise<Error> {
	return new Promise((resolve) => child.stdin.once("error", resolve));
}

export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch (error) {
		const code = errorCode(error);
		// EPERM is not absence. The caller must continue polling and fail closed
		// unless a later liveness probe proves the process group disappeared.
		if (code !== "ESRCH" && code !== "EPERM") throw error;
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
