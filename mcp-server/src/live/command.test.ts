import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FALLBACK_TRUST, type LoadTrustResult } from "../trust.js";
import { assertLiveConfig, assertLiveConsent, liveCommandSchema } from "./command.js";

describe("live CLI consent", () => {
	it("requires explicit read/reply consent, peer, Relay UUID and bounded limits", () => {
		const good = { peer: "b@team", handoff: randomUUID(), allowReplies: true };
		expect(liveCommandSchema.parse(good)).toMatchObject({
			maxTurns: 6,
			ttlSeconds: 900,
			show: false,
		});
		for (const patch of [
			{ allowReplies: false },
			{ allowReplies: undefined },
			{ peer: "" },
			{ handoff: "not-a-uuid" },
			{ maxTurns: 13 },
			{ maxTurns: 0 },
			{ ttlSeconds: 1801 },
		]) {
			expect(liveCommandSchema.safeParse({ ...good, ...patch }).success).toBe(false);
		}
	});
	it("does not inherit pickup consent, override blocks or treat malformed policy as approval", () => {
		const peer = "b@team";
		const allowed: LoadTrustResult = {
			ok: true,
			source: "file",
			path: "trust",
			trust: { ...FALLBACK_TRUST, teammates: { [peer]: { auto_pickup: true, auto_read: true } } },
		};
		expect(() => assertLiveConsent(allowed, peer)).not.toThrow();
		for (const trust of [
			{ ...allowed.trust, blocked: [peer] },
			{ ...allowed.trust, teammates: { [peer]: { auto_pickup: true, auto_read: false } } },
			{
				...allowed.trust,
				teammates: {},
				defaults: { auto_pickup: true, auto_read: true },
				unknown_teammates: { policy: "allow_with_default_trust" as const },
			},
		])
			expect(() => assertLiveConsent({ ...allowed, trust }, peer)).toThrow();
		expect(() =>
			assertLiveConsent({ ok: false, reason: "invalid", path: "trust" }, peer),
		).toThrow();
	});
	it("stops on credential or identity changes without exposing credentials", () => {
		const config = {
			relay_url: "https://relay.example",
			agent_id: randomUUID(),
			agent_handle: "a@team",
			api_key: "secret",
			default_session_id: null,
		};
		expect(() => assertLiveConfig(config, { ...config })).not.toThrow();
		for (const key of ["relay_url", "agent_id", "agent_handle", "api_key"])
			expect(() => assertLiveConfig(config, { ...config, [key]: "different-secret" })).toThrow(
				"changed",
			);
	});
});
