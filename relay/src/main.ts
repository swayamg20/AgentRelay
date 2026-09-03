import { serve } from "@hono/node-server";
import { config as loadDotenv } from "dotenv";
import postgres, { type Sql } from "postgres";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { type MailboxSignalHub, createMailboxSignalHub } from "./events/mailbox-signal.js";
import { createLogger } from "./logger.js";
import { NotificationDispatcher } from "./notifications/dispatcher.js";
import { createServer } from "./server.js";

loadDotenv();

const config = loadConfig();
const logger = createLogger(config);
const dbHandle = createDb(config);
let mailboxSignalSql: Sql | null = postgres(config.RELAY_DATABASE_URL, {
	max: 1,
	onnotice: () => undefined,
});
let mailboxSignalHub: MailboxSignalHub | undefined;
const candidateMailboxSignalHub = createMailboxSignalHub(mailboxSignalSql);
try {
	await withTimeout(candidateMailboxSignalHub.start(), 5_000, "mailbox listener startup timed out");
	mailboxSignalHub = candidateMailboxSignalHub;
} catch (err) {
	logger.warn({ err }, "mailbox live hints unavailable; durable replay remains enabled");
	await candidateMailboxSignalHub.stop().catch(() => undefined);
	await mailboxSignalSql.end({ timeout: 0 }).catch(() => undefined);
	mailboxSignalSql = null;
}
const dispatcher = new NotificationDispatcher({
	db: dbHandle.db,
	encryptionKey: config.RELAY_ENCRYPTION_KEY,
	publicUrl: config.RELAY_PUBLIC_URL,
	logger,
});
dispatcher.start();
const app = createServer({
	config,
	logger,
	db: dbHandle.db,
	mailboxSignalHub,
	notify: (job) => dispatcher.enqueue(job),
	readinessProbe: async () => {
		try {
			await dbHandle.sql`SELECT 1`;
			return true;
		} catch (err) {
			logger.warn({ err }, "readiness probe failed");
			return false;
		}
	},
});

const server = serve({ fetch: app.fetch, port: config.RELAY_PORT }, (info) => {
	logger.info(
		{ event: "server.listening", port: info.port, env: config.RELAY_ENV },
		`Relay listening on :${info.port}`,
	);
});

let shuttingDown = false;
const shutdown = (signal: string): void => {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info({ event: "server.shutdown", signal }, "shutting down");
	const mailboxSignalsStop = Promise.all([
		mailboxSignalHub
			?.stop()
			.catch((stopErr) => logger.warn({ err: stopErr }, "mailbox signal listener stop failed")),
		mailboxSignalSql
			?.end({ timeout: 1 })
			.catch((stopErr) =>
				logger.warn({ err: stopErr }, "mailbox listener connection close failed"),
			),
	]);
	const forceClose = setTimeout(() => {
		logger.warn("forcing remaining HTTP connections closed during shutdown");
		const forceClosableServer = server as typeof server & {
			closeAllConnections?: () => void;
		};
		forceClosableServer.closeAllConnections?.();
	}, 5_000);
	forceClose.unref();
	server.close(async (err) => {
		clearTimeout(forceClose);
		await mailboxSignalsStop;
		if (err) {
			logger.error({ err }, "error during shutdown");
		}
		await dispatcher
			.stop()
			.catch((stopErr) => logger.warn({ err: stopErr }, "dispatcher stop failed"));
		await dbHandle.close().catch((closeErr) => logger.warn({ err: closeErr }, "db close failed"));
		process.exit(err ? 1 : 0);
	});
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timeout);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}
