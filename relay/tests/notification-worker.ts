import { z } from "zod";
import { createDb } from "../src/db/client.js";
import { createLogger } from "../src/logger.js";
import { NotificationDispatcher } from "../src/notifications/dispatcher.js";

const settings = z
	.object({
		RELAY_TEST_DATABASE_URL: z.string().url(),
		RELAY_ENCRYPTION_KEY: z.string().min(1),
		NOTIFICATION_TEST_MODE: z.enum(["claim", "deliver", "lose_response"]),
	})
	.parse(process.env);
const handle = createDb({
	RELAY_DATABASE_URL: settings.RELAY_TEST_DATABASE_URL,
	RELAY_DB_POOL_SIZE: 2,
});
const dispatcher = new NotificationDispatcher({
	db: handle.db,
	encryptionKey: settings.RELAY_ENCRYPTION_KEY,
	logger: createLogger({ RELAY_LOG_LEVEL: "fatal", RELAY_ENV: "dev" }),
	pollIntervalMs: 10,
	slackPoster: async () => {
		process.send?.({ event: "attempt" });
		if (settings.NOTIFICATION_TEST_MODE === "lose_response") {
			return new Promise<never>(() => {});
		}
		return { status: 200, ok: true };
	},
});

if (settings.NOTIFICATION_TEST_MODE === "claim") {
	const job = await dispatcher.claimDueJob();
	if (!job) process.exit(1);
	process.send?.({ event: "claimed", jobId: job.id });
	setInterval(() => {}, 1_000);
} else {
	dispatcher.start();
	process.send?.({ event: "ready" });
}

process.on("SIGTERM", () => {
	void dispatcher
		.stop()
		.then(() => handle.close())
		.then(() => process.exit(0));
});
