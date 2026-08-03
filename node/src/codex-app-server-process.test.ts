import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readCodexLines } from "./codex-app-server-process.js";
import { MAX_CODEX_APP_SERVER_FRAME_BYTES } from "./codex-app-server-protocol.js";

describe("Codex app-server framing", () => {
	it("rejects an incomplete final frame", async () => {
		await expect(collect(readCodexLines(Readable.from(['{"id":1'])))).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "protocol",
		});
	});

	it("rejects a response above the UTF-8 byte limit before parsing", async () => {
		const oversized = "x".repeat(MAX_CODEX_APP_SERVER_FRAME_BYTES + 1);
		await expect(collect(readCodexLines(Readable.from([oversized])))).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "protocol",
		});
	});
});

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
	const values: string[] = [];
	for await (const line of lines) values.push(line);
	return values;
}
