import { describe, expect, it } from "vitest";
import {
	deliveryCancellationResultSchema,
	deliveryClaimInputSchema,
	deliveryClaimResultSchema,
	deliveryCompleteInputSchema,
	deliveryCompleteResultSchema,
	deliveryOperationReceiptSchema,
	deliveryReleaseInputSchema,
	deliveryReleaseResultSchema,
	deliveryRenewInputSchema,
	deliveryRenewResultSchema,
	deliveryStartInputSchema,
	deliveryStartResultSchema,
} from "./delivery-operations.js";

const IDS = {
	mission: "00000000-0000-4000-8000-000000000001",
	node: "00000000-0000-4000-8000-000000000002",
	agent: "00000000-0000-4000-8000-000000000003",
	event: "00000000-0000-4000-8000-000000000004",
	delivery: "00000000-0000-4000-8000-000000000005",
	lease: "00000000-0000-4000-8000-000000000006",
	receipt: "00000000-0000-4000-8000-000000000007",
	message: "00000000-0000-4000-8000-000000000008",
	derived: "00000000-0000-4000-8000-000000000009",
	verification1: "00000000-0000-4000-8000-000000000010",
	verification2: "00000000-0000-4000-8000-000000000011",
} as const;

const CONTRACT = {
	artifact_id: "00000000-0000-4000-8000-000000000012",
	type: "api_contract",
	version: 1,
	sha256: "a".repeat(64),
	media_type: "application/json",
	byte_size: 128,
};

const LEASE = {
	lease_id: IDS.lease,
	fencing_token: "1",
	expires_at: "2026-08-02T10:10:00.000Z",
};
const AUTHORITY = { lease_id: LEASE.lease_id, fencing_token: LEASE.fencing_token };

const leasedDelivery = {
	delivery_id: IDS.delivery,
	node_id: IDS.node,
	mission_id: IDS.mission,
	mission_event_id: IDS.event,
	kind: "turn" as const,
	cursor: "1",
	status: "leased" as const,
	attempt_count: 1,
	max_attempts: 3,
	last_fencing_token: "1",
	contract_version: 1,
	verification_round: null,
	lease: LEASE,
	logical_settlement: null,
	idempotency_key: "delivery:1",
	causal_parent_delivery_id: null,
	available_at: "2026-08-02T10:00:00.000Z",
	created_at: "2026-08-02T10:00:00.000Z",
	updated_at: "2026-08-02T10:01:00.000Z",
	acknowledged_at: null,
	cancelled_at: null,
	cancellation_reason: null,
	dead_lettered_at: null,
};

const executingDelivery = { ...leasedDelivery, status: "executing" as const };
const settlement = {
	settled_by_event_id: IDS.event,
	settled_at: "2026-08-02T10:02:00.000Z",
};
const acknowledgedDelivery = {
	...executingDelivery,
	status: "acknowledged" as const,
	lease: null,
	logical_settlement: settlement,
	updated_at: settlement.settled_at,
	acknowledged_at: settlement.settled_at,
};
const storedRetryDelivery = {
	...leasedDelivery,
	status: "stored" as const,
	lease: null,
	available_at: "2026-08-02T10:03:00.000Z",
	updated_at: "2026-08-02T10:02:00.000Z",
};
const deadLetteredDelivery = {
	...leasedDelivery,
	status: "dead_lettered" as const,
	attempt_count: 3,
	last_fencing_token: "3",
	lease: null,
	updated_at: "2026-08-02T10:10:00.000Z",
	dead_lettered_at: "2026-08-02T10:10:00.000Z",
};
const cancelledDelivery = {
	...executingDelivery,
	status: "cancelled" as const,
	lease: null,
	updated_at: "2026-08-02T10:02:00.000Z",
	cancelled_at: "2026-08-02T10:02:00.000Z",
	cancellation_reason: "mission_cancelled" as const,
};

const acceptedEvent = {
	event_id: IDS.event,
	idempotency_key: "event:accepted",
	mission_id: IDS.mission,
	sequence_no: 1,
	created_at: "2026-08-02T10:00:00.000Z",
	type: "participants_accepted" as const,
	participant_agent_ids: [IDS.agent, "00000000-0000-4000-8000-000000000013"],
	contract: CONTRACT,
};

