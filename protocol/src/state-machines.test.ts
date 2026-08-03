import { describe, expect, it } from "vitest";
import {
	type DeliveryStatus,
	type MissionStatus,
	deliveryStatusSchema,
	missionStatusSchema,
} from "./schemas.js";
import {
	type DeliveryTransitionEvent,
	type DeliveryTransitionState,
	InvalidFencingTokenError,
	InvalidLeaseClaimError,
	InvalidTransitionError,
	type MissionTransitionEvent,
	assertActiveDeliveryClaim,
	deliveryTransitionEventTypes,
	missionTransitionEventTypes,
	transitionDeliveryState,
	transitionMissionStatus,
} from "./state-machines.js";

const missionStatuses = missionStatusSchema.options;
const missionEvents: MissionTransitionEvent[] = missionTransitionEventTypes.map((type) => ({
	type,
}));

const allowedMissionTransitions = new Map<string, MissionStatus>([
	["awaiting_acceptance:participants_accepted", "active"],
	["awaiting_acceptance:cancel", "cancelled"],
	["awaiting_acceptance:expire", "expired"],
	["awaiting_acceptance:fail", "failed"],
	["active:participants_ready", "verifying"],
	["active:blocking_required", "blocked"],
	["active:cancel", "cancelled"],
	["active:expire", "expired"],
	["active:fail", "failed"],
	["verifying:blocking_required", "blocked"],
	["verifying:verification_passed", "completed"],
	["verifying:verification_failed", "active"],
	["verifying:cancel", "cancelled"],
	["verifying:expire", "expired"],
	["verifying:fail", "failed"],
	["blocked:block_resolved", "active"],
	["blocked:cancel", "cancelled"],
	["blocked:expire", "expired"],
	["blocked:fail", "failed"],
]);

const deliveryStatuses = deliveryStatusSchema.options;
const deliveryEvents: DeliveryTransitionEvent[] = deliveryTransitionEventTypes.map(deliveryEvent);

const allowedDeliveryTransitions = new Map<string, DeliveryStatus>([
	["stored:lease", "leased"],
	["stored:cancel", "cancelled"],
	["leased:renew_lease", "leased"],
	["leased:start_execution", "executing"],
	["leased:release", "stored"],
	["leased:lease_expired", "stored"],
	["leased:cancel", "cancelled"],
	["executing:renew_lease", "executing"],
	["executing:acknowledge", "acknowledged"],
	["executing:release", "stored"],
	["executing:lease_expired", "stored"],
	["executing:cancel", "cancelled"],
]);

describe("transitionMissionStatus", () => {
	it("implements every allowed edge and rejects every other status/event pair", () => {
		for (const status of missionStatuses) {
			for (const event of missionEvents) {
				const expected = allowedMissionTransitions.get(`${status}:${event.type}`);
				if (expected !== undefined) {
					expect(transitionMissionStatus(status, event)).toBe(expected);
				} else {
					expect(() => transitionMissionStatus(status, event)).toThrow(InvalidTransitionError);
				}
			}
		}
	});

	it.each(["completed", "cancelled", "expired", "failed"] as const)(
		"rejects delayed events after terminal status %s",
		(status) => {
			for (const event of missionEvents) {
				expect(() => transitionMissionStatus(status, event)).toThrow(InvalidTransitionError);
			}
		},
	);

	it("reports the rejected mission transition", () => {
		try {
			transitionMissionStatus("awaiting_acceptance", { type: "participants_ready" });
			expect.fail("transition should have failed");
		} catch (error) {
			expect(error).toBeInstanceOf(InvalidTransitionError);
			expect(error).toMatchObject({
				machine: "mission",
				currentStatus: "awaiting_acceptance",
				eventType: "participants_ready",
			});
		}
	});
});

