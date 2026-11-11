import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { agentCards, agents, notificationOutbox } from "../db/schema.js";
import { type TestDb, truncateAll, tryConnect } from "../db/test-utils.js";
import { createHandoff } from "../services/handoff.js";
import { encryptWebhook } from "./crypto.js";

const connection = await tryConnect();
const databaseDescribe = connection.available ? describe : describe.skip;
if (!connection.available) console.warn(`[dispatcher-process.test] skipping: ${connection.reason}`);
const ENCRYPTION_KEY = "notification-process-test-key";
const eventSchema = z.object({
	event: z.enum(["ready", "claimed", "attempt"]),
	jobId: z.string().uuid().optional(),
});

databaseDescribe("notification worker process recovery", () => {
	let handle: TestDb;
	const children = new Set<ChildProcess>();

	beforeAll(() => {
		if (!connection.handle) throw new Error("expected database handle");
		handle = connection.handle;
	});
	beforeEach(async () => {
		await truncateAll(handle.sql);
	});
	afterEach(async () => {
		await Promise.all([...children].map((child) => kill(child)));
	});
	afterAll(async () => {
		await handle?.close();
	});

	async function enqueue() {
		const [sender, recipient] = await handle.db
			.insert(agents)
			.values([
				{ handle: "bob@process", email: "bob@process.test", displayName: "Bob", role: "backend" },
				{
					handle: "frank@process",
					email: "frank@process.test",
					displayName: "Frank",
					role: "frontend",
				},
			])
			.returning();
		if (!sender || !recipient) throw new Error("expected agents");
		await handle.db.insert(agentCards).values({
			agentId: recipient.id,
			card: {},
			notificationWebhookUrl: encryptWebhook(
				"https://hooks.slack.com/services/T/B/test",
				ENCRYPTION_KEY,
			),
		});
		await createHandoff(
			handle.db,
			{
				senderId: sender.id,
				recipientHandle: recipient.handle,
				summary: "process recovery fixture",
				intent: "inform",
				artifacts: [],
				initialPayload: {},
				proposedAction: null,
				metadata: {},
				idempotencyKey: null,
				requestId: "notification-process-test",
			},
			{ encryptionKey: ENCRYPTION_KEY, publicUrl: "http://localhost:8080" },
		);
		const [job] = await handle.db.select().from(notificationOutbox);
		if (!job) throw new Error("expected job");
		return job;
	}

	function start(mode: "claim" | "deliver" | "lose_response") {
		const child = fork(
			fileURLToPath(new URL("../../tests/notification-worker.ts", import.meta.url)),
			[],
			{
				execArgv: ["--import", "tsx/esm"],
				cwd: fileURLToPath(new URL("../..", import.meta.url)),
				env: {
					PATH: process.env.PATH,
					RELAY_TEST_DATABASE_URL:
						process.env.RELAY_TEST_DATABASE_URL ?? process.env.RELAY_DATABASE_URL,
					RELAY_ENCRYPTION_KEY: ENCRYPTION_KEY,
					NOTIFICATION_TEST_MODE: mode,
				},
				stdio: ["ignore", "ignore", "ignore", "ipc"],
			},
		);
		children.add(child);
		const events: Array<z.infer<typeof eventSchema>> = [];
		child.on("message", (message) => {
			events.push(eventSchema.parse(message));
		});
		return { child, events };
	}

	async function kill(child: ChildProcess) {
		if (child.exitCode !== null || child.signalCode !== null) {
			children.delete(child);
			return;
		}
		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
		});
		child.kill("SIGKILL");
		await exited;
		children.delete(child);
	}

	async function stored(jobId: string) {
		const [job] = await handle.db
			.select()
			.from(notificationOutbox)
			.where(eq(notificationOutbox.id, jobId));
		if (!job) throw new Error("expected stored job");
		return job;
	}

	it("finds committed jobs when a worker starts in another process", async () => {
		const job = await enqueue();
		const worker = start("deliver");
		await vi.waitFor(
			async () => {
				expect((await stored(job.id)).status).toBe("succeeded");
			},
			{ timeout: 10_000 },
		);
		expect(worker.events.filter((event) => event.event === "attempt")).toHaveLength(1);
	});

	it("recovers after SIGKILL following a claim without changing its lease deadline", async () => {
		const job = await enqueue();
		const first = start("claim");
		await vi.waitFor(
			() => {
				expect(first.events).toContainEqual({ event: "claimed", jobId: job.id });
			},
			{ timeout: 10_000 },
		);
		const claimed = await stored(job.id);
		expect(claimed).toMatchObject({ status: "leased", attempts: 1 });
		await kill(first.child);
		const second = start("deliver");
		await vi.waitFor(
			() => {
				expect(second.events).toContainEqual({ event: "ready" });
			},
			{ timeout: 10_000 },
		);
		expect(await stored(job.id)).toEqual(claimed);
		await vi.waitFor(
			async () => {
				expect((await stored(job.id)).status).toBe("succeeded");
			},
			{ timeout: 35_000 },
		);
		expect(await stored(job.id)).toMatchObject({ attempts: 2 });
		expect(second.events.filter((event) => event.event === "attempt")).toHaveLength(1);
	}, 45_000);

	it("allows a duplicate external attempt after SIGKILL with a provider response withheld", async () => {
		const job = await enqueue();
		const first = start("lose_response");
		await vi.waitFor(
			() => {
				expect(first.events).toContainEqual({ event: "attempt" });
			},
			{ timeout: 10_000 },
		);
		await kill(first.child);
		const second = start("deliver");
		await vi.waitFor(
			async () => {
				expect((await stored(job.id)).status).toBe("succeeded");
			},
			{ timeout: 35_000 },
		);
		expect(first.events.filter((event) => event.event === "attempt")).toHaveLength(1);
		expect(second.events.filter((event) => event.event === "attempt")).toHaveLength(1);
		expect(await stored(job.id)).toMatchObject({ status: "succeeded", attempts: 2 });
	}, 45_000);
});