const claimedItem = {
	delivery: leasedDelivery,
	event: acceptedEvent,
	actor_agent_id: IDS.agent,
	source_delivery_id: null,
	causal_parent_event_id: null,
};

function receipt(
	operation: "claim" | "start" | "renew" | "complete" | "release" | "cancel",
	overrides: Record<string, unknown> = {},
) {
	return {
		receipt_id: IDS.receipt,
		operation,
		idempotency_key: `${operation}:1`,
		node_id: IDS.node,
		delivery_id: IDS.delivery,
		attempt_count: 1,
		lease: AUTHORITY,
		lease_expires_at: LEASE.expires_at,
		status_before: "leased",
		status_after: "executing",
		logical_settlement: null,
		claim_outcome: null,
		release: null,
		cancellation_reason: null,
		recorded_at: "2026-08-02T10:02:00.000Z",
		...overrides,
	};
}

const claimReceipt = receipt("claim", {
	status_before: "stored",
	status_after: "leased",
	claim_outcome: "claimed",
});
const startReceipt = receipt("start");
const renewReceipt = receipt("renew", {
	status_before: "executing",
	status_after: "executing",
});
const completeReceipt = receipt("complete", {
	status_before: "executing",
	status_after: "acknowledged",
	logical_settlement: settlement,
});
const releaseReceipt = receipt("release", {
	status_before: "executing",
	status_after: "stored",
	release: { classification: "transient", summary: "The dependency is temporarily unavailable." },
});
const cancellationReceipt = receipt("cancel", {
	status_before: "executing",
	status_after: "cancelled",
	cancellation_reason: "mission_cancelled",
});

describe("Node delivery operation inputs", () => {
	it("accepts only idempotency and lease authority supplied by the Node", () => {
		const claim = { idempotency_key: "claim:1" };
		const authorityInput = { idempotency_key: "start:1", ...AUTHORITY };

		expect(deliveryClaimInputSchema.parse(claim)).toEqual(claim);
		expect(deliveryStartInputSchema.parse(authorityInput)).toEqual(authorityInput);
		expect(
			deliveryRenewInputSchema.parse({ ...authorityInput, idempotency_key: "renew:1" }),
		).toEqual({ ...authorityInput, idempotency_key: "renew:1" });
		expect(
			deliveryClaimInputSchema.safeParse({
				...claim,
				node_id: IDS.node,
				now: settlement.settled_at,
			}).success,
		).toBe(false);
		expect(
			deliveryRenewInputSchema.safeParse({
				...authorityInput,
				expires_at: LEASE.expires_at,
				lease_duration_seconds: 60,
			}).success,
		).toBe(false);
	});

	it("completes with content only and lets the Relay derive every coordinator identity", () => {
		const input = {
			idempotency_key: "complete:1",
			...AUTHORITY,
			result: {
				type: "turn_completed" as const,
				disposition: {
					kind: "reply" as const,
					message_type: "progress" as const,
					message: "The endpoint is ready.",
				},
			},
		};

		expect(deliveryCompleteInputSchema.parse(input)).toEqual(input);
		expect(
			deliveryCompleteInputSchema.safeParse({
				...input,
				result: {
					...input.result,
					participant_agent_id: IDS.agent,
					delivery_id: IDS.delivery,
					contract_version: 1,
					idempotency_key: "event:1",
					created_at: settlement.settled_at,
				},
			}).success,
		).toBe(false);
	});

	it("requires a complete unique verification evidence set", () => {
		const first = verificationEvidence(IDS.verification1, "backend-contract");
		const second = verificationEvidence(IDS.verification2, "backend-integration");
		const input = {
			idempotency_key: "complete:verification",
			...AUTHORITY,
			result: { type: "verification_recorded" as const, evidence: [first, second] },
		};

		expect(deliveryCompleteInputSchema.parse(input)).toEqual(input);
		expect(
			deliveryCompleteInputSchema.safeParse({
				...input,
				result: { ...input.result, evidence: [first, first] },
			}).success,
		).toBe(false);
		expect(
			deliveryCompleteInputSchema.safeParse({
				...input,
				result: { ...input.result, evidence: [] },
			}).success,
		).toBe(false);
	});

	it("classifies release without accepting client backoff or clock policy", () => {
		const input = {
			idempotency_key: "release:1",
			...AUTHORITY,
			classification: "transient" as const,
			summary: "The dependency is temporarily unavailable.",
		};

		expect(deliveryReleaseInputSchema.parse(input)).toEqual(input);
		expect(deliveryReleaseInputSchema.safeParse({ ...input, summary: "   " }).success).toBe(false);
		expect(
			deliveryReleaseInputSchema.safeParse({
				...input,
				backoff_seconds: 30,
				available_at: "2026-08-02T10:03:00.000Z",
			}).success,
		).toBe(false);
	});
});