describe("transitionDeliveryState", () => {
	it("implements every allowed edge and rejects every other status/event pair", () => {
		for (const status of deliveryStatuses) {
			for (const event of deliveryEvents) {
				const expected = allowedDeliveryTransitions.get(`${status}:${event.type}`);
				const state = deliveryState(status, {
					logicallySettled: event.type === "acknowledge",
				});
				if (expected !== undefined) {
					expect(transitionDeliveryState(state, event).status).toBe(expected);
				} else {
					expect(() => transitionDeliveryState(state, event)).toThrow(InvalidTransitionError);
				}
			}
		}
	});

	it.each(["acknowledged", "cancelled", "dead_lettered"] as const)(
		"rejects delayed events after terminal status %s",
		(status) => {
			for (const event of deliveryEvents) {
				expect(() => transitionDeliveryState(deliveryState(status), event)).toThrow(
					InvalidTransitionError,
				);
			}
		},
	);

	it("increments attempts and installs only a newer fencing token when leasing", () => {
		expect(
			transitionDeliveryState(deliveryState("stored"), {
				type: "lease",
				leaseId: "00000000-0000-4000-8000-000000000002",
				fencingToken: "2",
				now: "2026-08-02T10:00:00.000Z",
				expiresAt: "2026-08-02T10:10:00.000Z",
			}),
		).toEqual({
			status: "leased",
			attemptCount: 2,
			maxAttempts: 3,
			lastFencingToken: "2",
			activeLeaseId: "00000000-0000-4000-8000-000000000002",
			activeFencingToken: "2",
			leaseExpiresAt: "2026-08-02T10:10:00.000Z",
			logicallySettled: false,
		});
		expect(() =>
			transitionDeliveryState(deliveryState("stored"), {
				type: "lease",
				leaseId: "00000000-0000-4000-8000-000000000002",
				fencingToken: "1",
				now: "2026-08-02T10:00:00.000Z",
				expiresAt: "2026-08-02T10:10:00.000Z",
			}),
		).toThrow(InvalidTransitionError);
	});

	it("rejects a stale owner and preserves the active fence while executing", () => {
		const executing = transitionDeliveryState(deliveryState("leased"), {
			type: "start_execution",
			leaseId: "00000000-0000-4000-8000-000000000001",
			fencingToken: "1",
			now: "2026-08-02T10:01:00.000Z",
		});
		expect(executing.activeFencingToken).toBe("1");
		expect(() =>
			transitionDeliveryState(executing, {
				type: "acknowledge",
				leaseId: "00000000-0000-4000-8000-000000000001",
				fencingToken: "0",
				now: "2026-08-02T10:02:00.000Z",
			}),
		).toThrow(InvalidFencingTokenError);
	});

	it("lets a renewed claim recover while rejecting the expired owner", () => {
		const expired = transitionDeliveryState(deliveryState("leased"), {
			type: "lease_expired",
			leaseId: "00000000-0000-4000-8000-000000000001",
			fencingToken: "1",
			now: "2026-08-02T10:05:00.000Z",
		});
		const renewed = transitionDeliveryState(expired, {
			type: "lease",
			leaseId: "00000000-0000-4000-8000-000000000002",
			fencingToken: "2",
			now: "2026-08-02T10:06:00.000Z",
			expiresAt: "2026-08-02T10:10:00.000Z",
		});

		expect(() =>
			assertActiveDeliveryClaim(renewed, {
				leaseId: "00000000-0000-4000-8000-000000000001",
				fencingToken: "1",
				now: "2026-08-02T10:07:00.000Z",
			}),
		).toThrow(InvalidLeaseClaimError);
		expect(() =>
			assertActiveDeliveryClaim(renewed, {
				leaseId: "00000000-0000-4000-8000-000000000002",
				fencingToken: "2",
				now: "2026-08-02T10:07:00.000Z",
			}),
		).not.toThrow();
	});

	it("rejects a matching holder at lease expiry and premature expiry transitions", () => {
		const leased = deliveryState("leased");
		expect(() =>
			assertActiveDeliveryClaim(leased, {
				leaseId: "00000000-0000-4000-8000-000000000001",
				fencingToken: "1",
				now: "2026-08-02T10:05:00.000Z",
			}),
		).toThrow(InvalidLeaseClaimError);
		expect(() =>
			transitionDeliveryState(leased, {
				type: "lease_expired",
				leaseId: "00000000-0000-4000-8000-000000000001",
				fencingToken: "1",
				now: "2026-08-02T10:04:59.999Z",
			}),
		).toThrow(InvalidLeaseClaimError);
	});

	it("renews only the current unexpired authority without consuming an attempt", () => {
		const renewed = transitionDeliveryState(deliveryState("executing"), {
			type: "renew_lease",
			leaseId: "00000000-0000-4000-8000-000000000001",
			fencingToken: "1",
			now: "2026-08-02T10:02:00.000Z",
			expiresAt: "2026-08-02T10:10:00.000Z",
		});

		expect(renewed).toMatchObject({
			status: "executing",
			attemptCount: 1,
			lastFencingToken: "1",
			leaseExpiresAt: "2026-08-02T10:10:00.000Z",
		});
	});

	it("acknowledges only atomically settled executing work", () => {
		const authority = {
			leaseId: "00000000-0000-4000-8000-000000000001",
			fencingToken: "1",
			now: "2026-08-02T10:02:00.000Z",
		};
		expect(() =>
			transitionDeliveryState(deliveryState("executing"), {
				type: "acknowledge",
				...authority,
			}),
		).toThrow(InvalidTransitionError);
		expect(
			transitionDeliveryState(deliveryState("executing", { logicallySettled: true }), {
				type: "acknowledge",
				...authority,
			}),
		).toMatchObject({ status: "acknowledged", activeLeaseId: null });
	});

	it("dead-letters transient releases when the attempt budget is exhausted", () => {
		const exhausted = { ...deliveryState("executing"), attemptCount: 3 };
		expect(
			transitionDeliveryState(exhausted, {
				type: "release",
				classification: "transient",
				leaseId: "00000000-0000-4000-8000-000000000001",
				fencingToken: "1",
				now: "2026-08-02T10:02:00.000Z",
			}),
		).toMatchObject({
			status: "dead_lettered",
			activeLeaseId: null,
			activeFencingToken: null,
			leaseExpiresAt: null,
		});
	});

	it.each(["permanent", "policy_denied"] as const)(
		"dead-letters a %s release immediately",
		(classification) => {
			expect(
				transitionDeliveryState(deliveryState("leased"), {
					type: "release",
					classification,
					leaseId: "00000000-0000-4000-8000-000000000001",
					fencingToken: "1",
					now: "2026-08-02T10:02:00.000Z",
				}),
			).toMatchObject({ status: "dead_lettered", activeLeaseId: null });
		},
	);

	it("dead-letters an expired final attempt and lets the relay cancel active work", () => {
		expect(
			transitionDeliveryState(deliveryState("leased", { attemptCount: 3 }), {
				type: "lease_expired",
				leaseId: "00000000-0000-4000-8000-000000000001",
				fencingToken: "1",
				now: "2026-08-02T10:05:00.000Z",
			}),
		).toMatchObject({ status: "dead_lettered", activeLeaseId: null });
		expect(
			transitionDeliveryState(deliveryState("executing"), {
				type: "cancel",
				reason: "mission_cancelled",
				now: "2026-08-02T10:02:00.000Z",
			}),
		).toMatchObject({ status: "cancelled", activeLeaseId: null });
	});
});

