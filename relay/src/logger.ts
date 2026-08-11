import { DrizzleQueryError } from "drizzle-orm";
import pino, { type DestinationStream, type Logger } from "pino";
import type { RelayConfig } from "./config.js";

const POSTGRES_ERROR_CODE = /^[0-9A-Z]{5}$/;
const POSTGRES_SEVERITIES = new Set([
	"ERROR",
	"FATAL",
	"PANIC",
	"WARNING",
	"NOTICE",
	"DEBUG",
	"INFO",
	"LOG",
]);

function ownDataProperty(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function ownStringProperty(value: unknown, key: string): string | undefined {
	const candidate = ownDataProperty(value, key);
	return typeof candidate === "string" ? candidate : undefined;
}

function serializeStandardError(error: Error): Record<string, string> {
	// Pino traverses causes, while Node stacks can run or cache format hooks. Keep an inert snapshot.
	const serialized: Record<string, string> = { type: "Error" };
	const message = ownStringProperty(error, "message");
	if (message) serialized.message = message;
	return serialized;
}

function serializeDrizzleQueryError(error: DrizzleQueryError): Record<string, string> {
	const serialized: Record<string, string> = { type: "DrizzleQueryError" };
	const cause = ownDataProperty(error, "cause");
	const code = ownStringProperty(cause, "code");
	const severity = ownStringProperty(cause, "severity");
	if (code && POSTGRES_ERROR_CODE.test(code)) serialized.code = code;
	if (severity && POSTGRES_SEVERITIES.has(severity)) serialized.severity = severity;
	return serialized;
}

function serializeLogError(error: unknown): unknown {
	if (error instanceof DrizzleQueryError) return serializeDrizzleQueryError(error);
	if (error instanceof Error) return serializeStandardError(error);
	if (
		error === null ||
		typeof error === "string" ||
		typeof error === "number" ||
		typeof error === "boolean"
	) {
		return error;
	}
	return { type: "NonError" };
}

export function createLogger(
	config: Pick<RelayConfig, "RELAY_LOG_LEVEL" | "RELAY_ENV">,
	destination?: DestinationStream,
): Logger {
	return pino(
		{
			level: config.RELAY_LOG_LEVEL,
			base: { env: config.RELAY_ENV, service: "relay" },
			timestamp: pino.stdTimeFunctions.isoTime,
			serializers: { err: serializeLogError },
			redact: {
				paths: [
					"req.headers.authorization",
					"req.headers.cookie",
					"*.api_key",
					"*.password",
					"*.notification_webhook_url",
				],
				censor: "[redacted]",
			},
		},
		destination,
	);
}

export type { Logger };