describe("delivery operation receipts", () => {
	it("accepts the six public operation receipts with exact transition details", () => {
		for (const value of [
			claimReceipt,
			startReceipt,
			renewReceipt,
			completeReceipt,
			releaseReceipt,
			cancellationReceipt,
		]) {
			expect(deliveryOperationReceiptSchema.parse(value)).toEqual(value);
		}
	});

	it("models a successful terminal outcome when an expired final claim is recovered", () => {
		const terminal = receipt("claim", {
			attempt_count: 3,
			lease: null,
			lease_expires_at: null,
			status_before: "executing",
			status_after: "dead_lettered",
			claim_outcome: "dead_lettered",
			recorded_at: "2026-08-02T10:10:00.000Z",
		});

		expect(deliveryOperationReceiptSchema.parse(terminal)).toEqual(terminal);
		expect(
			deliveryOperationReceiptSchema.safeParse({ ...terminal, lease: AUTHORITY }).success,
		).toBe(false);
	});

	it("rejects impossible completion, release, and cancellation receipts", () => {
		expect(
			deliveryOperationReceiptSchema.safeParse({
				...completeReceipt,
				status_before: "leased",
			}).success,
		).toBe(false);
		expect(
			deliveryOperationReceiptSchema.safeParse({
				...releaseReceipt,
				release: { classification: "permanent", summary: "Cannot execute." },
			}).success,
		).toBe(false);
		expect(
			deliveryOperationReceiptSchema.safeParse({
				...cancellationReceipt,
				cancellation_reason: null,
			}).success,
		).toBe(false);
		expect(
			deliveryOperationReceiptSchema.safeParse({ ...startReceipt, operation: "result" }).success,
		).toBe(false);
	});
});

