import { setTimeout as delay } from "node:timers/promises";

const PROCESS_GROUP_POLL_MS = 10;

export class ProcessGroupTerminationError extends Error {
	constructor(
		readonly reason: "group_present" | "pipes_open" | "liveness_unknown",
		options: ErrorOptions = {},
	) {
		super(`Process-group termination could not be proven: ${reason}`, options);
		this.name = "ProcessGroupTerminationError";
	}
}

/** Proves both OS process-group absence and closure of the owned child pipes. */
export async function proveProcessGroupTerminated(
	pid: number,
	closed: Promise<unknown>,
	timeoutMs: number,
): Promise<void> {
	await Promise.all([
		waitForProcessGroupAbsence(pid, timeoutMs),
		proveOwnedPipesClosed(closed, timeoutMs),
	]);
}

export async function proveOwnedPipesClosed(
	closed: Promise<unknown>,
	timeoutMs: number,
): Promise<void> {
	await Promise.race([
		closed,
		delay(timeoutMs, undefined, { ref: false }).then(() => {
			throw new ProcessGroupTerminationError("pipes_open");
		}),
	]);
}

/** Immediately kills an owned detached process group and proves that no work or pipes remain. */
export async function killProcessGroupAndProveTerminated(
	pid: number,
	closed: Promise<unknown>,
	timeoutMs: number,
	fallbackKill?: () => boolean | undefined,
): Promise<void> {
	let signalFailure: unknown;
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if (errorCode(error) !== "ESRCH") {
			signalFailure = error;
			try {
				if (fallbackKill?.() === false) {
					throw new Error("Fallback process termination was not delivered");
				}
			} catch (fallbackError) {
				signalFailure = new AggregateError(
					[signalFailure, fallbackError],
					"Process-group termination signals failed",
				);
			}
		}
	}

	try {
		await proveProcessGroupTerminated(pid, closed, timeoutMs);
	} catch (proofFailure) {
		if (signalFailure === undefined) throw proofFailure;
		const reason =
			proofFailure instanceof ProcessGroupTerminationError
				? proofFailure.reason
				: "liveness_unknown";
		throw new ProcessGroupTerminationError(reason, {
			cause: new AggregateError(
				[signalFailure, proofFailure],
				"Process-group termination could not be proven",
			),
		});
	}
}

export function isProcessGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		if (errorCode(error) === "ESRCH") return false;
		if (errorCode(error) === "EPERM") return true;
		throw new ProcessGroupTerminationError("liveness_unknown", { cause: error });
	}
}

async function waitForProcessGroupAbsence(pid: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (isProcessGroupAlive(pid)) {
		if (Date.now() >= deadline) throw new ProcessGroupTerminationError("group_present");
		await delay(PROCESS_GROUP_POLL_MS, undefined, { ref: false });
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
