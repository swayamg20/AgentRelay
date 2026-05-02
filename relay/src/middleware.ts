import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Logger } from "./logger.js";

export const REQUEST_ID_HEADER = "x-request-id";

export interface AppVariables {
	requestId: string;
	logger: Logger;
}

export function requestIdMiddleware(): MiddlewareHandler<{ Variables: AppVariables }> {
	return async (c, next) => {
		const incoming = c.req.header(REQUEST_ID_HEADER);
		const id = incoming && incoming.length > 0 ? incoming : `req_${randomUUID()}`;
		c.set("requestId", id);
		c.header(REQUEST_ID_HEADER, id);
		await next();
	};
}

export function loggerMiddleware(
	rootLogger: Logger,
): MiddlewareHandler<{ Variables: AppVariables }> {
	return async (c, next) => {
		const requestId = c.get("requestId");
		const child = rootLogger.child({ request_id: requestId, route: c.req.path });
		c.set("logger", child);

		const started = Date.now();
		child.info({ method: c.req.method, event: "request.start" });
		try {
			await next();
		} finally {
			const duration_ms = Date.now() - started;
			child.info({
				method: c.req.method,
				status: c.res.status,
				duration_ms,
				event: "request.complete",
			});
		}
	};
}
