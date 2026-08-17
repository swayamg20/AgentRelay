import { isAbsolute, normalize } from "node:path";
import type { HostEvent, HostTurnCorrelation } from "@agentrelay/protocol";
import { uuidSchema } from "@agentrelay/protocol";
import { ZodError } from "zod";
import { z } from "zod";
import { CapsuleOperationError } from "./capsule-operation-error.js";
import type { CapsuleErrorCode } from "./capsule-protocol.js";
import type { CapsuleRuntime, CapsuleServerIdentity } from "./capsule-runtime.js";
import { RuntimeAuthorityDeniedError } from "./runtime-authority.js";

const identitySchema = z
	.object({
		capsuleId: uuidSchema,
		capabilityToken: z.string().regex(/^ar_capsule_[a-f0-9]{64}$/),
		socketPath: z
			.string()
			.min(1)
			.max(512)
			.refine((value) => isAbsolute(value) && normalize(value) === value && !value.includes("\0")),
	})
	.strict();

export function parseCapsuleServerIdentity(value: unknown): CapsuleServerIdentity {
	return identitySchema.parse(value);
}

export async function captureFailure(
	operation: Promise<unknown>,
	failures: unknown[],
): Promise<void> {
	try {
		await operation;
	} catch (error) {
		failures.push(error);
	}
}

export async function nextRuntimeEvent(
	iterator: AsyncIterator<HostEvent>,
	signal: AbortSignal,
): Promise<IteratorResult<HostEvent> | null> {
	if (signal.aborted) return null;
	return new Promise((resolve, reject) => {
		const onAbort = () => resolve(null);
		signal.addEventListener("abort", onAbort, { once: true });
		void iterator.next().then(
			(result) => {
				signal.removeEventListener("abort", onAbort);
				resolve(result);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export function turnCorrelation(
	input: Parameters<CapsuleRuntime["startTurn"]>[0],
): HostTurnCorrelation {
	return {
		sessionId: input.session.sessionId,
		missionId: input.missionId,
		deliveryId: input.deliveryId,
		executionAttempt: input.executionAttempt,
		contractVersion: input.contractVersion,
	};
}

export function publicCapsuleError(error: unknown): {
	readonly code: CapsuleErrorCode;
	readonly message: string;
} {
	if (error instanceof CapsuleOperationError) return { code: error.code, message: error.message };
	if (error instanceof RuntimeAuthorityDeniedError) {
		return { code: "authority_denied", message: error.message };
	}
	if (error instanceof ZodError) {
		return { code: "invalid_request", message: "Capsule request failed validation" };
	}
	return { code: "internal", message: "Capsule runtime failed" };
}
