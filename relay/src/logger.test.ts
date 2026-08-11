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

	const logger = createLogger(LOG_CONFIG, destination);
	logger.child({ request_id: "req_test" }).error({ err: error }, "request failed");
	return JSON.parse(output) as Record<string, unknown>;
}

type ErrorWrapper = (error: DrizzleQueryError) => unknown;

const DRIZZLE_ERROR_WRAPPERS: Array<[string, ErrorWrapper]> = [
	["standard cause", (error) => new Error("outer request diagnostic", { cause: error })],
	[
		"native aggregate",
		(error) => new AggregateError([new Error("ordinary batch error"), error], "batch failed"),
	],
	[
		"standard Error errors array",
		(error) => Object.assign(new Error("custom batch failed"), { errors: [error] }),
	],
	[
		"VError-style cause function",
		(error) => Object.assign(new Error("legacy wrapper failed"), { cause: () => error }),
	],
	[
		"enumerable nested property",
		(error) => Object.assign(new Error("nested failure"), { context: { failure: error } }),
	],
	[
		"cyclic errors array",
		(error) => {
			const outer = Object.assign(new Error("cyclic batch failed"), { errors: [] as unknown[] });
			outer.errors.push(outer, error);
			return outer;
		},
	],
];

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

	it("preserves only inert fields for other errors", () => {
		const entry = captureError(new Error("ordinary diagnostic"));
		expect(entry.err).toEqual({ type: "Error", message: "ordinary diagnostic" });
	});

	it.each(DRIZZLE_ERROR_WRAPPERS)("removes query details from a %s", (_name, wrap) => {
		const sensitiveBody = "sentinel-nested-message-body";
		const drizzleError = new DrizzleQueryError(
			"insert into messages (body) values ($1)",
			[sensitiveBody],
			Object.assign(new Error(`database rejected ${sensitiveBody}`), {
				code: "23514",
				severity: "ERROR",
			}),
		);
		const entry = captureError(wrap(drizzleError));
		const serialized = JSON.stringify(entry);

		expect(entry.err).toMatchObject({ type: "Error" });
		expect(serialized).not.toContain(sensitiveBody);
		expect(serialized).not.toContain("insert into messages");
		expect(serialized).not.toContain("database rejected");
	});

	it("does not invoke dynamic serialization hooks", () => {
		let hookCalls = 0;
		const error = Object.assign(new Error("safe outer diagnostic"), {
			cause: () => {
				hookCalls += 1;
				throw new Error("cause hook must not run");
			},
			context: {
				get failure() {
					hookCalls += 1;
					throw new Error("getter must not run");
				},
				toJSON() {
					hookCalls += 1;
					throw new Error("toJSON hook must not run");
				},
			},
		});
		Object.defineProperty(error, "stack", {
			configurable: true,
			get() {
				hookCalls += 1;
				throw new Error("stack getter must not run");
			},
		});

		const entry = captureError(error);

		expect(hookCalls).toBe(0);
		expect(entry.err).toEqual({ type: "Error", message: "safe outer diagnostic" });
	});

	it("does not invoke a dynamic error display property", () => {
		let nameGetterCalls = 0;
		const error = new Error("safe display diagnostic");
		Object.defineProperty(error, "name", {
			configurable: true,
			get() {
				nameGetterCalls += 1;
				return "sentinel-dynamic-name";
			},
		});

		const entry = captureError(error);

		expect(nameGetterCalls).toBe(0);
		expect(entry.err).toEqual({ type: "Error", message: "safe display diagnostic" });
		expect(JSON.stringify(entry)).not.toContain("sentinel-dynamic-name");
	});

	it("does not invoke a dynamic error message", () => {
		let messageGetterCalls = 0;
		const error = new Error("initial message");
		Object.defineProperty(error, "message", {
			configurable: true,
			get() {
				messageGetterCalls += 1;
				return "sentinel-dynamic-message";
			},
		});

		const entry = captureError(error);

		expect(messageGetterCalls).toBe(0);
		expect(entry.err).toEqual({ type: "Error" });
		expect(JSON.stringify(entry)).not.toContain("sentinel-dynamic-message");
	});

	it("omits a lazy stack formatted before logging", () => {
		const originalDescriptor = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
		const error = new Error("safe cached diagnostic");
		Object.defineProperty(Error, "prepareStackTrace", {
			configurable: true,
			value: () => "sentinel-cached-stack",
		});

		try {
			expect(error.stack).toBe("sentinel-cached-stack");
		} finally {
			if (originalDescriptor) {
				Object.defineProperty(Error, "prepareStackTrace", originalDescriptor);
			} else {
				Reflect.deleteProperty(Error, "prepareStackTrace");
			}
		}

		const entry = captureError(error);
		expect(entry.err).toEqual({ type: "Error", message: "safe cached diagnostic" });
		expect(JSON.stringify(entry)).not.toContain("sentinel-cached-stack");
	});

	it("fails closed for non-Error objects", () => {
		let toJsonCalls = 0;
		const entry = captureError({
			message: "plain object",
			toJSON() {
				toJsonCalls += 1;
				return { secret: "sentinel-plain-object-secret" };
			},
		});

		expect(toJsonCalls).toBe(0);
		expect(entry.err).toEqual({ type: "NonError" });
		expect(JSON.stringify(entry)).not.toContain("sentinel-plain-object-secret");
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
