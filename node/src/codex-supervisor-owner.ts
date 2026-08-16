import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type {
	CodexProviderObservation,
	CodexProviderStopCause,
} from "./codex-provider-generation-state.js";
import type { CodexProviderSupervisorCommand } from "./codex-provider-supervisor-protocol.js";

const STOP_GRACE_MS = 2_000;
const GROUP_POLL_MS = 10;

export function observationForCause(cause: CodexProviderStopCause): CodexProviderObservation {
	if (
		cause === "deadline_exceeded" ||
		cause === "heartbeat_timeout" ||
		cause === "provider_unresponsive"
	) {
		return "unresponsive";
	}
	if (cause === "provider_failure" || cause === "startup_failure") return "crashed";
	return "stopped";
}

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
): Promise<void> {
	const pid = child.pid;
	if (pid === undefined) return;
	signalProcessGroup(pid, "SIGTERM");
	await Promise.race([exited, delay(STOP_GRACE_MS)]);
	if (isSupervisorProcessGroupAlive(pid)) signalProcessGroup(pid, "SIGKILL");
	const deadline = Date.now() + STOP_GRACE_MS;
	while (isSupervisorProcessGroupAlive(pid)) {
		if (Date.now() >= deadline) throw new Error("Codex provider process group did not terminate");
		await delay(GROUP_POLL_MS);
	}
	await Promise.race([
		closed,
		delay(STOP_GRACE_MS).then(() => {
			throw new Error("Codex provider supervisor pipes did not close");
		}),
	]);
}

export function isSupervisorProcessGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		if (errorCode(error) === "ESRCH") return false;
		throw error;
	}
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
