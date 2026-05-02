import pino, { type Logger } from "pino";
import type { RelayConfig } from "./config.js";

export function createLogger(config: Pick<RelayConfig, "RELAY_LOG_LEVEL" | "RELAY_ENV">): Logger {
	return pino({
		level: config.RELAY_LOG_LEVEL,
		base: { env: config.RELAY_ENV, service: "relay" },
		timestamp: pino.stdTimeFunctions.isoTime,
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
	});
}

export type { Logger };
