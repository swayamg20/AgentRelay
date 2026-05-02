import { Hono } from "hono";
import type { RelayConfig } from "./config.js";
import type { Database } from "./db/client.js";
import { type ErrorEnvelope, RelayError } from "./errors.js";
import type { Logger } from "./logger.js";
import { loggerMiddleware, requestIdMiddleware } from "./middleware.js";
import type { NotificationJob } from "./notifications/types.js";
import { createA2aRoutes } from "./routes/a2a.js";
import { createAdminRoutes } from "./routes/admin.js";
import { createAgentsRoutes } from "./routes/agents.js";
import type { AppEnv } from "./types.js";

export type { AppEnv };

export interface CreateServerOptions {
	config: RelayConfig;
	logger: Logger;
	/** Database handle. Optional so unit tests can run without a DB. */
	db?: Database;
	/** Async readiness probe; default returns true. */
	readinessProbe?: () => Promise<boolean>;
	/** Notification sink. Failures here must not block requests (lld §9.4). */
	notify?: (job: NotificationJob) => void;
}

export function createServer(opts: CreateServerOptions): Hono<AppEnv> {
	const { config, logger, db, readinessProbe } = opts;
	const app = new Hono<AppEnv>();

	app.use("*", requestIdMiddleware());
	app.use("*", loggerMiddleware(logger));

	app.get("/healthz", (c) => c.json({ status: "ok" }));

	app.get("/readyz", async (c) => {
		const ok = readinessProbe ? await readinessProbe() : true;
		if (!ok) {
			const envelope: ErrorEnvelope = {
				code: "internal",
				message: "not ready",
				request_id: c.get("requestId"),
			};
			return c.json(envelope, 503);
		}
		return c.json({ status: "ready" });
	});

	if (db) {
		const keyEnvironment = config.RELAY_ENV === "production" ? "live" : "test";
		app.route(
			"/admin",
			createAdminRoutes({
				db,
				adminToken: config.RELAY_ADMIN_TOKEN,
				pepper: config.RELAY_PEPPER,
				keyEnvironment,
			}),
		);
		app.route("/agents", createAgentsRoutes({ db, pepper: config.RELAY_PEPPER, keyEnvironment }));
		app.route(
			"/a2a",
			createA2aRoutes({
				db,
				pepper: config.RELAY_PEPPER,
				publicUrl: config.RELAY_PUBLIC_URL,
				notify: opts.notify,
			}),
		);
	}

	app.notFound((c) => {
		const envelope: ErrorEnvelope = {
			code: "method_not_found",
			message: `No route for ${c.req.method} ${c.req.path}`,
			request_id: c.get("requestId"),
		};
		return c.json(envelope, 404);
	});

	app.onError((err, c) => {
		const requestId = c.get("requestId");
		const log = c.get("logger") ?? logger;

		if (err instanceof RelayError) {
			log.warn({ event: "request.error", code: err.code, details: err.details }, err.message);
			return c.json(err.toEnvelope(requestId), err.httpStatus as never);
		}

		log.error({ event: "request.error", err }, "unhandled error");
		const envelope: ErrorEnvelope = {
			code: "internal",
			message: "Internal server error",
			request_id: requestId,
		};
		return c.json(envelope, 500);
	});

	return app;
}
