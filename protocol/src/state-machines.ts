import {
	type DeliveryCancellationReason,
	type DeliveryReleaseClassification,
	type DeliveryStatus,
	type MissionStatus,
	deliveryCancellationReasonSchema,
	deliveryReleaseClassificationSchema,
	isoTimestampSchema,
	uuidSchema,
} from "./schemas.js";

export const missionTransitionEventTypes = [
	"participants_accepted",
	"participants_ready",
	"blocking_required",
	"block_resolved",
	"verification_passed",
	"verification_failed",
	"cancel",
	"expire",
	"fail",
] as const;

export type MissionTransitionEvent = {
	type: (typeof missionTransitionEventTypes)[number];
};

export const deliveryTransitionEventTypes = [
	"lease",
	"renew_lease",
	"start_execution",
	"acknowledge",
	"release",
	"lease_expired",
	"cancel",
] as const;

export interface DeliveryClaim {
	readonly leaseId: string;
	readonly fencingToken: string;
	readonly now: string;
}

export type DeliveryTransitionEvent =
	| ({ type: "lease"; expiresAt: string } & DeliveryClaim)
	| ({ type: "renew_lease"; expiresAt: string } & DeliveryClaim)
	| ({ type: "start_execution" } & DeliveryClaim)
	| ({ type: "acknowledge" } & DeliveryClaim)
	| ({ type: "release"; classification: DeliveryReleaseClassification } & DeliveryClaim)
	| ({ type: "lease_expired" } & DeliveryClaim)
	| { type: "cancel"; reason: DeliveryCancellationReason; now: string };

export interface DeliveryTransitionState {
	readonly status: DeliveryStatus;
	readonly attemptCount: number;
	readonly maxAttempts: number;
	readonly lastFencingToken: string;
	readonly activeLeaseId: string | null;
	readonly activeFencingToken: string | null;
	readonly leaseExpiresAt: string | null;
	readonly logicallySettled: boolean;
}

type StateMachine = "mission" | "delivery";
type TransitionStatus = MissionStatus | DeliveryStatus;
type TransitionEventType = MissionTransitionEvent["type"] | DeliveryTransitionEvent["type"];

export class InvalidTransitionError extends Error {
	constructor(
		readonly machine: StateMachine,
		readonly currentStatus: TransitionStatus,
		readonly eventType: TransitionEventType,
	) {
		super(`Invalid ${machine} transition from '${currentStatus}' on '${eventType}'`);
		this.name = "InvalidTransitionError";
	}
}

export class InvalidFencingTokenError extends Error {
	constructor(
		readonly currentStatus: DeliveryStatus,
		readonly eventType: DeliveryTransitionEvent["type"],
		readonly expected: string | null,
		readonly received: string | undefined,
	) {
		super(`Invalid delivery fencing token for '${currentStatus}' on '${eventType}'`);
		this.name = "InvalidFencingTokenError";
	}
}

export class InvalidLeaseClaimError extends Error {
	constructor(
		readonly currentStatus: DeliveryStatus,
		readonly eventType: DeliveryTransitionEvent["type"],
		readonly reason: "inactive" | "lease_mismatch" | "expired" | "invalid_time",
	) {
		super(`Invalid delivery lease claim for '${currentStatus}' on '${eventType}': ${reason}`);
		this.name = "InvalidLeaseClaimError";
	}
}

type MissionEventType = MissionTransitionEvent["type"];
type DeliveryEventType = DeliveryTransitionEvent["type"];

const missionTransitions: Partial<
	Record<MissionStatus, Partial<Record<MissionEventType, MissionStatus>>>
> = {
	awaiting_acceptance: {
		participants_accepted: "active",
		cancel: "cancelled",
		expire: "expired",
		fail: "failed",
	},
	active: {
		participants_ready: "verifying",
		blocking_required: "blocked",
		cancel: "cancelled",
		expire: "expired",
		fail: "failed",
	},
	verifying: {
		blocking_required: "blocked",
		verification_passed: "completed",
		verification_failed: "active",
		cancel: "cancelled",
		expire: "expired",
		fail: "failed",
	},
	blocked: {
		block_resolved: "active",
		cancel: "cancelled",
		expire: "expired",
		fail: "failed",
	},
};

const deliveryTransitions: Partial<
	Record<DeliveryStatus, Partial<Record<DeliveryEventType, DeliveryStatus>>>
> = {
	stored: {
		lease: "leased",
		cancel: "cancelled",
	},
	leased: {
		renew_lease: "leased",
		start_execution: "executing",
		release: "stored",
		lease_expired: "stored",
		cancel: "cancelled",
	},
	executing: {
		renew_lease: "executing",
		acknowledge: "acknowledged",
		release: "stored",
		lease_expired: "stored",
		cancel: "cancelled",
	},
};

export function transitionMissionStatus(
	current: MissionStatus,
	event: MissionTransitionEvent,
): MissionStatus {
	const next = missionTransitions[current]?.[event.type];
	if (next === undefined) {
		throw new InvalidTransitionError("mission", current, event.type);
	}
	return next;
}

