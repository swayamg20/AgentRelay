import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createProbeMcpServer, signalClaudeProbe } from "./probe-mcp-server.js";
import { ProbeSession } from "./probe-session.js";

const parsed = parseArgs({ options: { events: { type: "string" } }, strict: true });
const eventsPath = z.string().min(1).parse(parsed.values.events);
const record = (event: object) => {
	appendFileSync(eventsPath, `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`);
};
let timer: ReturnType<typeof setTimeout> | undefined;
let closed = false;
const session = new ProbeSession({
	turns: 3,
	expiresAt: Date.now() + 120_000,
	onEvent: record,
});
const server = createProbeMcpServer({ session, channel: true, onReply: () => schedule(500) });

function schedule(delay: number) {
	if (closed) return;
	clearTimeout(timer);
	timer = setTimeout(() => {
		void signalNext().catch(() => record({ stage: "signal_failed" }));
	}, delay);
}

async function signalNext() {
	const reference = session.nextReference();
	if (reference === null) return;
	await signalClaudeProbe(server, reference);
	session.markSignalWritten(reference);
}

server.oninitialized = () => {
	record({ stage: "mcp_initialized" });
	schedule(2_000);
};
server.onclose = () => {
	closed = true;
	clearTimeout(timer);
	session.stop();
};
await server.connect(new StdioServerTransport());