describe("delivery operation results", () => {
	it("returns either a claimed work item or a successful dead-letter outcome", () => {
		const claimed = {
			outcome: "claimed" as const,
			item: claimedItem,
			receipt: claimReceipt,
			replayed: false,
		};
		const terminalReceipt = receipt("claim", {
			attempt_count: 3,
			lease: null,
			lease_expires_at: null,
			status_before: "leased",
			status_after: "dead_lettered",
			claim_outcome: "dead_lettered",
			recorded_at: "2026-08-02T10:10:00.000Z",
		});
		const deadLettered = {
			outcome: "dead_lettered" as const,
			delivery: deadLetteredDelivery,
			receipt: terminalReceipt,
			replayed: true,
		};

		expect(deliveryClaimResultSchema.parse(claimed)).toEqual(claimed);
		expect(deliveryClaimResultSchema.parse(deadLettered)).toEqual(deadLettered);
		expect(
			deliveryClaimResultSchema.safeParse({
				...deadLettered,
				outcome: "claimed",
				item: claimedItem,
			}).success,
		).toBe(false);
	});

	it("binds start, renew, release, and cancellation receipts to their snapshots", () => {
		expect(
			deliveryStartResultSchema.parse({
				delivery: executingDelivery,
				receipt: startReceipt,
				replayed: false,
			}),
		).toBeTruthy();
		expect(
			deliveryRenewResultSchema.parse({
				delivery: executingDelivery,
				receipt: renewReceipt,
				replayed: true,
			}),
		).toBeTruthy();
		expect(
			deliveryReleaseResultSchema.parse({
				delivery: storedRetryDelivery,
				receipt: releaseReceipt,
				replayed: false,
			}),
		).toBeTruthy();
		expect(
			deliveryCancellationResultSchema.parse({
				delivery: cancelledDelivery,
				receipt: cancellationReceipt,
				replayed: false,
			}),
		).toBeTruthy();
	});

	it("atomically returns the acknowledged delivery and committed event batch", () => {
		const event = turnCompletedEvent();
		const result = {
			delivery: acknowledgedDelivery,
			receipt: completeReceipt,
			events: [event],
			derived_delivery_ids: [IDS.derived],
			replayed: false,
		};

		expect(deliveryCompleteResultSchema.parse(result)).toEqual(result);
		expect(
			deliveryCompleteResultSchema.safeParse({
				...result,
				event,
			}).success,
		).toBe(false);
		expect(
			deliveryCompleteResultSchema.safeParse({
				...result,
				derived_delivery_ids: [IDS.derived, IDS.derived],
			}).success,
		).toBe(false);
		expect(
			deliveryCompleteResultSchema.safeParse({
				...result,
				events: [
					{
						event_id: event.event_id,
						idempotency_key: event.idempotency_key,
						mission_id: event.mission_id,
						sequence_no: event.sequence_no,
						created_at: event.created_at,
						type: "mission_terminal",
						terminal_status: "expired",
						reason: "deadline_exceeded",
						triggering_delivery_id: null,
					},
				],
			}).success,
		).toBe(false);
		expect(
			deliveryCompleteResultSchema.safeParse({
				...result,
				delivery: {
					...acknowledgedDelivery,
					logical_settlement: { ...settlement, settled_by_event_id: IDS.derived },
				},
			}).success,
		).toBe(false);
	});

	it("returns one coherent event per verification command and settles on the final event", () => {
		const first = verificationRecordedEvent(10, IDS.verification1, "backend-contract");
		const second = verificationRecordedEvent(11, IDS.verification2, "backend-integration");
		const verificationDelivery = {
			...acknowledgedDelivery,
			kind: "verification" as const,
			verification_round: 1,
			logical_settlement: {
				...settlement,
				settled_by_event_id: second.event_id,
			},
		};
		const verificationReceipt = {
			...completeReceipt,
			logical_settlement: verificationDelivery.logical_settlement,
		};
		const result = {
			delivery: verificationDelivery,
			receipt: verificationReceipt,
			events: [first, second],
			derived_delivery_ids: [],
			replayed: false,
		};

		expect(deliveryCompleteResultSchema.parse(result)).toEqual(result);
		expect(
			deliveryCompleteResultSchema.safeParse({ ...result, events: [first, first] }).success,
		).toBe(false);
	});
});

function turnCompletedEvent() {
	return {
		event_id: IDS.event,
		idempotency_key: "event:turn",
		mission_id: IDS.mission,
		sequence_no: 2,
		created_at: settlement.settled_at,
		type: "turn_completed" as const,
		participant_agent_id: IDS.agent,
		delivery_id: IDS.delivery,
		contract_version: 1,
		disposition: {
			kind: "reply" as const,
			message_type: "progress" as const,
			message: "The endpoint is ready.",
		},
		message: {
			message_id: IDS.message,
			mission_id: IDS.mission,
			sequence_no: 1,
			author_agent_id: IDS.agent,
			type: "progress" as const,
			body: "The endpoint is ready.",
			artifacts: [],
			contract_version: 1,
			idempotency_key: "message:1",
			causal_parent_message_id: null,
			created_at: settlement.settled_at,
		},
		revision: null,
	};
}

function verificationEvidence(verificationId: string, commandId: string) {
	return {
		verification_id: verificationId,
		command_id: commandId,
		outcome: "passed" as const,
		exit_code: 0,
		duration_ms: 100,
		summary: `${commandId} passed.`,
		output_sha256: "b".repeat(64),
		artifacts: [],
		recorded_at: settlement.settled_at,
	};
}

function verificationRecordedEvent(sequence: number, verificationId: string, commandId: string) {
	return {
		event_id: numberedUuid(100 + sequence),
		idempotency_key: `event:verification:${sequence}`,
		mission_id: IDS.mission,
		sequence_no: sequence,
		created_at: settlement.settled_at,
		type: "verification_recorded" as const,
		participant_agent_id: IDS.agent,
		delivery_id: IDS.delivery,
		contract_version: 1,
		verification_round: 1,
		evidence: verificationEvidence(verificationId, commandId),
	};
}

function numberedUuid(value: number): string {
	return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}
