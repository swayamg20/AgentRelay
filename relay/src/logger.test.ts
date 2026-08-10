import { PassThrough } from "node:stream";
import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

const LOG_CONFIG = {
	RELAY_ENV: "test" as const,
	RELAY_LOG_LEVEL: "info" as const,
};

function captureError(error: unknown): Record<string, unknown> {
	const destination = new PassThrough();
	let output = "";
	destination.on("data", (chunk: Buffer) => {
		output += chunk.toString("utf8");
	});

	createLogger(LOG_CONFIG, destination)
		.child({ request_id: "req_test" })
		.error({ err: error }, "request failed");
	return JSON.parse(output) as Record<string, unknown>;
}

describe("relay logger", () => {
	it("removes query text and bound values from Drizzle errors", () => {
		const sensitiveBody = "sentinel-private-message-body";
		const cause = Object.assign(new Error(`database rejected ${sensitiveBody}`), {
			code: "23514",
			severity: "ERROR",
		});
		const error = new DrizzleQueryError(
			"insert into messages (body) values ($1)",
			[sensitiveBody],
			cause,
		);

		const entry = captureError(error);
		const serialized = JSON.stringify(entry);

		expect(entry.err).toEqual({
			type: "DrizzleQueryError",
			code: "23514",
			severity: "ERROR",
		});
		expect(entry.request_id).toBe("req_test");
		expect(serialized).not.toContain(sensitiveBody);
		expect(serialized).not.toContain("insert into messages");
		expect(serialized).not.toContain("database rejected");
	});

	it("preserves standard serialization for other errors", () => {
		const entry = captureError(new Error("ordinary diagnostic"));

		expect(entry.err).toMatchObject({
			type: "Error",
			message: "ordinary diagnostic",
		});
	});

	it("removes query details from a wrapped Drizzle error", () => {
		const sensitiveBody = "sentinel-wrapped-message-body";
		const drizzleError = new DrizzleQueryError(
			"insert into messages (body) values ($1)",
			[sensitiveBody],
			Object.assign(new Error(`database rejected ${sensitiveBody}`), {
				code: "23514",
				severity: "ERROR",
			}),
		);
		const entry = captureError(new Error("outer request diagnostic", { cause: drizzleError }));
		const serialized = JSON.stringify(entry);

		expect(entry.err).toEqual({
			type: "DrizzleQueryError",
			code: "23514",
			severity: "ERROR",
		});
		expect(serialized).not.toContain(sensitiveBody);
		expect(serialized).not.toContain("insert into messages");
		expect(serialized).not.toContain("database rejected");
	});

	it("removes query details from an aggregated Drizzle error", () => {
		const sensitiveBody = "sentinel-aggregated-message-body";
		const drizzleError = new DrizzleQueryError(
			"update messages set body = $1",
			[sensitiveBody],
			new Error(`database rejected ${sensitiveBody}`),
		);
		const entry = captureError(
			new AggregateError([new Error("ordinary batch error"), drizzleError], "batch failed"),
		);
		const serialized = JSON.stringify(entry);

		expect(entry.err).toEqual({ type: "DrizzleQueryError" });
		expect(serialized).not.toContain(sensitiveBody);
		expect(serialized).not.toContain("update messages");
		expect(serialized).not.toContain("database rejected");
	});

	it("removes query details from a Drizzle error in a standard error array", () => {
		const sensitiveBody = "sentinel-custom-error-array-body";
		const drizzleError = new DrizzleQueryError(
			"delete from messages where body = $1",
			[sensitiveBody],
			new Error(`database rejected ${sensitiveBody}`),
		);
		const entry = captureError(
			Object.assign(new Error("custom batch failed"), {
				errors: [new Error("ordinary batch error"), drizzleError],
			}),
		);
		const serialized = JSON.stringify(entry);

		expect(entry.err).toEqual({ type: "DrizzleQueryError" });
		expect(serialized).not.toContain(sensitiveBody);
		expect(serialized).not.toContain("delete from messages");
		expect(serialized).not.toContain("database rejected");
	});

	it("omits unrecognized Drizzle cause metadata", () => {
		const sensitiveMetadata = "sentinel-arbitrary-cause-value";
		const error = new DrizzleQueryError(
			"select 1",
			[],
			Object.assign(new Error("failed"), {
				code: sensitiveMetadata,
				severity: sensitiveMetadata,
			}),
		);

		const entry = captureError(error);
		expect(entry.err).toEqual({ type: "DrizzleQueryError" });
		expect(JSON.stringify(entry)).not.toContain(sensitiveMetadata);
	});
});
