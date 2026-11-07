import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearLastUsedDebounce } from "../auth/middleware.js";
import { loadConfig } from "../config.js";
import {
	agentBlocks,
	agentCards,
	agents,
	auditLog,
	handoffs,
	mailboxEvents,
	notificationOutbox,
} from "../db/schema.js";
import { type TestDb, truncateAll, tryConnect } from "../db/test-utils.js";
import { createLogger } from "../logger.js";
import { createServer } from "../server.js";
import { lockAgentBlockPair } from "../services/agent-block-lock.js";

const conn = await tryConnect();
const d = conn.available ? describe : describe.skip;
if (!conn.available) {
	// biome-ignore lint/suspicious/noConsoleLog: integration tests self-skip without DB
	console.warn(`[a2a.test] skipping: ${conn.reason}`);
}

const TEST_ENV = {
	RELAY_DATABASE_URL: process.env.RELAY_TEST_DATABASE_URL ?? "postgres://x:y@localhost/x",
	RELAY_PEPPER: "p".repeat(32),
	RELAY_ENCRYPTION_KEY: "e".repeat(16),
	RELAY_INVITE_SECRET: "i".repeat(32),
	RELAY_ADMIN_TOKEN: "admin-token-secret",
	RELAY_METRICS_TOKEN: "metrics-token",
	RELAY_PUBLIC_URL: "http://localhost:8080",
	RELAY_ENV: "dev" as const,
	RELAY_LOG_LEVEL: "fatal" as const,
};

