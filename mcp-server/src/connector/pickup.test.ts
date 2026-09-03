import { describe, expect, it } from "vitest";
import { FALLBACK_TRUST, type TrustFile } from "../trust.js";
import { planAutoPickup } from "./pickup.js";

const REFERENCE = {
	eventId: "b8bf5f45-7138-4ea1-89d9-7fa396cb785b",
	threadId: "019fb4b5-5d71-72c2-b7ed-9d56847a32e6",
	senderHandle: "bob@team",
};

function trust(entry: TrustFile["teammates"][string]): TrustFile {
	return {
		...FALLBACK_TRUST,
		teammates: { "bob@team": entry },
	};
}

describe("planAutoPickup", () => {
	it("creates attention only for exact-sender consent", () => {
		expect(planAutoPickup(trust({ auto_pickup: true, auto_read: true }), REFERENCE)).toEqual({
			eventId: REFERENCE.eventId,
			threadId: REFERENCE.threadId,
		});
	});

	it("does not grant pickup from listed membership or auto_read", () => {
		expect(planAutoPickup(trust({ auto_read: true }), REFERENCE)).toBeNull();
		expect(planAutoPickup(trust({ auto_pickup: false, auto_read: true }), REFERENCE)).toBeNull();
	});

	it("does not grant pickup through unknown-sender defaults", () => {
		const defaultsAttempt = {
			...FALLBACK_TRUST,
			unknown_teammates: { policy: "allow_with_default_trust" as const },
			defaults: { auto_read: true, auto_pickup: true },
		} as TrustFile;
		expect(planAutoPickup(defaultsAttempt, REFERENCE)).toBeNull();
	});

	it("lets the local block list revoke pickup", () => {
		const blocked = {
			...trust({ auto_pickup: true, auto_read: true }),
			blocked: [REFERENCE.senderHandle],
		};
		expect(planAutoPickup(blocked, REFERENCE)).toBeNull();
	});
});
