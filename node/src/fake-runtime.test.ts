import { describe, expect, it } from "vitest";
import { assertFakeRuntimeCredential } from "./fake-runtime.js";

describe("assertFakeRuntimeCredential", () => {
	it("accepts a test Node credential", () => {
		expect(() => assertFakeRuntimeCredential(`ar_node_test_${"a".repeat(32)}`)).not.toThrow();
	});

	it("refuses a live Node credential without exposing it", () => {
		const token = `ar_node_live_${"b".repeat(32)}`;
		let error: unknown;
		try {
			assertFakeRuntimeCredential(token);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("The fake adapter requires an ar_node_test_* credential");
		expect((error as Error).message).not.toContain(token);
	});
});
