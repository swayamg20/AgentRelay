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
	["stored:terminal_failure", "dead_lettered"],
	["leased:start_execution", "executing"],
	["leased:retry", "stored"],
	["leased:lease_expired", "stored"],
	["leased:terminal_failure", "dead_lettered"],
	["executing:acknowledge", "acknowledged"],
	["executing:retry", "stored"],
	["executing:lease_expired", "stored"],
	["executing:terminal_failure", "dead_lettered"],
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
				if (expected !== undefined) {
					expect(transitionDeliveryState(deliveryState(status), event).status).toBe(expected);
				} else {
					expect(() => transitionDeliveryState(deliveryState(status), event)).toThrow(
						InvalidTransitionError,
					);
				}
			}
		}
	});

	it.each(["acknowledged", "dead_lettered"] as const)(
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

	it("dead-letters retryable work when the attempt budget is exhausted", () => {
		const exhausted = { ...deliveryState("executing"), attemptCount: 3 };
		expect(
			transitionDeliveryState(exhausted, {
				type: "retry",
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
});

function deliveryState(status: DeliveryStatus): DeliveryTransitionState {
	const active = status === "leased" || status === "executing";
	return {
		status,
		attemptCount: 1,
		maxAttempts: 3,
		lastFencingToken: "1",
		activeLeaseId: active ? "00000000-0000-4000-8000-000000000001" : null,
		activeFencingToken: active ? "1" : null,
		leaseExpiresAt: active ? "2026-08-02T10:05:00.000Z" : null,
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
	return {
		type,
		leaseId: "00000000-0000-4000-8000-000000000001",
		fencingToken: "1",
		now: type === "lease_expired" ? "2026-08-02T10:05:00.000Z" : "2026-08-02T10:01:00.000Z",
	};
}
