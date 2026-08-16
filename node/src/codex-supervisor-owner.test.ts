import { afterEach, describe, expect, it, vi } from "vitest";
import { isSupervisorProcessGroupAlive, signalProcessGroup } from "./codex-supervisor-owner.js";

afterEach(() => vi.restoreAllMocks());

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

		expect(() => isSupervisorProcessGroupAlive(42)).toThrow(failure);
		expect(() => signalProcessGroup(42, "SIGTERM")).toThrow(failure);
	});
});

function processError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`kill ${code}`), { code });
}