export function transitionDeliveryState(
	current: DeliveryTransitionState,
	event: DeliveryTransitionEvent,
): DeliveryTransitionState {
	const next = deliveryTransitions[current.status]?.[event.type];
	if (next === undefined) {
		throw new InvalidTransitionError("delivery", current.status, event.type);
	}

	if (event.type === "lease") {
		if (
			current.logicallySettled ||
			current.attemptCount >= current.maxAttempts ||
			event.fencingToken !== String(current.attemptCount + 1)
		) {
			throw new InvalidTransitionError("delivery", current.status, event.type);
		}
		if (!isTimestampBefore(event.now, event.expiresAt)) {
			throw new InvalidLeaseClaimError(current.status, event.type, "invalid_time");
		}
		if (!uuidSchema.safeParse(event.leaseId).success) {
			throw new InvalidLeaseClaimError(current.status, event.type, "lease_mismatch");
		}
		return {
			...current,
			status: next,
			attemptCount: current.attemptCount + 1,
			lastFencingToken: event.fencingToken,
			activeLeaseId: event.leaseId,
			activeFencingToken: event.fencingToken,
			leaseExpiresAt: event.expiresAt,
		};
	}

	if (event.type === "cancel") {
		if (
			!isoTimestampSchema.safeParse(event.now).success ||
			!deliveryCancellationReasonSchema.safeParse(event.reason).success
		) {
			throw new InvalidTransitionError("delivery", current.status, event.type);
		}
		return {
			...current,
			status: next,
			activeLeaseId: null,
			activeFencingToken: null,
			leaseExpiresAt: null,
		};
	}

	if (current.logicallySettled && event.type !== "acknowledge") {
		throw new InvalidTransitionError("delivery", current.status, event.type);
	}

	if (current.status === "leased" || current.status === "executing") {
		if (event.type === "lease_expired") {
			assertMatchingDeliveryClaim(current, event, event.type);
			if (isTimestampBefore(event.now, current.leaseExpiresAt)) {
				throw new InvalidLeaseClaimError(current.status, event.type, "invalid_time");
			}
		} else {
			assertActiveDeliveryClaim(current, event, event.type);
		}
	}

	if (event.type === "renew_lease") {
		if (
			!isTimestampBefore(event.now, event.expiresAt) ||
			!isTimestamp(current.leaseExpiresAt) ||
			!isTimestampBefore(current.leaseExpiresAt, event.expiresAt)
		) {
			throw new InvalidLeaseClaimError(current.status, event.type, "invalid_time");
		}
		return { ...current, leaseExpiresAt: event.expiresAt };
	}

	if (event.type === "acknowledge" && !current.logicallySettled) {
		throw new InvalidTransitionError("delivery", current.status, event.type);
	}

	const attemptsExhausted =
		(event.type === "release" || event.type === "lease_expired") &&
		current.attemptCount >= current.maxAttempts;
	const terminalRelease =
		event.type === "release" &&
		(event.classification === "permanent" || event.classification === "policy_denied");
	if (
		event.type === "release" &&
		!deliveryReleaseClassificationSchema.safeParse(event.classification).success
	) {
		throw new InvalidTransitionError("delivery", current.status, event.type);
	}

	return {
		...current,
		status: attemptsExhausted || terminalRelease ? "dead_lettered" : next,
		activeLeaseId: next === "executing" ? current.activeLeaseId : null,
		activeFencingToken: next === "executing" ? current.activeFencingToken : null,
		leaseExpiresAt: next === "executing" ? current.leaseExpiresAt : null,
	};
}

export function assertActiveDeliveryClaim(
	current: DeliveryTransitionState,
	received: Partial<DeliveryClaim>,
	eventType: DeliveryTransitionEvent["type"] = "start_execution",
): void {
	assertMatchingDeliveryClaim(current, received, eventType);
	if (!isTimestampBefore(received.now, current.leaseExpiresAt)) {
		throw new InvalidLeaseClaimError(current.status, eventType, "expired");
	}
}

function assertMatchingDeliveryClaim(
	current: DeliveryTransitionState,
	received: Partial<DeliveryClaim>,
	eventType: DeliveryTransitionEvent["type"],
): void {
	if (current.status !== "leased" && current.status !== "executing") {
		throw new InvalidLeaseClaimError(current.status, eventType, "inactive");
	}
	if (received.leaseId === undefined || received.leaseId !== current.activeLeaseId) {
		throw new InvalidLeaseClaimError(current.status, eventType, "lease_mismatch");
	}
	if (received.fencingToken === undefined || received.fencingToken !== current.activeFencingToken) {
		throw new InvalidFencingTokenError(
			current.status,
			eventType,
			current.activeFencingToken,
			received.fencingToken,
		);
	}
	if (
		received.now === undefined ||
		!isTimestamp(received.now) ||
		!isTimestamp(current.leaseExpiresAt)
	) {
		throw new InvalidLeaseClaimError(current.status, eventType, "invalid_time");
	}
}

function isTimestamp(value: string | null): value is string {
	return value !== null && isoTimestampSchema.safeParse(value).success;
}

function isTimestampBefore(left: string | undefined, right: string | null): boolean {
	return (
		left !== undefined &&
		isTimestamp(left) &&
		isTimestamp(right) &&
		Date.parse(left) < Date.parse(right)
	);
}
