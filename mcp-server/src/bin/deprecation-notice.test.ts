import { describe, expect, it } from "vitest";
import { shouldEmitDeprecationNotice } from "./deprecation-notice.js";

describe("agentrelay-mcp deprecation notice", () => {
	it("emits by default when stdin is not TTY", () => {
		expect(shouldEmitDeprecationNotice({}, false)).toBe(true);
	});

	it("does not emit when AGENTRELAY_SUPPRESS_DEPRECATION=1", () => {
		expect(shouldEmitDeprecationNotice({ AGENTRELAY_SUPPRESS_DEPRECATION: "1" }, false)).toBe(
			false,
		);
	});

	it("does not emit when stdin is TTY", () => {
		expect(shouldEmitDeprecationNotice({}, true)).toBe(false);
	});

	it("does not emit when suppression env and TTY are both present", () => {
		expect(shouldEmitDeprecationNotice({ AGENTRELAY_SUPPRESS_DEPRECATION: "1" }, true)).toBe(
			false,
		);
	});
});
