import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
	missionCoordinatorEventSchema,
	missionDeliveryItemSchema,
	nodeDeliveryResultPayloadSchema,
} from "./mission-coordinator.js";
import {
	type Delivery,
	deliveryCancellationReasonSchema,
	deliveryLeaseAuthoritySchema,
	deliveryLogicalSettlementSchema,
	deliveryReleaseClassificationSchema,
	deliverySchema,
	deliveryStatusSchema,
	isoTimestampSchema,
	missionEventEnvelopeSchema,
	uuidSchema,
} from "./schemas.js";

export const deliveryOperationSchema = z.enum([
	"claim",
	"start",
	"renew",
	"complete",
	"release",
	"cancel",
]);

export const deliveryClaimOutcomeSchema = z.enum(["claimed", "dead_lettered"]);

const idempotencyKeySchema = missionEventEnvelopeSchema.shape.idempotency_key;
const releaseSummarySchema = z
	.string()
	.min(1)
	.max(2_000)
	.refine((value) => value.trim().length > 0, "Release summary cannot be blank");

export const deliveryClaimInputSchema = z
	.object({
		idempotency_key: idempotencyKeySchema,
	})
	.strict();

const leaseOperationInputFields = {
	idempotency_key: idempotencyKeySchema,
	...deliveryLeaseAuthoritySchema.shape,
} as const;

export const deliveryStartInputSchema = z.object(leaseOperationInputFields).strict();
export const deliveryRenewInputSchema = z.object(leaseOperationInputFields).strict();
export const deliveryCompleteInputSchema = z
	.object({
		...leaseOperationInputFields,
		result: nodeDeliveryResultPayloadSchema,
	})
	.strict();
export const deliveryReleaseInputSchema = z
	.object({
		...leaseOperationInputFields,
		classification: deliveryReleaseClassificationSchema,
		summary: releaseSummarySchema,
	})
	.strict();

const deliveryReleaseDetailsSchema = z
	.object({
		classification: deliveryReleaseClassificationSchema,
		summary: releaseSummarySchema,
	})
	.strict();

const rawDeliveryOperationReceiptSchema = z
	.object({
		receipt_id: uuidSchema,
		operation: deliveryOperationSchema,
		idempotency_key: idempotencyKeySchema,
		node_id: uuidSchema,
		delivery_id: uuidSchema,
		attempt_count: z.number().int().nonnegative().max(100),
		lease: deliveryLeaseAuthoritySchema.nullable(),
		lease_expires_at: isoTimestampSchema.nullable(),
		status_before: deliveryStatusSchema,
		status_after: deliveryStatusSchema,
		logical_settlement: deliveryLogicalSettlementSchema.nullable(),
		claim_outcome: deliveryClaimOutcomeSchema.nullable(),
		release: deliveryReleaseDetailsSchema.nullable(),
		cancellation_reason: deliveryCancellationReasonSchema.nullable(),
		recorded_at: isoTimestampSchema,
	})
	.strict();

export type DeliveryOperationReceipt = z.infer<typeof rawDeliveryOperationReceiptSchema>;
export const deliveryOperationReceiptSchema =
	rawDeliveryOperationReceiptSchema.superRefine(validateOperationReceipt);

export const deliveryClaimReceiptSchema = deliveryOperationReceiptSchema.refine(
	(receipt) => receipt.operation === "claim",
	"Expected a claim receipt",
);
export const deliveryStartReceiptSchema = deliveryOperationReceiptSchema.refine(
	(receipt) => receipt.operation === "start",
	"Expected a start receipt",
);
export const deliveryRenewReceiptSchema = deliveryOperationReceiptSchema.refine(
	(receipt) => receipt.operation === "renew",
	"Expected a renewal receipt",
);
export const deliveryCompleteReceiptSchema = deliveryOperationReceiptSchema.refine(
	(receipt) => receipt.operation === "complete",
	"Expected a completion receipt",
);
export const deliveryReleaseReceiptSchema = deliveryOperationReceiptSchema.refine(
	(receipt) => receipt.operation === "release",
	"Expected a release receipt",
);
export const deliveryCancellationReceiptSchema = deliveryOperationReceiptSchema.refine(
	(receipt) => receipt.operation === "cancel",
	"Expected a cancellation receipt",
);

const operationResultFields = {
	delivery: deliverySchema,
	receipt: deliveryOperationReceiptSchema,
	replayed: z.boolean(),
} as const;

export const deliveryOperationResultSchema = z
	.object(operationResultFields)
	.strict()
	.superRefine(validateOperationResult);

