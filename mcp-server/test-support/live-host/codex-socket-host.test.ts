import { describe, expect, it } from "vitest";
import { nativeCodexHeaders } from "./codex-socket-host.js";

describe("native Codex Unix WebSocket handshake", () => {
	it("omits optional compression without changing authentication or upgrade headers", () => {
		const headers = {
			Connection: "upgrade",
			"Sec-WebSocket-Extensions": "permessage-deflate",
			authorization: "fixture-value",
		};
		expect(nativeCodexHeaders(headers)).toEqual({
			Connection: "upgrade",
			authorization: "fixture-value",
		});
		expect(Object.keys(headers)).toHaveLength(3);
	});

	it("rejects malformed header pairs", () => {
		expect(() => nativeCodexHeaders(["Connection"])).toThrow();
		expect(() => nativeCodexHeaders({ Connection: 1 })).toThrow();
	});
});