function deliveryState(
	status: DeliveryStatus,
	overrides: Partial<DeliveryTransitionState> = {},
): DeliveryTransitionState {
	const active = status === "leased" || status === "executing";
	return {
		status,
		attemptCount: 1,
		maxAttempts: 3,
		lastFencingToken: "1",
		activeLeaseId: active ? "00000000-0000-4000-8000-000000000001" : null,
		activeFencingToken: active ? "1" : null,
		leaseExpiresAt: active ? "2026-08-02T10:05:00.000Z" : null,
		logicallySettled: false,
		...overrides,
	};
}

function deliveryEvent(
	type: (typeof deliveryTransitionEventTypes)[number],
): DeliveryTransitionEvent {
	if (type === "lease") {
		return {
			type,
			leaseId: "00000000-0000-4000-8000-000000000002",
			fencingToken: "2",
			now: "2026-08-02T10:00:00.000Z",
			expiresAt: "2026-08-02T10:10:00.000Z",
		};
	}
	if (type === "renew_lease") {
		return {
			type,
			leaseId: "00000000-0000-4000-8000-000000000001",
			fencingToken: "1",
			now: "2026-08-02T10:01:00.000Z",
			expiresAt: "2026-08-02T10:10:00.000Z",
		};
	}
	if (type === "release") {
		return {
			type,
			classification: "transient",
			leaseId: "00000000-0000-4000-8000-000000000001",
			fencingToken: "1",
			now: "2026-08-02T10:01:00.000Z",
		};
	}
	if (type === "cancel") {
		return {
			type,
			reason: "mission_cancelled",
			now: "2026-08-02T10:01:00.000Z",
		};
	}
	return {
		type,
		leaseId: "00000000-0000-4000-8000-000000000001",
		fencingToken: "1",
		now: type === "lease_expired" ? "2026-08-02T10:05:00.000Z" : "2026-08-02T10:01:00.000Z",
	};
}