export const deliveryStartResultSchema = deliveryOperationResultSchema.refine(
	(result) => result.receipt.operation === "start",
	"Expected a start result",
);
export const deliveryRenewResultSchema = deliveryOperationResultSchema.refine(
	(result) => result.receipt.operation === "renew",
	"Expected a renewal result",
);
export const deliveryReleaseResultSchema = deliveryOperationResultSchema.refine(
	(result) => result.receipt.operation === "release",
	"Expected a release result",
);
export const deliveryCancellationResultSchema = deliveryOperationResultSchema.refine(
	(result) => result.receipt.operation === "cancel",
	"Expected a cancellation result",
);

const claimedDeliveryResultSchema = z
	.object({
		outcome: z.literal("claimed"),
		item: missionDeliveryItemSchema,
		receipt: deliveryClaimReceiptSchema,
		replayed: z.boolean(),
	})
	.strict();

const deadLetteredClaimResultSchema = z
	.object({
		outcome: z.literal("dead_lettered"),
		delivery: deliverySchema,
		receipt: deliveryClaimReceiptSchema,
		replayed: z.boolean(),
	})
	.strict();

export const deliveryClaimResultSchema = z
	.discriminatedUnion("outcome", [claimedDeliveryResultSchema, deadLetteredClaimResultSchema])
	.superRefine((result, ctx) => {
		const delivery = result.outcome === "claimed" ? result.item.delivery : result.delivery;
		validateReceiptAgainstDelivery(delivery, result.receipt, ctx);
		if (result.receipt.claim_outcome !== result.outcome) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Claim receipt outcome must match the result outcome",
				path: ["receipt", "claim_outcome"],
			});
		}
		const expectedStatus = result.outcome === "claimed" ? "leased" : "dead_lettered";
		if (delivery.status !== expectedStatus) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Claim ${result.outcome} outcome requires ${expectedStatus} delivery state`,
				path:
					result.outcome === "claimed" ? ["item", "delivery", "status"] : ["delivery", "status"],
			});
		}
	});

export const deliveryCompleteResultSchema = z
	.object({
		delivery: deliverySchema,
		receipt: deliveryCompleteReceiptSchema,
		events: z.array(missionCoordinatorEventSchema).min(1).max(16),
		derived_delivery_ids: z.array(uuidSchema).max(2),
		replayed: z.boolean(),
	})
	.strict()
	.superRefine((result, ctx) => {
		validateOperationResult(result, ctx);
		if (result.events.some((event) => event.type === "participants_accepted")) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "A Node completion cannot publish participant acceptance",
				path: ["events"],
			});
			return;
		}
		for (const [index, event] of result.events.entries()) {
			if (event.type === "participants_accepted") {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Completion events must exactly match the returned delivery work",
					path: ["events", index],
				});
				continue;
			}
			const expectedEventType =
				result.delivery.kind === "turn"
					? "turn_completed"
					: result.delivery.kind === "contract_acknowledgement"
						? "contract_acknowledged"
						: "verification_recorded";
			if (
				event.mission_id !== result.delivery.mission_id ||
				event.delivery_id !== result.delivery.delivery_id ||
				event.type !== expectedEventType ||
				event.contract_version !== result.delivery.contract_version ||
				(event.type === "verification_recorded" &&
					event.verification_round !== result.delivery.verification_round)
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Completion events must exactly match the returned delivery work",
					path: ["events", index],
				});
			}
			if (index > 0 && event.sequence_no !== result.events[index - 1]!.sequence_no + 1) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Completion events must have contiguous coordinator sequence numbers",
					path: ["events", index, "sequence_no"],
				});
			}
		}
		const finalEvent = result.events.at(-1)!;
		if (result.delivery.logical_settlement?.settled_by_event_id !== finalEvent.event_id) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Final completion event must match the delivery's logical settlement",
				path: ["delivery", "logical_settlement", "settled_by_event_id"],
			});
		}
		const eventType = result.events[0]!.type;
		if (
			(eventType !== "verification_recorded" && result.events.length !== 1) ||
			result.events.some((event) => event.type !== eventType)
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					"Turn and acknowledgement completion return one event; verification returns only evidence events",
				path: ["events"],
			});
		}
		if (eventType === "verification_recorded") {
			const verificationEvents = result.events.filter(
				(event) => event.type === "verification_recorded",
			);
			const first = verificationEvents[0]!;
			if (
				new Set(verificationEvents.map((event) => event.evidence.command_id)).size !==
					verificationEvents.length ||
				new Set(verificationEvents.map((event) => event.evidence.verification_id)).size !==
					verificationEvents.length ||
				verificationEvents.some(
					(event) =>
						event.participant_agent_id !== first.participant_agent_id ||
						event.contract_version !== first.contract_version ||
						event.verification_round !== first.verification_round,
				)
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Verification completion events must be one coherent unique command set",
					path: ["events"],
				});
			}
		}
		if (new Set(result.derived_delivery_ids).size !== result.derived_delivery_ids.length) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Derived delivery IDs must be unique",
				path: ["derived_delivery_ids"],
			});
		}
	});

export type DeliveryOperation = z.infer<typeof deliveryOperationSchema>;
export type DeliveryClaimOutcome = z.infer<typeof deliveryClaimOutcomeSchema>;
export type DeliveryClaimInput = z.infer<typeof deliveryClaimInputSchema>;
export type DeliveryStartInput = z.infer<typeof deliveryStartInputSchema>;
export type DeliveryRenewInput = z.infer<typeof deliveryRenewInputSchema>;
export type DeliveryCompleteInput = z.infer<typeof deliveryCompleteInputSchema>;
export type DeliveryReleaseInput = z.infer<typeof deliveryReleaseInputSchema>;
export type DeliveryClaimReceipt = DeliveryOperationReceipt & { readonly operation: "claim" };
export type DeliveryStartReceipt = DeliveryOperationReceipt & { readonly operation: "start" };
export type DeliveryRenewReceipt = DeliveryOperationReceipt & { readonly operation: "renew" };
export type DeliveryCompleteReceipt = DeliveryOperationReceipt & { readonly operation: "complete" };
export type DeliveryReleaseReceipt = DeliveryOperationReceipt & { readonly operation: "release" };
export type DeliveryCancellationReceipt = DeliveryOperationReceipt & {
	readonly operation: "cancel";
};
export type DeliveryOperationResult = z.infer<typeof deliveryOperationResultSchema>;
export type DeliveryClaimResult = z.infer<typeof deliveryClaimResultSchema>;
export type DeliveryStartResult = z.infer<typeof deliveryStartResultSchema>;
export type DeliveryRenewResult = z.infer<typeof deliveryRenewResultSchema>;
export type DeliveryCompleteResult = z.infer<typeof deliveryCompleteResultSchema>;
export type DeliveryReleaseResult = z.infer<typeof deliveryReleaseResultSchema>;
export type DeliveryCancellationResult = z.infer<typeof deliveryCancellationResultSchema>;

function validateOperationReceipt(receipt: DeliveryOperationReceipt, ctx: z.RefinementCtx): void {
	if (!hasValidStatusPair(receipt)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Delivery operation has an invalid status transition",
			path: ["status_after"],
		});
	}

	const requiresPresentedLease =
		receipt.operation === "start" ||
		receipt.operation === "renew" ||
		receipt.operation === "complete" ||
		receipt.operation === "release";
	const claimed = receipt.operation === "claim" && receipt.claim_outcome === "claimed";
	if (
		(requiresPresentedLease || claimed) &&
		(receipt.lease === null || receipt.lease_expires_at === null)
	) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Lease-owned operation requires its authority and deadline",
			path: ["lease"],
		});
	}
	if (receipt.operation === "claim" && receipt.claim_outcome === "dead_lettered") {
		if (receipt.lease !== null || receipt.lease_expires_at !== null) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Dead-lettered claim outcome has no active lease",
				path: ["lease"],
			});
		}
	}
	if (receipt.operation === "cancel") {
		const cancelledActiveLease =
			receipt.status_before === "leased" || receipt.status_before === "executing";
		if (cancelledActiveLease !== (receipt.lease !== null && receipt.lease_expires_at !== null)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Cancellation receipt retains authority only for an active prior lease",
				path: ["lease"],
			});
		}
	}
	if ((receipt.lease === null) !== (receipt.lease_expires_at === null)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Lease authority and deadline must be present together",
			path: ["lease_expires_at"],
		});
	}

	if (receipt.operation !== "cancel" && receipt.attempt_count === 0) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Node delivery operations require an execution attempt",
			path: ["attempt_count"],
		});
	}
	if ((receipt.operation === "claim") !== (receipt.claim_outcome !== null)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Only claim receipts carry a claim outcome",
			path: ["claim_outcome"],
		});
	}
	if ((receipt.operation === "release") !== (receipt.release !== null)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Only release receipts carry release details",
			path: ["release"],
		});
	}
	if ((receipt.operation === "cancel") !== (receipt.cancellation_reason !== null)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Only cancellation receipts carry a cancellation reason",
			path: ["cancellation_reason"],
		});
	}
	if (receipt.operation === "complete") {
		if (receipt.logical_settlement === null) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Completion receipt requires logical settlement",
				path: ["logical_settlement"],
			});
		}
	} else if (receipt.operation !== "cancel" && receipt.logical_settlement !== null) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Only completion or cancellation may carry logical settlement",
			path: ["logical_settlement"],
		});
	}

	if (
		(requiresPresentedLease || claimed) &&
		receipt.lease_expires_at !== null &&
		Date.parse(receipt.recorded_at) >= Date.parse(receipt.lease_expires_at)
	) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Lease-owned operation must be recorded before its deadline",
			path: ["recorded_at"],
		});
	}
	if (
		receipt.logical_settlement !== null &&
		Date.parse(receipt.logical_settlement.settled_at) > Date.parse(receipt.recorded_at)
	) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Logical settlement cannot follow its operation receipt",
			path: ["logical_settlement", "settled_at"],
		});
	}
}

function hasValidStatusPair(receipt: {
	operation: DeliveryOperation;
	claim_outcome: DeliveryClaimOutcome | null;
	release: { classification: z.infer<typeof deliveryReleaseClassificationSchema> } | null;
	status_before: z.infer<typeof deliveryStatusSchema>;
	status_after: z.infer<typeof deliveryStatusSchema>;
}): boolean {
	switch (receipt.operation) {
		case "claim":
			if (receipt.claim_outcome === "claimed") {
				return receipt.status_before === "stored" && receipt.status_after === "leased";
			}
			return (
				receipt.claim_outcome === "dead_lettered" &&
				(receipt.status_before === "leased" || receipt.status_before === "executing") &&
				receipt.status_after === "dead_lettered"
			);
		case "start":
			return receipt.status_before === "leased" && receipt.status_after === "executing";
		case "renew":
			return (
				(receipt.status_before === "leased" || receipt.status_before === "executing") &&
				receipt.status_after === receipt.status_before
			);
		case "complete":
			return receipt.status_before === "executing" && receipt.status_after === "acknowledged";
		case "release":
			if (
				!(
					(receipt.status_before === "leased" || receipt.status_before === "executing") &&
					(receipt.status_after === "stored" || receipt.status_after === "dead_lettered")
				)
			) {
				return false;
			}
			return (
				receipt.release?.classification === "transient" || receipt.status_after === "dead_lettered"
			);
		case "cancel":
			return (
				(receipt.status_before === "stored" ||
					receipt.status_before === "leased" ||
					receipt.status_before === "executing") &&
				receipt.status_after === "cancelled"
			);
	}
}

function validateOperationResult(
	result: { delivery: Delivery; receipt: DeliveryOperationReceipt },
	ctx: z.RefinementCtx,
): void {
	validateReceiptAgainstDelivery(result.delivery, result.receipt, ctx);
}

function validateReceiptAgainstDelivery(
	delivery: Delivery,
	receipt: DeliveryOperationReceipt,
	ctx: z.RefinementCtx,
): void {
	if (
		delivery.delivery_id !== receipt.delivery_id ||
		delivery.node_id !== receipt.node_id ||
		delivery.attempt_count !== receipt.attempt_count ||
		delivery.status !== receipt.status_after
	) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Operation receipt must describe the returned delivery snapshot",
			path: ["receipt"],
		});
	}
	if (!isDeepStrictEqual(delivery.logical_settlement, receipt.logical_settlement)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Operation receipt must retain the delivery's logical settlement",
			path: ["receipt", "logical_settlement"],
		});
	}
	if (delivery.cancellation_reason !== receipt.cancellation_reason) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Operation receipt must retain the delivery's cancellation reason",
			path: ["receipt", "cancellation_reason"],
		});
	}
	if (receipt.status_after === "leased" || receipt.status_after === "executing") {
		if (
			delivery.lease === null ||
			receipt.lease === null ||
			delivery.lease.lease_id !== receipt.lease.lease_id ||
			delivery.lease.fencing_token !== receipt.lease.fencing_token ||
			delivery.lease.expires_at !== receipt.lease_expires_at
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Operation receipt must retain the returned active lease",
				path: ["receipt", "lease"],
			});
		}
	} else if (delivery.lease !== null) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Settled operation result cannot retain an active lease",
			path: ["delivery", "lease"],
		});
	}
}
