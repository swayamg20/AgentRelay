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

function stringProperty(value: unknown, key: string): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = (value as Record<string, unknown>)[key];
	return typeof candidate === "string" ? candidate : undefined;
}

function findDrizzleQueryError(
	value: unknown,
	seen = new Set<object>(),
): DrizzleQueryError | undefined {
	if (value instanceof DrizzleQueryError) return value;
	if (!(value instanceof Error) || seen.has(value)) return undefined;

	seen.add(value);
	const causedByDrizzle = findDrizzleQueryError(value.cause, seen);
	if (causedByDrizzle) return causedByDrizzle;

	const nestedErrors = (value as Error & { errors?: unknown }).errors;
	if (Array.isArray(nestedErrors)) {
		for (const nestedError of nestedErrors) {
			const aggregatedDrizzleError = findDrizzleQueryError(nestedError, seen);
			if (aggregatedDrizzleError) return aggregatedDrizzleError;
		}
	}
	return undefined;
}

function serializeDrizzleQueryError(error: DrizzleQueryError): Record<string, string> {
	const serialized: Record<string, string> = { type: "DrizzleQueryError" };
	const code = stringProperty(error.cause, "code");
	const severity = stringProperty(error.cause, "severity");
	if (code && POSTGRES_ERROR_CODE.test(code)) serialized.code = code;
	if (severity && POSTGRES_SEVERITIES.has(severity)) serialized.severity = severity;
	return serialized;
}

function serializeLogError(error: unknown): unknown {
	const drizzleError = findDrizzleQueryError(error);
	if (drizzleError) return serializeDrizzleQueryError(drizzleError);
	return error instanceof Error ? pino.stdSerializers.err(error) : error;
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
