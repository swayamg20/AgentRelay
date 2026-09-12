import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createProbeMcpServer, signalClaudeProbe } from "./probe-mcp-server.js";
import { type ProbeEvent, ProbeSession } from "./probe-session.js";

function fixture() {
	const events: ProbeEvent[] = [];
	const session = new ProbeSession({
		turns: 3,
		expiresAt: 100,
		now: () => 0,
		onEvent: (e) => events.push(e),
	});
	return { session, events };
}

describe("local host probe", () => {
	it("records observation and correlated replies independently of a signal", () => {
		const { session, events } = fixture();
		for (let index = 0; index < 3; index++) {
			const reference = session.nextReference()!;
			session.markSignalWritten(reference);
			expect(events.at(-1)?.stage).toBe("signal_written");
			const turn = session.receive(reference);
			expect(turn.peer_data.agentrelay_provenance.trust).toBe("untrusted");
			expect(
				session.reply({ ...reference, answer: `PONG:${turn.peer_data.challenge}` }).replayed,
			).toBe(false);
		}
		expect(session.nextReference()).toBeNull();
		expect(events.filter((event) => event.stage === "reply_recorded")).toHaveLength(3);
	});

	it("can observe an authorized reference before the transport write resolves", () => {
		const { session, events } = fixture();
		const reference = session.nextReference()!;
		session.receive(reference);
		session.markSignalWritten(reference);
		expect(events.map((event) => event.stage)).toEqual(["turn_observed", "signal_written"]);
	});

	it("requires exact session, message and attempt identity", () => {
		const { session } = fixture();
		const reference = session.nextReference()!;
		session.markSignalWritten(reference);
		for (const field of ["session_id", "message_id", "attempt_id"]) {
			expect(() => session.receive({ ...reference, [field]: randomUUID() })).toThrow("Unknown");
		}
		expect(() => session.receive({ ...reference, cwd: "/tmp" })).toThrow();
	});

	it("replays an identical reply and rejects a changed reply", () => {
		const { session, events } = fixture();
		const reference = session.nextReference()!;
		session.markSignalWritten(reference);
		session.markSignalWritten(reference);
		expect(() => session.reply({ ...reference, answer: "guess" })).toThrow("before replying");
		const turn = session.receive(reference);
		const input = { ...reference, answer: `PONG:${turn.peer_data.challenge}` };
		const first = session.reply(input);
		expect(session.reply(input)).toEqual({ reply_id: first.reply_id, replayed: true });
		expect(() => session.reply({ ...input, answer: "changed" })).toThrow("Conflicting");
		expect(events.filter((event) => event.stage === "reply_recorded")).toHaveLength(1);
	});

	it("does not accept a reply without the fetched challenge", () => {
		const { session } = fixture();
		const reference = session.nextReference()!;
		session.markSignalWritten(reference);
		session.receive(reference);
		expect(() => session.reply({ ...reference, answer: "PONG:guessed" })).toThrow("mismatch");
	});

	it("stops reads and replies after local stop or expiry", () => {
		const { session } = fixture();
		const reference = session.nextReference()!;
		session.markSignalWritten(reference);
		const turn = session.receive(reference);
		session.stop();
		expect(() => session.receive(reference)).toThrow("stopped");
		expect(() =>
			session.reply({ ...reference, answer: `PONG:${turn.peer_data.challenge}` }),
		).toThrow("stopped");
		const expired = new ProbeSession({
			turns: 1,
			expiresAt: 10,
			now: () => 10,
			onEvent: () => undefined,
		});
		expect(() => expired.nextReference()).toThrow("expired");
	});
});

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const action of close.splice(0)) await action();
});

describe("probe MCP wire", () => {
	it("declares only the channel capability and emits references without peer content", async () => {
		const { session, events } = fixture();
		const server = createProbeMcpServer({ session, channel: true });
		const client = new Client({ name: "probe-test", version: "1" });
		close.push(
			() => client.close(),
			() => server.close(),
		);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const notificationSchema = z.object({
			method: z.literal("notifications/claude/channel"),
			params: z.object({ content: z.string(), meta: z.record(z.string()) }),
		});
		let signal: z.infer<typeof notificationSchema> | undefined;
		client.setNotificationHandler(notificationSchema, (value) => {
			signal = value;
		});
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		expect(client.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {} });
		const reference = session.nextReference()!;
		await signalClaudeProbe(server, reference);
		expect(signal?.params.meta).toEqual(reference);
		expect(signal?.params.content).not.toContain("PONG");
		expect(signal?.params.content).not.toContain("synthetic-peer");
		expect(events).toEqual([]);
		session.markSignalWritten(reference);
		const received = await client.callTool({ name: "receive_live_turn", arguments: reference });
		expect(received.isError).not.toBe(true);
		const invalid = await client.callTool({
			name: "reply_live_turn",
			arguments: { ...reference, answer: "wrong" },
		});
		expect(invalid.isError).toBe(true);
		expect(events.map((event) => event.stage)).toEqual(["signal_written", "turn_observed"]);
	});
});
