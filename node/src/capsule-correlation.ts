import { createHash } from "node:crypto";
import { type StartTurnInput, startTurnInputSchema } from "@agentrelay/protocol";

export function digestStartTurnInput(inputValue: StartTurnInput): string {
	const input = startTurnInputSchema.parse(inputValue);
	return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}

export function executionKey(deliveryId: string, executionAttempt: number): string {
	return `${deliveryId}:${executionAttempt}`;
}

export function digestCanonicalJson(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
		.join(",")}}`;
}