d("a2a JSON-RPC + state machine", () => {
	let handle: TestDb;
	let app: ReturnType<typeof createServer>;

	beforeAll(() => {
		if (!conn.handle) throw new Error("expected db handle");
		handle = conn.handle;
		const config = loadConfig({ ...TEST_ENV } as NodeJS.ProcessEnv);
		const logger = createLogger(config);
		app = createServer({ config, logger, db: handle.db });
	});

	beforeEach(async () => {
		await truncateAll(handle.sql);
		clearLastUsedDebounce();
	});

	afterAll(async () => {
		if (handle) await handle.close();
	});

	function adminHeaders(): HeadersInit {
		return {
			authorization: `Bearer ${TEST_ENV.RELAY_ADMIN_TOKEN}`,
			"content-type": "application/json",
		};
	}
	function bearer(token: string): HeadersInit {
		return { authorization: `Bearer ${token}`, "content-type": "application/json" };
	}

	async function register(handleStr: string): Promise<{ id: string; key: string }> {
		const res = await app.request("/admin/agents", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({
				handle: handleStr,
				email: `${handleStr.split("@")[0]}@acme.com`,
				display_name: handleStr,
				role: "engineer",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { agent_id: string; api_key: string };
		return { id: body.agent_id, key: body.api_key };
	}

	async function rpc(
		key: string,
		method: string,
		params: unknown,
		rpcId: string | number = "r1",
	): Promise<{ status: number; body: { id?: unknown; result?: any; error?: any } }> {
		const res = await app.request("/a2a", {
			method: "POST",
			headers: bearer(key),
			body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
		});
		return { status: res.status, body: (await res.json()) as any };
	}

	describe("agents/list roster", () => {
		let caller: { id: string; key: string };
		let bob: { id: string; key: string };

		beforeEach(async () => {
			caller = await register("dora@acme");
			bob = await register("bob@acme");
			const alice = await register("alice@acme");
			const claire = await register("claire@acme");
			const disabled = await register("disabled@acme");
			for (const profile of [
				{
					id: alice.id,
					role: "backend",
					skills: ["TypeScript", "Type Script"],
					repos: ["acme/core"],
				},
				{ id: bob.id, role: "backend", skills: ["Go", "TypeScript"], repos: ["acme/api"] },
				{ id: claire.id, role: "frontend", skills: ["TypeScript"], repos: ["acme/core"] },
				{ id: disabled.id, role: "backend", skills: ["TypeScript"], repos: ["acme/core"] },
			]) {
				await handle.db.update(agents).set({ role: profile.role }).where(eq(agents.id, profile.id));
				await handle.db.insert(agentCards).values({
					agentId: profile.id,
					card: {},
					skills: profile.skills,
					reposOwned: profile.repos,
				});
			}
			await handle.db.update(agents).set({ status: "disabled" }).where(eq(agents.id, disabled.id));
			await handle.db.delete(agentCards).where(eq(agentCards.agentId, caller.id));
		});

		it.each([undefined, null, {}])("preserves the legacy shape for %j", async (params) => {
			const result = await rpc(caller.key, "agents/list", params);
			expect(result.status).toBe(200);
			expect(result.body.result).toEqual({
				teammates: [
					{
						handle: "alice@acme",
						name: "alice@acme",
						role: "backend",
						skills: ["TypeScript", "Type Script"],
						repos_owned: ["acme/core"],
					},
					{
						handle: "bob@acme",
						name: "bob@acme",
						role: "backend",
						skills: ["Go", "TypeScript"],
						repos_owned: ["acme/api"],
					},
					{
						handle: "claire@acme",
						name: "claire@acme",
						role: "frontend",
						skills: ["TypeScript"],
						repos_owned: ["acme/core"],
					},
					{ handle: "dora@acme", name: "dora@acme", role: "engineer", skills: [], repos_owned: [] },
				],
			});
		});

		it.each([
			[{ role: " backend " }, ["alice@acme", "bob@acme"]],
			[{ skill: " TypeScript " }, ["alice@acme", "bob@acme", "claire@acme"]],
			[{ repo: " acme/core " }, ["alice@acme", "claire@acme"]],
			[{ role: "backend", skill: "TypeScript", repo: "acme/core" }, ["alice@acme"]],
			[{ role: "frontend", skill: "Go" }, []],
			[{ skill: "Type Script" }, ["alice@acme"]],
			[{ skill: "Type" }, []],
			[{ role: "Backend" }, []],
			[{ skill: "typescript" }, []],
			[{ repo: "ACME/core" }, []],
			[{ repo: "core" }, []],
			[{ role: "unknown" }, []],
			[{ skill: "TypeScript,Go" }, []],
			[{ skill: "' OR true --" }, []],
		])("matches exact AND-combined filters %j", async (params, expected) => {
			const result = await rpc(caller.key, "agents/list", params);
			expect(result.status).toBe(200);
			expect(
				result.body.result.teammates.map((teammate: { handle: string }) => teammate.handle),
			).toEqual(expected);
			expect(result.body.result).not.toHaveProperty("next_cursor");
		});

		it.each([
			[],
			"backend",
			false,
			{ team: "acme" },
			{ filter: { role: "backend" } },
			{ role: "" },
			{ skill: " \t " },
			{ repo: "" },
			{ role: 3 },
			{ skill: ["TypeScript"] },
			{ repo: null },
			{ role: "x".repeat(61) },
			{ skill: "x".repeat(61) },
			{ repo: "x".repeat(201) },
			{ page: null },
			{ page: [] },
			{ page: { limit: 0 } },
			{ page: { limit: -1 } },
			{ page: { limit: 201 } },
			{ page: { limit: 1.5 } },
			{ page: { limit: "2" } },
			{ page: { offset: 0 } },
			{ page: { cursor: "bob@acme" } },
			{ page: { cursor: {} } },
			{ page: { cursor: { after_handle: "" } } },
			{ page: { cursor: { after_handle: "not a handle" } } },
			{ page: { cursor: { after_handle: "bob@acme", extra: true } } },
			{ page: { cursor: { after_handle: `${"x".repeat(116)}@acme` } } },
		])("rejects malformed filters/pages %j", async (params) => {
			const result = await rpc(caller.key, "agents/list", params);
			expect(result.status).toBe(400);
			expect(result.body.error.code).toBe(-32602);
			expect(result.body.error.data.code).toBe("invalid_params");
		});

		it("continues filtered pages without duplicates and ends with a null cursor", async () => {
			const first = await rpc(caller.key, "agents/list", {
				skill: "TypeScript",
				page: { limit: 2 },
			});
			expect(
				first.body.result.teammates.map((teammate: { handle: string }) => teammate.handle),
			).toEqual(["alice@acme", "bob@acme"]);
			expect(first.body.result.next_cursor).toEqual({ after_handle: "bob@acme" });
			const second = await rpc(caller.key, "agents/list", {
				skill: "TypeScript",
				page: { limit: 2, cursor: first.body.result.next_cursor },
			});
			expect(
				second.body.result.teammates.map((teammate: { handle: string }) => teammate.handle),
			).toEqual(["claire@acme"]);
			expect(second.body.result.next_cursor).toBeNull();
			const empty = await rpc(caller.key, "agents/list", {
				skill: "TypeScript",
				page: { cursor: { after_handle: "claire@acme" } },
			});
			expect(empty.body.result).toEqual({ teammates: [], next_cursor: null });
		});

		it("returns null for empty and exactly-full final pages", async () => {
			const empty = await rpc(caller.key, "agents/list", { role: "unknown", page: {} });
			expect(empty.body.result).toEqual({ teammates: [], next_cursor: null });
			const full = await rpc(caller.key, "agents/list", {
				role: "backend",
				page: { limit: 2, cursor: null },
			});
			expect(full.body.result.teammates).toHaveLength(2);
			expect(full.body.result.next_cursor).toBeNull();
		});

		it("bounds opted-in pages but leaves the legacy roster unbounded", async () => {
			await handle.db.insert(agents).values(
				Array.from({ length: 205 }, (_, index) => ({
					handle: `member${String(index).padStart(3, "0")}@acme`,
					email: `member${index}@acme.com`,
					displayName: "Member",
					role: "engineer",
				})),
			);
			const defaults = await rpc(caller.key, "agents/list", { page: {} });
			expect(defaults.body.result.teammates).toHaveLength(50);
			expect(defaults.body.result.next_cursor).toEqual({ after_handle: "member045@acme" });
			const maximum = await rpc(caller.key, "agents/list", { page: { limit: 200 } });
			expect(maximum.body.result.teammates).toHaveLength(200);
			const continuation = await rpc(caller.key, "agents/list", {
				page: { limit: 200, cursor: maximum.body.result.next_cursor },
			});
			expect(continuation.body.result.teammates).toHaveLength(9);
			expect(continuation.body.result.next_cursor).toBeNull();
			const combined = [
				...maximum.body.result.teammates,
				...continuation.body.result.teammates,
			].map((teammate: { handle: string }) => teammate.handle);
			expect(new Set(combined).size).toBe(209);
			const legacy = await rpc(caller.key, "agents/list", {});
			expect(
				legacy.body.result.teammates.map((teammate: { handle: string }) => teammate.handle),
			).toEqual(combined);
			expect(legacy.body.result).not.toHaveProperty("next_cursor");
		});

		it("preserves block-list discovery behavior and leaves REST GET /agents unchanged", async () => {
			await handle.db.insert(agentBlocks).values([
				{ blockerId: caller.id, blockedId: bob.id },
				{ blockerId: bob.id, blockedId: caller.id },
			]);
			const result = await rpc(caller.key, "agents/list", { role: "backend", page: {} });
			expect(
				result.body.result.teammates.map((teammate: { handle: string }) => teammate.handle),
			).toEqual(["alice@acme", "bob@acme"]);
			const rest = await app.request("/agents?role=unknown&page=invalid", {
				headers: bearer(caller.key),
			});
			expect(rest.status).toBe(200);
			expect(await rest.json()).not.toHaveProperty("next_cursor");
		});

		it("requires an active authenticated caller even with invalid filters", async () => {
			const unauthenticated = await app.request("/a2a", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: "roster",
					method: "agents/list",
					params: { page: {} },
				}),
			});
			expect(unauthenticated.status).toBe(401);
			await handle.db.update(agents).set({ status: "disabled" }).where(eq(agents.id, caller.id));
			const disabled = await rpc(caller.key, "agents/list", { skill: "" });
			expect(disabled.status).toBe(403);
			expect(disabled.body.result).toBeUndefined();
		});
	});

	it("rejects unauthenticated POST /a2a", async () => {
		const res = await app.request("/a2a", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBe(401);
	});

	it("full lifecycle: create → accept → message → complete", async () => {
		const bob = await register("bob@acme");
		const frank = await register("frank@acme");

		const create = await rpc(bob.key, "message/send", {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "Refactored /users API." }] },
			payload: { kickoff: { contract_version: 1 } },
			artifacts: [{ type: "api_contract", inline: { version: 1 } }],
		});
		expect(create.status).toBe(200);
		expect(create.body.result.status.state).toBe("pending");
		const taskId = create.body.result.task_id as string;

		// Bob can list as sender
		const sentList = await rpc(bob.key, "tasks/list", { filter: { role: "sender" } });
		expect(sentList.body.result.items.length).toBe(1);

		// Frank's inbox shows it
		const inbox = await rpc(frank.key, "tasks/list", { filter: { role: "recipient" } });
		expect(inbox.body.result.items[0].task_id).toBe(taskId);

		// Frank accepts
		const accept = await rpc(frank.key, "tasks/update", {
			task_id: taskId,
			transition: "accept",
			session_id: "frank-session-1",
		});
		expect(accept.body.result.status.state).toBe("accepted");

		// Re-accept is idempotent
		const reaccept = await rpc(frank.key, "tasks/update", {
			task_id: taskId,
			transition: "accept",
		});
		expect(reaccept.body.result.status.state).toBe("accepted");

		// Bob appends a clarification message
		const msg = await rpc(bob.key, "message/send", {
			task_id: taskId,
			message: { parts: [{ type: "text", text: "Also note: cursor-based pagination." }] },
			payload: { decision: { cursor: "accepted" }, exact: true },
			artifacts: [{ type: "link", url: "https://example.com/contract" }],
		});
		expect(msg.body.result.sequence_no).toBe(2);

		// Frank gets thread
		const got = await rpc(frank.key, "tasks/get", { task_id: taskId });
		expect(got.body.result.history.length).toBe(2);
		expect(got.body.result.history[0].payload).toEqual({
			kickoff: { contract_version: 1 },
		});
		expect(got.body.result.history[0].artifacts).toEqual([
			{ type: "api_contract", inline: { version: 1 } },
		]);
		expect(got.body.result.artifacts).toEqual([{ type: "api_contract", inline: { version: 1 } }]);
		expect(got.body.result.history[1].body).toContain("cursor-based");
		expect(got.body.result.history[1].payload).toEqual({
			decision: { cursor: "accepted" },
			exact: true,
		});
		expect(got.body.result.history[1].artifacts).toEqual([
			{ type: "link", url: "https://example.com/contract" },
		]);

		// Frank completes
		const complete = await rpc(frank.key, "tasks/update", {
			task_id: taskId,
			transition: "complete",
			result_summary: "updated client",
			artifacts: [{ type: "file_ref", path: "src/profile-client.ts", git_sha: "abc123" }],
		});
		expect(complete.body.result.status.state).toBe("completed");
		expect(complete.body.result.completion_artifacts).toEqual([
			{ type: "file_ref", path: "src/profile-client.ts", git_sha: "abc123" },
		]);

		const completedThread = await rpc(bob.key, "tasks/get", { task_id: taskId });
		expect(completedThread.body.result.completion_artifacts).toEqual([
			{ type: "file_ref", path: "src/profile-client.ts", git_sha: "abc123" },
		]);

		const eventRows = await handle.db
			.select({
				kind: mailboxEvents.kind,
				recipientId: mailboxEvents.recipientAgentId,
				actorId: mailboxEvents.actorAgentId,
				threadId: mailboxEvents.threadId,
			})
			.from(mailboxEvents)
			.orderBy(asc(mailboxEvents.cursor));
		expect(eventRows).toEqual([
			{ kind: "thread.created", recipientId: frank.id, actorId: bob.id, threadId: taskId },
			{ kind: "thread.accepted", recipientId: bob.id, actorId: frank.id, threadId: taskId },
			{ kind: "message.appended", recipientId: frank.id, actorId: bob.id, threadId: taskId },
			{ kind: "thread.completed", recipientId: bob.id, actorId: frank.id, threadId: taskId },
		]);

		// Further messages denied
		const after = await rpc(bob.key, "message/send", {
			task_id: taskId,
			message: { parts: [{ type: "text", text: "late" }] },
		});
		expect(after.body.error.data.code).toBe("thread_terminal");
	});

	it("idempotency replay returns same handoff for same payload", async () => {
		const bob = await register("bob@acme");
		await register("frank@acme");
		const params = {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "hello" }] },
			metadata: { client_idempotency_key: "idem-1" },
		};
		const a = await rpc(bob.key, "message/send", params);
		const b = await rpc(bob.key, "message/send", params);
		expect(a.body.result.task_id).toBe(b.body.result.task_id);
	});

	it("serializes concurrent create and append retries", async () => {
		const bob = await register("bob@acme");
		await register("frank@acme");
		const createParams = {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "concurrent create" }] },
			metadata: { client_idempotency_key: "idem-concurrent-create" },
		};
		const [createA, createB] = await Promise.all([
			rpc(bob.key, "message/send", createParams, "create-a"),
			rpc(bob.key, "message/send", createParams, "create-b"),
		]);
		expect(createA.body.error).toBeUndefined();
		expect(createB.body.error).toBeUndefined();
		expect(createA.body.result.task_id).toBe(createB.body.result.task_id);

		const taskId = createA.body.result.task_id as string;
		const appendParams = {
			task_id: taskId,
			message: { parts: [{ type: "text", text: "concurrent append" }] },
			payload: { nested: { value: 1 } },
			metadata: { client_idempotency_key: "idem-concurrent-append" },
		};
		const [appendA, appendB] = await Promise.all([
			rpc(bob.key, "message/send", appendParams, "append-a"),
			rpc(bob.key, "message/send", appendParams, "append-b"),
		]);
		expect(appendA.body.error).toBeUndefined();
		expect(appendB.body.error).toBeUndefined();
		expect(appendA.body.result.message_id).toBe(appendB.body.result.message_id);
		expect(appendA.body.result.sequence_no).toBe(2);

		const thread = await rpc(bob.key, "tasks/get", { task_id: taskId });
		expect(thread.body.result.history).toHaveLength(2);
		const audit = await handle.db.select({ action: auditLog.action }).from(auditLog);
		expect(audit.filter((row) => row.action === "handoff.create")).toHaveLength(1);
		expect(audit.filter((row) => row.action === "message.append")).toHaveLength(1);
		const eventRows = await handle.db.select({ kind: mailboxEvents.kind }).from(mailboxEvents);
		expect(eventRows.filter((row) => row.kind === "thread.created")).toHaveLength(1);
		expect(eventRows.filter((row) => row.kind === "message.appended")).toHaveLength(1);
	});

	it("replays committed requests before later block and terminal gates", async () => {
		const bob = await register("bob@acme");
		const frank = await register("frank@acme");
		const createParams = {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "stable replay" }] },
			metadata: { client_idempotency_key: "idem-stable-create" },
		};
		const created = await rpc(bob.key, "message/send", createParams);
		const taskId = created.body.result.task_id as string;
		const appendParams = {
			task_id: taskId,
			message: { parts: [{ type: "text", text: "stable append" }] },
			metadata: { client_idempotency_key: "idem-stable-append" },
		};
		const appended = await rpc(bob.key, "message/send", appendParams);

		await app.request("/agents/me/block", {
			method: "POST",
			headers: bearer(frank.key),
			body: JSON.stringify({ handle: "bob@acme" }),
		});
		const createWhileBlocked = await rpc(bob.key, "message/send", createParams);
		const appendWhileBlocked = await rpc(bob.key, "message/send", appendParams);
		expect(createWhileBlocked.body.result.task_id).toBe(taskId);
		expect(appendWhileBlocked.body.result.message_id).toBe(appended.body.result.message_id);

		await app.request("/agents/me/block/bob@acme", {
			method: "DELETE",
			headers: bearer(frank.key),
		});
		await rpc(frank.key, "tasks/update", { task_id: taskId, transition: "accept" });
		await rpc(frank.key, "tasks/update", {
			task_id: taskId,
			transition: "complete",
			result_summary: "done",
		});
		const createAfterTerminal = await rpc(bob.key, "message/send", createParams);
		const appendAfterTerminal = await rpc(bob.key, "message/send", appendParams);
		expect(createAfterTerminal.body.result.task_id).toBe(taskId);
		expect(appendAfterTerminal.body.result.message_id).toBe(appended.body.result.message_id);
	});

	it("idempotency: same key + different payload returns -32011", async () => {
		const bob = await register("bob@acme");
		await register("frank@acme");
		await rpc(bob.key, "message/send", {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "one" }] },
			metadata: { client_idempotency_key: "idem-x" },
		});
		const second = await rpc(bob.key, "message/send", {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "TWO" }] },
			metadata: { client_idempotency_key: "idem-x" },
		});
		expect(second.body.error.data.code).toBe("duplicate_idempotency_key");
		expect(second.body.error.code).toBe(-32011);
	});

	it("idempotency compares nested handoff artifacts and append payloads", async () => {
		const bob = await register("bob@acme");
		const frank = await register("frank@acme");
		const base = {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "same body" }] },
			artifacts: [{ type: "file_ref", path: "src/a.ts", git_sha: "one" }],
			payload: { kickoff: { version: 1 } },
			metadata: { client_idempotency_key: "idem-nested" },
		};
		const created = await rpc(bob.key, "message/send", base);
		const changedArtifact = await rpc(bob.key, "message/send", {
			...base,
			artifacts: [{ type: "file_ref", path: "src/a.ts", git_sha: "two" }],
		});
		expect(changedArtifact.body.error.data.code).toBe("duplicate_idempotency_key");
		const changedInitialPayload = await rpc(bob.key, "message/send", {
			...base,
			payload: { kickoff: { version: 2 } },
		});
		expect(changedInitialPayload.body.error.data.code).toBe("duplicate_idempotency_key");

		const taskId = created.body.result.task_id as string;
		const append = {
			task_id: taskId,
			message: { parts: [{ type: "text", text: "same append" }] },
			payload: { nested: { version: 1 } },
			metadata: { client_idempotency_key: "idem-append" },
		};
		await rpc(bob.key, "message/send", append);
		const changedPayload = await rpc(bob.key, "message/send", {
			...append,
			payload: { nested: { version: 2 } },
		});
		expect(changedPayload.body.error.data.code).toBe("duplicate_idempotency_key");
		const otherActor = await rpc(frank.key, "message/send", append);
		expect(otherActor.body.error.data.code).toBe("duplicate_idempotency_key");
	});

	it("recovers legacy append payloads from metadata without the idempotency key", async () => {
		const bob = await register("bob@acme");
		await register("frank@acme");
		const created = await rpc(bob.key, "message/send", {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "legacy client" }] },
		});
		const taskId = created.body.result.task_id as string;
		await rpc(bob.key, "message/send", {
			task_id: taskId,
			message: { parts: [{ type: "text", text: "legacy payload" }] },
			metadata: {
				decision: { approved: true },
				client_idempotency_key: "legacy-client-key",
			},
		});
		const thread = await rpc(bob.key, "tasks/get", { task_id: taskId });
		expect(thread.body.result.history[1].payload).toEqual({
			decision: { approved: true },
		});
	});

	it("requires a typed artifact envelope while preserving custom A2A artifact types", async () => {
		const bob = await register("bob@acme");
		const frank = await register("frank@acme");
		const missingType = await rpc(bob.key, "message/send", {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "invalid artifact" }] },
			artifacts: [{ command: "do-not-run" }],
		});
		expect(missingType.body.error.data.code).toBe("invalid_params");

		const customType = await rpc(bob.key, "message/send", {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "custom artifact" }] },
			artifacts: [{ type: "android_resource", module: "app", resource: "profile" }],
		});
		expect(customType.body.error).toBeUndefined();
		const customThread = await rpc(bob.key, "tasks/get", {
			task_id: customType.body.result.task_id,
		});
		expect(customThread.body.result.artifacts).toEqual([
			{ type: "android_resource", module: "app", resource: "profile" },
		]);

		const created = await rpc(bob.key, "message/send", {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "valid thread" }] },
		});
		const taskId = created.body.result.task_id as string;
		await rpc(frank.key, "tasks/update", { task_id: taskId, transition: "accept" });
		const invalidCompletion = await rpc(frank.key, "tasks/update", {
			task_id: taskId,
			transition: "complete",
			result_summary: "invalid",
			artifacts: [{ value: "missing type" }],
		});
		expect(invalidCompletion.body.error.data.code).toBe("invalid_params");
		const thread = await rpc(bob.key, "tasks/get", { task_id: taskId });
		expect(thread.body.result.status.state).toBe("accepted");
	});

	it("sender cannot accept own thread (-32009)", async () => {
		const bob = await register("bob@acme");
		await register("frank@acme");
		const create = await rpc(bob.key, "message/send", {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "hi" }] },
		});
		const taskId = create.body.result.task_id;
		const accept = await rpc(bob.key, "tasks/update", {
			task_id: taskId,
			transition: "accept",
		});
		expect(accept.body.error.data.code).toBe("not_authorized_transition");
	});

	it("sender can cancel a pending thread; recipient cannot", async () => {
		const bob = await register("bob@acme");
		const frank = await register("frank@acme");
		const create = await rpc(bob.key, "message/send", {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "hi" }] },
		});
		const taskId = create.body.result.task_id;

		// recipient tries to cancel
		const denied = await rpc(frank.key, "tasks/cancel", { task_id: taskId });
		expect(denied.body.error.data.code).toBe("not_authorized_transition");

		// sender cancels
		const ok = await rpc(bob.key, "tasks/cancel", { task_id: taskId });
		expect(ok.body.result.status.state).toBe("cancelled");

		// cannot cancel twice
		const again = await rpc(bob.key, "tasks/cancel", { task_id: taskId });
		expect(again.body.error.data.code).toBe("invalid_transition");
		const cancelledEvents = await handle.db
			.select({ recipientId: mailboxEvents.recipientAgentId })
			.from(mailboxEvents)
			.where(eq(mailboxEvents.kind, "thread.cancelled"));
		expect(cancelledEvents).toEqual([{ recipientId: frank.id }]);
	});

	it("cannot complete a pending (not yet accepted) thread", async () => {
		const bob = await register("bob@acme");
		const frank = await register("frank@acme");
		const create = await rpc(bob.key, "message/send", {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "hi" }] },
		});
		const taskId = create.body.result.task_id;
		const tooEarly = await rpc(frank.key, "tasks/update", {
			task_id: taskId,
			transition: "complete",
		});
		expect(tooEarly.body.error.data.code).toBe("invalid_transition");
	});

	it("rejects completion artifacts on transitions that cannot persist them", async () => {
		const bob = await register("bob@acme");
		const frank = await register("frank@acme");
		const created = await rpc(bob.key, "message/send", {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "hi" }] },
		});
		const rejected = await rpc(frank.key, "tasks/update", {
			task_id: created.body.result.task_id,
			transition: "accept",
			artifacts: [{ type: "file_ref", path: "would-be-dropped.ts" }],
		});
		expect(rejected.body.error.data.code).toBe("invalid_params");
	});

	it("non-participant cannot read/append", async () => {
		const bob = await register("bob@acme");
		await register("frank@acme");
		const eve = await register("eve@acme");
		const create = await rpc(bob.key, "message/send", {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "private" }] },
		});
		const taskId = create.body.result.task_id;
		const peek = await rpc(eve.key, "tasks/get", { task_id: taskId });
		expect(peek.body.error.data.code).toBe("not_a_participant");
		expect(peek.body).not.toHaveProperty("result");
		expect(JSON.stringify(peek.body)).not.toContain("private");
		const denied = await rpc(eve.key, "message/send", {
			task_id: taskId,
			message: { parts: [{ type: "text", text: "unauthorized append" }] },
		});
		expect(denied.body.error.data.code).toBe("not_a_participant");
		expect(denied.body).not.toHaveProperty("result");
		expect(JSON.stringify(denied.body)).not.toContain("private");
		const unchanged = await rpc(bob.key, "tasks/get", { task_id: taskId });
		expect(unchanged.body.result.history).toHaveLength(1);
		const audit = await handle.db.select({ action: auditLog.action }).from(auditLog);
		expect(audit.filter((row) => row.action === "message.append")).toHaveLength(0);
	});

	it.each(["completed", "cancelled"] as const)(
		"rejects new mutations in a %s thread while preserving transition ownership",
		async (terminalState) => {
			const bob = await register("bob@acme");
			const frank = await register("frank@acme");
			const created = await rpc(bob.key, "message/send", {
				recipient: "frank@acme",
				intent: "inform",
				message: { parts: [{ type: "text", text: "terminal fixture" }] },
			});
			const taskId = created.body.result.task_id;
			if (terminalState === "completed") {
				await rpc(frank.key, "tasks/update", { task_id: taskId, transition: "accept" });
				const wrongOwner = await rpc(bob.key, "tasks/update", {
					task_id: taskId,
					transition: "complete",
				});
				expect(wrongOwner.body.error.data.code).toBe("not_authorized_transition");
				const tooLate = await rpc(bob.key, "tasks/cancel", { task_id: taskId });
				expect(tooLate.body.error.data.code).toBe("invalid_transition");
				await rpc(frank.key, "tasks/update", { task_id: taskId, transition: "complete" });
			} else {
				await rpc(bob.key, "tasks/cancel", { task_id: taskId });
			}
			const before = await rpc(bob.key, "tasks/get", { task_id: taskId });
			expect(before.body.result.status.state).toBe(terminalState);
			const auditBefore = await handle.db.select().from(auditLog).orderBy(asc(auditLog.id));
			const eventsBefore = await handle.db
				.select()
				.from(mailboxEvents)
				.orderBy(asc(mailboxEvents.cursor));
			for (const participant of [bob, frank]) {
				const append = await rpc(participant.key, "message/send", {
					task_id: taskId,
					message: { parts: [{ type: "text", text: "must not commit" }] },
				});
				expect(append.body.error.data.code).toBe("thread_terminal");
				for (const transition of ["accept", "complete", "cancel"] as const) {
					const denied = await rpc(
						participant.key,
						transition === "cancel" ? "tasks/cancel" : "tasks/update",
						{ task_id: taskId, ...(transition === "cancel" ? {} : { transition }) },
					);
					const ownsTransition =
						transition === "cancel" ? participant === bob : participant === frank;
					expect(denied.body.error.data.code).toBe(
						ownsTransition ? "invalid_transition" : "not_authorized_transition",
					);
				}
			}
			expect((await rpc(bob.key, "tasks/get", { task_id: taskId })).body.result).toEqual(
				before.body.result,
			);
			expect(await handle.db.select().from(auditLog).orderBy(asc(auditLog.id))).toEqual(
				auditBefore,
			);
			expect(
				await handle.db.select().from(mailboxEvents).orderBy(asc(mailboxEvents.cursor)),
			).toEqual(eventsBefore);
		},
	);

	it("retrieves committed content while durable notification jobs remain unprocessed", async () => {
		const config = loadConfig({ ...TEST_ENV } as NodeJS.ProcessEnv);
		app = createServer({
			config,
			logger: createLogger(config),
			db: handle.db,
		});
		const bob = await register("bob@acme");
		const frank = await register("frank@acme");
		const created = await rpc(bob.key, "message/send", {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "stored without notification" }] },
		});
		const taskId = created.body.result.task_id;
		const appended = await rpc(bob.key, "message/send", {
			task_id: taskId,
			message: { parts: [{ type: "text", text: "follow-up without notification" }] },
		});
		expect(appended.body.result.sequence_no).toBe(2);
		const jobs = await handle.db
			.select()
			.from(notificationOutbox)
			.orderBy(asc(notificationOutbox.createdAt));
		expect(jobs).toHaveLength(2);
		expect(
			jobs.map((job) => ({ kind: job.kind, threadId: job.threadId, status: job.status })),
		).toEqual([
			{ kind: "notify.handoff.created", threadId: taskId, status: "pending" },
			{ kind: "notify.message.appended", threadId: taskId, status: "pending" },
		]);
		app = createServer({ config, logger: createLogger(config), db: handle.db });
		const inbox = await rpc(frank.key, "tasks/list", {});
		expect(inbox.body.result.items.map((item: { thread_id: string }) => item.thread_id)).toContain(
			taskId,
		);
		const stored = await rpc(frank.key, "tasks/get", { task_id: taskId });
		expect(stored.body.result.messages.map((message: { body: string }) => message.body)).toEqual([
			"stored without notification",
			"follow-up without notification",
		]);
		const events = await handle.db
			.select({ kind: mailboxEvents.kind })
			.from(mailboxEvents)
			.orderBy(asc(mailboxEvents.cursor));
		expect(events.map((event) => event.kind)).toEqual(["thread.created", "message.appended"]);
	});

	it("intent=propose_action requires proposed_action; mismatch → -32012", async () => {
		const bob = await register("bob@acme");
		await register("frank@acme");

		const noPa = await rpc(bob.key, "message/send", {
			recipient: "frank@acme",
			intent: "propose_action",
			message: { parts: [{ type: "text", text: "please update" }] },
		});
		expect(noPa.body.error.data.code).toBe("invalid_intent_payload");
		expect(noPa.body.error.code).toBe(-32012);

		const inverted = await rpc(bob.key, "message/send", {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "msg" }] },
			proposed_action: { description: "x", target_files: [], rationale: "y" },
		});
		expect(inverted.body.error.data.code).toBe("invalid_intent_payload");

		const ok = await rpc(bob.key, "message/send", {
			recipient: "frank@acme",
			intent: "propose_action",
			message: { parts: [{ type: "text", text: "please do it" }] },
			proposed_action: {
				description: "rename",
				target_files: ["src/x.ts"],
				rationale: "because",
			},
		});
		expect(ok.body.result.status.state).toBe("pending");
	});

	it("blocked sender → -32013", async () => {
		const bob = await register("bob@acme");
		const frank = await register("frank@acme");
		await handle.db.insert(agentBlocks).values({ blockerId: frank.id, blockedId: bob.id });
		const res = await rpc(bob.key, "message/send", {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "hi" }] },
		});
		expect(res.body.error.data.code).toBe("teammate_blocked");
		expect(res.body.error.code).toBe(-32013);
	});

	it("makes a successful block response a commit fence for queued content", async () => {
		const bob = await register("bob@acme");
		const frank = await register("frank@acme");
		let releaseGate = () => undefined;
		let signalReady = () => undefined;
		let signalProbe = () => undefined;
		let signalWaiter = () => undefined;
		const ready = new Promise<void>((resolve) => {
			signalReady = resolve;
		});
		const probe = new Promise<void>((resolve) => {
			signalProbe = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const waiterObserved = new Promise<void>((resolve) => {
			signalWaiter = resolve;
		});

		const gate = handle.db.transaction(async (tx) => {
			await lockAgentBlockPair(tx, frank.id, bob.id);
			signalReady();
			await probe;

			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				const waiting = await tx.execute(sql`
					SELECT count(*)::integer AS count
					FROM pg_stat_activity
					WHERE datname = current_database()
					  AND wait_event_type = 'Lock'
					  AND wait_event = 'advisory'
				`);
				if (Number(waiting[0]?.count ?? 0) > 0) {
					signalWaiter();
					await release;
					return;
				}
				await new Promise<void>((resolve) => setTimeout(resolve, 10));
			}
			throw new Error("block request did not reach the directed-pair lock");
		});

		await ready;
		const blockRequest = app.request("/agents/me/block", {
			method: "POST",
			headers: bearer(frank.key),
			body: JSON.stringify({ handle: "bob@acme" }),
		});
		signalProbe();

		try {
			// The gate observes the block transaction waiting before this send is
			// queued, so releasing it deterministically gives the block first turn.
			await Promise.race([waiterObserved, gate]);
			const sendRequest = rpc(bob.key, "message/send", {
				recipient: "frank@acme",
				intent: "inform",
				message: { parts: [{ type: "text", text: "must not cross the fence" }] },
			});

			releaseGate();
			const [blocked, denied] = await Promise.all([blockRequest, sendRequest]);
			expect(blocked.status).toBe(201);
			expect(denied.body.error.data.code).toBe("teammate_blocked");
			expect(await handle.db.select().from(handoffs)).toHaveLength(0);
		} finally {
			releaseGate();
			await gate;
		}
	}, 10_000);

	it("blocking a participant stops new messages on an existing thread", async () => {
		const bob = await register("bob@acme");
		const frank = await register("frank@acme");
		const created = await rpc(bob.key, "message/send", {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "initial" }] },
		});
		const taskId = created.body.result.task_id as string;

		const blockBob = await app.request("/agents/me/block", {
			method: "POST",
			headers: bearer(frank.key),
			body: JSON.stringify({ handle: "bob@acme" }),
		});
		expect(blockBob.status).toBe(201);
		const blockedAccept = await rpc(frank.key, "tasks/update", {
			task_id: taskId,
			transition: "accept",
		});
		expect(blockedAccept.body.error.data.code).toBe("teammate_blocked");
		const denied = await rpc(bob.key, "message/send", {
			task_id: taskId,
			message: { parts: [{ type: "text", text: "blocked follow-up" }] },
		});
		expect(denied.body.error.data.code).toBe("teammate_blocked");
		const unchanged = await rpc(frank.key, "tasks/get", { task_id: taskId });
		expect(unchanged.body.result.history).toHaveLength(1);
		const auditAfterDenied = await handle.db.select({ action: auditLog.action }).from(auditLog);
		expect(auditAfterDenied.filter((row) => row.action === "message.append")).toHaveLength(0);

		const unblockBob = await app.request("/agents/me/block/bob@acme", {
			method: "DELETE",
			headers: bearer(frank.key),
		});
		expect(unblockBob.status).toBe(204);
		const restored = await rpc(bob.key, "message/send", {
			task_id: taskId,
			message: { parts: [{ type: "text", text: "allowed follow-up" }] },
		});
		expect(restored.body.result.sequence_no).toBe(2);
		const accepted = await rpc(frank.key, "tasks/update", {
			task_id: taskId,
			transition: "accept",
		});
		expect(accepted.body.result.status.state).toBe("accepted");

		const blockFrank = await app.request("/agents/me/block", {
			method: "POST",
			headers: bearer(bob.key),
			body: JSON.stringify({ handle: "frank@acme" }),
		});
		expect(blockFrank.status).toBe(201);
		const reverseDenied = await rpc(frank.key, "message/send", {
			task_id: taskId,
			message: { parts: [{ type: "text", text: "blocked reverse" }] },
		});
		expect(reverseDenied.body.error.data.code).toBe("teammate_blocked");
		const completionDenied = await rpc(frank.key, "tasks/update", {
			task_id: taskId,
			transition: "complete",
			result_summary: "blocked result",
			artifacts: [{ type: "file_ref", path: "blocked-result.ts" }],
		});
		expect(completionDenied.body.error.data.code).toBe("teammate_blocked");
		const stillUnchanged = await rpc(bob.key, "tasks/get", { task_id: taskId });
		expect(stillUnchanged.body.result.history).toHaveLength(2);
		expect(stillUnchanged.body.result.status.state).toBe("accepted");
		expect(stillUnchanged.body.result.completion_artifacts).toEqual([]);
		const auditAfterReverseDenied = await handle.db
			.select({ action: auditLog.action })
			.from(auditLog);
		expect(auditAfterReverseDenied.filter((row) => row.action === "message.append")).toHaveLength(
			1,
		);

		const unblockFrank = await app.request("/agents/me/block/frank@acme", {
			method: "DELETE",
			headers: bearer(bob.key),
		});
		expect(unblockFrank.status).toBe(204);
		const reverseRestored = await rpc(frank.key, "message/send", {
			task_id: taskId,
			message: { parts: [{ type: "text", text: "allowed reverse" }] },
		});
		expect(reverseRestored.body.result.sequence_no).toBe(3);
		const completionRestored = await rpc(frank.key, "tasks/update", {
			task_id: taskId,
			transition: "complete",
			result_summary: "allowed result",
			artifacts: [{ type: "file_ref", path: "allowed-result.ts" }],
		});
		expect(completionRestored.body.result.status.state).toBe("completed");
	});

	it("recipient_not_found for unknown handle (-32004)", async () => {
		const bob = await register("bob@acme");
		const res = await rpc(bob.key, "message/send", {
			recipient: "ghost@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "hi" }] },
		});
		expect(res.body.error.data.code).toBe("recipient_not_found");
		expect(res.body.error.code).toBe(-32004);
	});

	it("disabled agent cannot use API key (-32001)", async () => {
		const bob = await register("bob@acme");
		// disable bob via direct update
		await handle.db.update(agents).set({ status: "disabled" }).where(eq(agents.id, bob.id));
		const res = await app.request("/a2a", {
			method: "POST",
			headers: bearer(bob.key),
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/list", params: {} }),
		});
		// Either forbidden (agent disabled) or unauthenticated (key revoked) — both 401/403 acceptable.
		expect([401, 403]).toContain(res.status);
	});

	it("audit log captures every state mutation", async () => {
		const bob = await register("bob@acme");
		const frank = await register("frank@acme");
		const created = await rpc(bob.key, "message/send", {
			recipient: "frank@acme",
			intent: "inform",
			message: { parts: [{ type: "text", text: "hi" }] },
		});
		const taskId = created.body.result.task_id;
		await rpc(frank.key, "tasks/update", { task_id: taskId, transition: "accept" });
		await rpc(bob.key, "message/send", {
			task_id: taskId,
			message: { parts: [{ type: "text", text: "follow-up" }] },
		});
		await rpc(frank.key, "tasks/update", { task_id: taskId, transition: "complete" });

		const rows = await handle.sql`
      SELECT action FROM audit_log ORDER BY id ASC
    `;
		const actions = rows.map((r: { action: string }) => r.action);
		expect(actions).toContain("handoff.create");
		expect(actions).toContain("handoff.accept");
		expect(actions).toContain("message.append");
		expect(actions).toContain("handoff.complete");
	});

	it("method_not_found for unknown JSON-RPC method", async () => {
		const bob = await register("bob@acme");
		const res = await rpc(bob.key, "tasks/explode", {});
		expect(res.body.error.code).toBe(-32601);
		expect(res.body.error.data.code).toBe("method_not_found");
	});

	it("parse_error on malformed JSON", async () => {
		const bob = await register("bob@acme");
		const res = await app.request("/a2a", {
			method: "POST",
			headers: bearer(bob.key),
			body: "{not json",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { data: { code: string } } };
		expect(body.error.data.code).toBe("parse_error");
	});
});
