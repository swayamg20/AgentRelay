import { describe, expect, it } from "vitest";
import { ERROR_MAP, RelayError } from "./errors.js";

describe("RelayError", () => {
	it("exposes mapped HTTP and RPC codes", () => {
		const err = new RelayError("thread_terminal", "thread is done");
		expect(err.httpStatus).toBe(409);
		expect(err.rpcCode).toBe(-32007);
	});

	it("serializes to envelope shape", () => {
		const err = new RelayError("not_a_participant", "nope", { thread_id: "abc" });
		const envelope = err.toEnvelope("req_xyz");
		expect(envelope).toEqual({
			code: "not_a_participant",
			message: "nope",
			request_id: "req_xyz",
			details: { thread_id: "abc" },
		});
	});

	it("error map covers all known symbols with consistent shapes", () => {
		for (const [symbol, mapping] of Object.entries(ERROR_MAP)) {
			expect(typeof mapping.rpc).toBe("number");
			expect(typeof mapping.http).toBe("number");
			expect(symbol.length).toBeGreaterThan(0);
		}
	});
});
