import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isSupervisorProcessGroupAlive,
	signalProcessGroup,
	stopSupervisorProcessGroup,
} from "./codex-supervisor-owner.js";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("Codex supervisor process-group ownership", () => {
	it("treats EPERM as present rather than quiescent", () => {
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw processError("EPERM");
		});

		expect(isSupervisorProcessGroupAlive(42)).toBe(true);
	});

	it("treats only ESRCH as proof of process-group absence", () => {
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw processError("ESRCH");
		});

		expect(isSupervisorProcessGroupAlive(42)).toBe(false);
	});

	it("leaves an EPERM group for the liveness loop to prove", () => {
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {
			throw processError("EPERM");
		});

		expect(() => signalProcessGroup(42, "SIGKILL")).not.toThrow();
		expect(kill).toHaveBeenCalledWith(-42, "SIGKILL");
	});

	it("does not hide unexpected process-group probe failures", () => {
		const failure = processError("EINVAL");
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw failure;
		});

		let livenessFailure: unknown;
		try {
			isSupervisorProcessGroupAlive(42);
		} catch (error) {
			livenessFailure = error;
		}
		expect(livenessFailure).toMatchObject({
			name: "ProcessGroupTerminationError",
			reason: "liveness_unknown",
			cause: failure,
		});
		expect(() => signalProcessGroup(42, "SIGTERM")).toThrow(failure);
	});

	it("rejects teardown when the group is absent but an owned pipe remains open", async () => {
		vi.useFakeTimers();
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw processError("ESRCH");
		});
		const child = { pid: 42, kill: vi.fn() } as unknown as ChildProcess;
		const neverClosed = new Promise<never>(() => undefined);

		const stopping = stopSupervisorProcessGroup(child, Promise.resolve(), neverClosed);
		const failure = stopping.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(2_001);

		expect(await failure).toMatchObject({
			message: "Codex provider process group did not terminate",
			cause: {
				name: "ProcessGroupTerminationError",
				reason: "pipes_open",
			},
		});
	});

	it("rejects teardown when spawn has no PID and an owned pipe remains open", async () => {
		vi.useFakeTimers();
		const child = { pid: undefined, kill: vi.fn() } as unknown as ChildProcess;
		const neverClosed = new Promise<never>(() => undefined);

		const stopping = stopSupervisorProcessGroup(child, Promise.resolve(), neverClosed);
		const failure = stopping.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(2_001);

		expect(await failure).toMatchObject({
			message: "Codex provider process group did not terminate",
			cause: {
				name: "ProcessGroupTerminationError",
				reason: "pipes_open",
			},
		});
	});
});

function processError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`kill ${code}`), { code });
}
