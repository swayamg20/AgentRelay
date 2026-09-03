import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	EMPTY_CONNECTOR_STATE,
	connectorCursor,
	connectorPickupDecision,
	connectorPickupKey,
	connectorStreamKey,
	loadConnectorState,
	persistConnectorProgress,
} from "./state.js";

const RELAY = "https://relay.example.test";
const AGENT = "agent-alice";
const SENDER = "bob@team";
const THREAD_A = "019fb4b5-5d71-72c2-b7ed-9d56847a32e6";
const THREAD_B = "01a02abd-9e1f-7991-9ec4-90fae3feb05b";
const EVENT_A = "b8bf5f45-7138-4ea1-89d9-7fa396cb785b";
const EVENT_B = "907b338a-068a-42a6-bb67-99e477a8a1bb";

describe("connector state", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "agentrelay-connector-state-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("uses stable opaque keys scoped by relay, recipient, sender, and thread", () => {
		expect(connectorStreamKey(`${RELAY}/`, AGENT)).toBe(connectorStreamKey(RELAY, AGENT));
		expect(connectorPickupKey(RELAY, AGENT, SENDER, THREAD_A)).not.toBe(
			connectorPickupKey(RELAY, AGENT, "carol@team", THREAD_A),
		);
		expect(connectorPickupKey(RELAY, AGENT, SENDER, THREAD_A)).not.toBe(
			connectorPickupKey(RELAY, AGENT, SENDER, THREAD_B),
		);
		expect(connectorPickupKey(RELAY, AGENT, SENDER, THREAD_A)).toMatch(/^[a-f0-9]{64}$/);
	});

	it("returns an empty state when no state file exists", async () => {
		const state = await loadConnectorState(join(dir, "missing.json"));
		expect(state).toEqual(EMPTY_CONNECTOR_STATE);
	});

	it("persists cursor and successful pickup together without raw routing keys", async () => {
		const path = join(dir, "connector-state.json");
		const queuedAt = new Date("2026-09-04T00:00:00.000Z");
		await persistConnectorProgress(
			{
				relayUrl: RELAY,
				agentId: AGENT,
				cursor: "7",
				pickup: { senderHandle: SENDER, threadId: THREAD_A, eventId: EVENT_A },
			},
			{ path, now: () => queuedAt },
		);

		const raw = await readFile(path, "utf8");
		expect(raw).not.toContain(RELAY);
		expect(raw).not.toContain(AGENT);
		expect(raw).not.toContain(SENDER);
		expect(raw).not.toContain(THREAD_A);

		const state = await loadConnectorState(path);
		expect(connectorCursor(state, RELAY, AGENT)).toBe("7");
		expect(
			connectorPickupDecision(
				state,
				{
					relayUrl: RELAY,
					agentId: AGENT,
					senderHandle: SENDER,
					threadId: THREAD_A,
					eventId: EVENT_A,
				},
				{ now: new Date("2026-09-04T00:00:30.000Z") },
			),
		).toBe("duplicate");
	});

	it("coalesces only a short same-sender, same-thread burst", async () => {
		const path = join(dir, "connector-state.json");
		await persistConnectorProgress(
			{
				relayUrl: RELAY,
				agentId: AGENT,
				cursor: "1",
				pickup: { senderHandle: SENDER, threadId: THREAD_A, eventId: EVENT_A },
			},
			{ path, now: () => new Date("2026-09-04T00:00:00.000Z") },
		);
		const state = await loadConnectorState(path);
		const reference = {
			relayUrl: RELAY,
			agentId: AGENT,
			senderHandle: SENDER,
			threadId: THREAD_A,
			eventId: EVENT_B,
		};
		expect(
			connectorPickupDecision(state, reference, {
				now: new Date("2026-09-04T00:00:04.999Z"),
			}),
		).toBe("coalesced");
		expect(
			connectorPickupDecision(state, reference, {
				now: new Date("2026-09-04T00:00:05.000Z"),
			}),
		).toBe("queue");
		expect(
			connectorPickupDecision(
				state,
				{ ...reference, senderHandle: "carol@team" },
				{ now: new Date("2026-09-04T00:00:01.000Z") },
			),
		).toBe("queue");
		expect(
			connectorPickupDecision(
				state,
				{ ...reference, threadId: THREAD_B },
				{ now: new Date("2026-09-04T00:00:01.000Z") },
			),
		).toBe("queue");
	});

	it("fails closed on malformed or unsupported persisted state", async () => {
		const invalidJson = join(dir, "invalid.json");
		await writeFile(invalidJson, "not json", "utf8");
		await expect(loadConnectorState(invalidJson)).rejects.toThrow("not valid JSON");

		const unsupported = join(dir, "unsupported.json");
		await writeFile(unsupported, JSON.stringify({ version: 2, streams: {} }), "utf8");
		await expect(loadConnectorState(unsupported)).rejects.toThrow("unsupported shape");

		const invalidCursor = join(dir, "invalid-cursor.json");
		await writeFile(
			invalidCursor,
			JSON.stringify({
				version: 1,
				streams: {
					mailbox: { cursor: "cursor-7", updated_at: "2026-09-04T00:00:00.000Z" },
				},
				pickups: {},
			}),
			"utf8",
		);
		await expect(loadConnectorState(invalidCursor)).rejects.toThrow("unsupported shape");
	});
});
