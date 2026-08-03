import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearLastUsedDebounce } from "../auth/middleware.js";
import { loadConfig } from "../config.js";
import type { Database } from "../db/client.js";
import {
	agents,
	apiKeys,
	auditLog,
	deliveryOperationReceipts,
	missionEvents,
	missionParticipants,
	missions,
	nodeCredentials,
	nodeDeliveries,
	nodes,
	workspaceBindings,
} from "../db/schema.js";
import { type TestDb, truncateAll, tryConnect } from "../db/test-utils.js";
import { createLogger } from "../logger.js";
import { createServer } from "../server.js";

const conn = await tryConnect();
const d = conn.available ? describe : describe.skip;
const TEST_DATABASE_URL = process.env.RELAY_TEST_DATABASE_URL ?? process.env.RELAY_DATABASE_URL;

if (!conn.available) {
	console.warn(`[admin.test] skipping: ${conn.reason}`);
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

interface TestNodeEnrollment {
	readonly nodeId: string;
	readonly credentialId: string;
	readonly credentialToken: string;
}

interface TestWorkspaceRegistration {
	readonly workspaceBindingId: string;
}

d("admin + auth integration", () => {
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

	function adminHeaders(token = TEST_ENV.RELAY_ADMIN_TOKEN): HeadersInit {
		return { authorization: `Bearer ${token}`, "content-type": "application/json" };
	}

	function bearer(token: string): HeadersInit {
		return { authorization: `Bearer ${token}`, "content-type": "application/json" };
	}

	async function createAgent(handleStr = "frank@acme"): Promise<{ id: string; key: string }> {
		const res = await app.request("/admin/agents", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({
				handle: handleStr,
				email: `${handleStr.split("@")[0]}@acme.com`,
				display_name: "Frank",
				role: "frontend",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { agent_id: string; api_key: string };
		return { id: body.agent_id, key: body.api_key };
	}

	async function enrollAgentNode(
		agentKey: string,
		name: string,
		requestApp = app,
	): Promise<TestNodeEnrollment> {
		const response = await requestApp.request("/agents/me/nodes", {
			method: "POST",
			headers: bearer(agentKey),
			body: JSON.stringify({ name, capabilities: ["runtime.fake"] }),
		});
		expect(response.status).toBe(201);
		const body = (await response.json()) as {
			node: { node_id: string };
			credential: { id: string; token: string };
		};
		return {
			nodeId: body.node.node_id,
			credentialId: body.credential.id,
			credentialToken: body.credential.token,
		};
	}

	async function registerNodeWorkspace(
		nodeToken: string,
		alias: string,
	): Promise<TestWorkspaceRegistration> {
		const response = await app.request("/node/v1/workspaces", {
			method: "POST",
			headers: bearer(nodeToken),
			body: JSON.stringify({
				alias,
				repository_url: `https://github.com/acme/${alias}.git`,
				allowed_base_refs: ["refs/heads/main"],
			}),
		});
		expect(response.status).toBe(201);
		const body = (await response.json()) as {
			workspace: { workspace_binding_id: string };
		};
		return { workspaceBindingId: body.workspace.workspace_binding_id };
	}

	it("rejects /admin/* without admin bearer", async () => {
		const res = await app.request("/admin/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("unauthenticated");
	});

	it("rejects /admin/* with wrong admin bearer", async () => {
		const res = await app.request("/admin/agents", {
			method: "POST",
			headers: adminHeaders("wrong-token-but-same-len"),
			body: "{}",
		});
		expect([401, 403]).toContain(res.status);
	});

	it("POST /admin/agents creates agent + returns one-time key", async () => {
		const { id, key } = await createAgent();
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
		expect(key).toMatch(/^ah_test_[a-z2-7]{32}$/);
	});

	it("rejects duplicate handle on POST /admin/agents", async () => {
		await createAgent("dup@acme");
		const res = await app.request("/admin/agents", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({
				handle: "dup@acme",
				email: "dup2@acme.com",
				display_name: "Dup",
				role: "r",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("invalid_params");
	});

	it("GET /agents lists active agents (auth required)", async () => {
		await createAgent("frank@acme");
		const { key } = await createAgent("bob@acme");

		const noAuth = await app.request("/agents");
		expect(noAuth.status).toBe(401);

		const ok = await app.request("/agents", { headers: bearer(key) });
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as { teammates: Array<{ handle: string }> };
		const handles = body.teammates.map((t) => t.handle).sort();
		expect(handles).toEqual(["bob@acme", "frank@acme"]);
	});

	it("PUT /agents/me/card upserts skills/repos", async () => {
		const { key } = await createAgent("frank@acme");
		const res = await app.request("/agents/me/card", {
			method: "PUT",
			headers: bearer(key),
			body: JSON.stringify({
				skills: ["react", "tailwind"],
				repos_owned: ["apps/web/"],
			}),
		});
		expect(res.status).toBe(200);

		const list = await app.request("/agents", { headers: bearer(key) });
		const body = (await list.json()) as {
			teammates: Array<{ handle: string; skills: string[]; repos_owned: string[] }>;
		};
		const me = body.teammates.find((t) => t.handle === "frank@acme");
		expect(me?.skills).toEqual(["react", "tailwind"]);
		expect(me?.repos_owned).toEqual(["apps/web/"]);
	});

	it("rotate-key revokes old key and issues new one", async () => {
		const { id, key: oldKey } = await createAgent("frank@acme");

		const rotateRes = await app.request(`/admin/agents/${id}/keys/rotate`, {
			method: "POST",
			headers: adminHeaders(),
		});
		expect(rotateRes.status).toBe(200);
		const rotated = (await rotateRes.json()) as { api_key: string };
		expect(rotated.api_key).not.toBe(oldKey);

		// old key denied
		const denied = await app.request("/agents", { headers: bearer(oldKey) });
		expect(denied.status).toBe(401);

		// new key works
		const ok = await app.request("/agents", { headers: bearer(rotated.api_key) });
		expect(ok.status).toBe(200);
	});

	it("rejects an older key rotation attempt after agent disablement commits", async () => {
		const owner = await createAgent("rotation-race@acme");
		const transactionEntered = deferred<void>();
		const releaseTransaction = deferred<void>();
		const delayedDb = delayFirstTransaction(handle.db, transactionEntered, releaseTransaction);
		const config = loadConfig({ ...TEST_ENV } as NodeJS.ProcessEnv);
		const delayedApp = createServer({ config, logger: createLogger(config), db: delayedDb });
		let rotationRequest: Promise<Response> | undefined;

		try {
			rotationRequest = delayedApp.request(`/admin/agents/${owner.id}/keys/rotate`, {
				method: "POST",
				headers: adminHeaders(),
			});
			await transactionEntered.promise;

			const disableResponse = await app.request(`/admin/agents/${owner.id}`, {
				method: "DELETE",
				headers: adminHeaders(),
			});
			expect(disableResponse.status).toBe(204);
			releaseTransaction.resolve();

			const rotationResponse = await rotationRequest;
			expect(rotationResponse.status).toBe(409);
			expect(await rotationResponse.json()).toMatchObject({ code: "invalid_transition" });
			const storedKeys = await handle.db
				.select({ revokedAt: apiKeys.revokedAt })
				.from(apiKeys)
				.where(eq(apiKeys.agentId, owner.id));
			expect(storedKeys.length).toBeGreaterThan(0);
			expect(storedKeys.every((key) => key.revokedAt !== null)).toBe(true);
		} finally {
			releaseTransaction.resolve();
			await rotationRequest?.catch(() => undefined);
		}
	});

	it("rejects an authenticated self-rotation after agent disablement commits", async () => {
		const owner = await createAgent("self-rotation-race@acme");
		const transactionEntered = deferred<void>();
		const releaseTransaction = deferred<void>();
		const delayedDb = delayFirstTransaction(handle.db, transactionEntered, releaseTransaction);
		const config = loadConfig({ ...TEST_ENV } as NodeJS.ProcessEnv);
		const delayedApp = createServer({ config, logger: createLogger(config), db: delayedDb });
		let rotationRequest: Promise<Response> | undefined;

		try {
			rotationRequest = delayedApp.request("/agents/me/keys/rotate", {
				method: "POST",
				headers: bearer(owner.key),
			});
			await transactionEntered.promise;

			const disableResponse = await app.request(`/admin/agents/${owner.id}`, {
				method: "DELETE",
				headers: adminHeaders(),
			});
			expect(disableResponse.status).toBe(204);
			releaseTransaction.resolve();

			const rotationResponse = await rotationRequest;
			expect(rotationResponse.status).toBe(401);
			expect(await rotationResponse.json()).toMatchObject({ code: "unauthenticated" });
			const storedKeys = await handle.db
				.select({ revokedAt: apiKeys.revokedAt })
				.from(apiKeys)
				.where(eq(apiKeys.agentId, owner.id));
			expect(storedKeys.length).toBeGreaterThan(0);
			expect(storedKeys.every((key) => key.revokedAt !== null)).toBe(true);
		} finally {
			releaseTransaction.resolve();
			await rotationRequest?.catch(() => undefined);
		}
	});

	it("DELETE /admin/agents/:id disables the owner and revokes its full Node boundary", async () => {
		const { id, key } = await createAgent("frank@acme");
		const enrollmentResponse = await app.request("/agents/me/nodes", {
			method: "POST",
			headers: bearer(key),
			body: JSON.stringify({ name: "frank-mac", capabilities: ["runtime.fake"] }),
		});
		expect(enrollmentResponse.status).toBe(201);
		const enrollment = (await enrollmentResponse.json()) as {
			node: { node_id: string };
			credential: { id: string; token: string };
		};
		const workspaceResponse = await app.request("/node/v1/workspaces", {
			method: "POST",
			headers: bearer(enrollment.credential.token),
			body: JSON.stringify({
				alias: "frontend",
				repository_url: "https://github.com/acme/frontend.git",
				allowed_base_refs: ["refs/heads/main"],
			}),
		});
		expect(workspaceResponse.status).toBe(201);

		const res = await app.request(`/admin/agents/${id}`, {
			method: "DELETE",
			headers: adminHeaders(),
		});
		expect(res.status).toBe(204);

		// key now invalid (revoked) and agent disabled
		const denied = await app.request("/agents", { headers: bearer(key) });
		expect(denied.status).toBe(401);
		const nodeDenied = await app.request("/node/v1/me", {
			headers: bearer(enrollment.credential.token),
		});
		expect(nodeDenied.status).toBe(401);

		const [agent] = await handle.db.select().from(agents).where(eq(agents.id, id));
		expect(agent?.status).toBe("disabled");
		const keys = await handle.db
			.select({ revokedAt: apiKeys.revokedAt })
			.from(apiKeys)
			.where(eq(apiKeys.agentId, id));
		expect(keys.length).toBeGreaterThan(0);
		expect(keys.every((candidate) => candidate.revokedAt !== null)).toBe(true);
		const [node] = await handle.db
			.select()
			.from(nodes)
			.where(eq(nodes.id, enrollment.node.node_id));
		expect(node).toMatchObject({ status: "revoked", revokedAt: expect.any(Date) });
		const [credential] = await handle.db
			.select()
			.from(nodeCredentials)
			.where(eq(nodeCredentials.id, enrollment.credential.id));
		expect(credential?.revokedAt).toEqual(expect.any(Date));
		const [workspace] = await handle.db
			.select()
			.from(workspaceBindings)
			.where(eq(workspaceBindings.nodeId, enrollment.node.node_id));
		expect(workspace).toMatchObject({ status: "revoked", revokedAt: expect.any(Date) });
	});

	it("does not return until affected Mission deliveries across peer Nodes are cancelled", async () => {
		const owner = await createAgent("mission-owner@acme");
		const peer = await createAgent("mission-peer@acme");
		const ownerNode = await enrollAgentNode(owner.key, "owner-node");
		const peerNode = await enrollAgentNode(peer.key, "peer-node");
		const ownerWorkspace = await registerNodeWorkspace(
			ownerNode.credentialToken,
			"owner-workspace",
		);
		const peerWorkspace = await registerNodeWorkspace(peerNode.credentialToken, "peer-workspace");
		const affected = await seedMission(handle, {
			createdByAgentId: owner.id,
			participants: [
				{
					agentId: owner.id,
					nodeId: ownerNode.nodeId,
					workspaceBindingId: ownerWorkspace.workspaceBindingId,
				},
				{
					agentId: peer.id,
					nodeId: peerNode.nodeId,
					workspaceBindingId: peerWorkspace.workspaceBindingId,
				},
			],
			deliveryNodeIds: [ownerNode.nodeId, peerNode.nodeId],
		});
		const peerLeaseId = randomUUID();
		const peerLeaseExpiresAt = new Date(Date.now() + 60_000);
		await handle.db
			.update(nodeDeliveries)
			.set({
				status: "executing",
				attemptCount: 1,
				lastFencingToken: "1",
				activeLeaseId: peerLeaseId,
				leaseExpiresAt: peerLeaseExpiresAt,
			})
			.where(eq(nodeDeliveries.id, affected.deliveryIds[1]!));
		const unrelated = await seedMission(handle, {
			createdByAgentId: peer.id,
			participants: [
				{
					agentId: peer.id,
					nodeId: peerNode.nodeId,
					workspaceBindingId: peerWorkspace.workspaceBindingId,
				},
			],
			deliveryNodeIds: [peerNode.nodeId],
		});

		const response = await app.request(`/admin/agents/${owner.id}`, {
			method: "DELETE",
			headers: adminHeaders(),
		});
		expect(response.status).toBe(204);

		const affectedDeliveries = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(inArray(nodeDeliveries.id, affected.deliveryIds));
		expect(affectedDeliveries).toHaveLength(2);
		expect(affectedDeliveries.every((delivery) => delivery.status === "cancelled")).toBe(true);
		expect(affectedDeliveries.every((delivery) => delivery.activeLeaseId === null)).toBe(true);
		const peerReceipt = await handle.db
			.select()
			.from(deliveryOperationReceipts)
			.where(eq(deliveryOperationReceipts.deliveryId, affected.deliveryIds[1]!));
		expect(peerReceipt).toHaveLength(1);
		expect(peerReceipt[0]).toMatchObject({
			nodeId: peerNode.nodeId,
			leaseId: peerLeaseId,
			fencingToken: "1",
			statusBefore: "executing",
			statusAfter: "cancelled",
		});
		expect(peerReceipt[0]?.leaseExpiresAt?.toISOString()).toBe(peerLeaseExpiresAt.toISOString());

		const [unrelatedDelivery] = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.id, unrelated.deliveryIds[0]!));
		expect(unrelatedDelivery).toMatchObject({ status: "stored", cancellationReason: null });
		const [storedOwner] = await handle.db
			.select({ status: agents.status })
			.from(agents)
			.where(eq(agents.id, owner.id));
		const [storedPeer] = await handle.db
			.select({ status: agents.status })
			.from(agents)
			.where(eq(agents.id, peer.id));
		expect(storedOwner?.status).toBe("disabled");
		expect(storedPeer?.status).toBe("active");

		const auditRows = await handle.db
			.select({
				actorKind: auditLog.actorKind,
				actorId: auditLog.actorId,
				action: auditLog.action,
				resourceType: auditLog.resourceType,
				resourceId: auditLog.resourceId,
				metadata: auditLog.metadata,
			})
			.from(auditLog)
			.where(inArray(auditLog.action, ["delivery.cancel", "agent.disable"]))
			.orderBy(asc(auditLog.id));
		expect(auditRows).toHaveLength(3);
		expect(auditRows.every((row) => row.actorKind === "admin")).toBe(true);
		expect(auditRows.every((row) => row.actorId === null)).toBe(true);
		expect(
			auditRows.every(
				(row) =>
					typeof row.metadata === "object" &&
					row.metadata !== null &&
					(row.metadata as Record<string, unknown>).target_agent_id === owner.id,
			),
		).toBe(true);
		const cancellationAudits = auditRows.filter((row) => row.action === "delivery.cancel");
		expect(cancellationAudits.map((row) => row.resourceId).sort()).toEqual(
			[...affected.deliveryIds].sort(),
		);
		expect(cancellationAudits.every((row) => row.resourceType === "node_delivery")).toBe(true);
		const disableAudit = auditRows.find((row) => row.action === "agent.disable");
		expect(disableAudit).toMatchObject({
			resourceType: "agent",
			resourceId: owner.id,
			metadata: {
				target_agent_id: owner.id,
				revoked_node_ids: [ownerNode.nodeId],
			},
		});
	});

	it("prevents an earlier Node enrollment from committing after disablement", async () => {
		if (!TEST_DATABASE_URL) throw new Error("expected test database URL");
		const owner = await createAgent("enrollment-race@acme");
		const existing = await enrollAgentNode(owner.key, "existing-node");
		const blockerSql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
		const observerSql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
		const nodeLockAcquired = deferred<number>();
		const releaseNodeLock = deferred<void>();
		const transactionEntered = deferred<void>();
		const releaseTransaction = deferred<void>();
		const delayedDb = delayFirstTransaction(handle.db, transactionEntered, releaseTransaction);
		const config = loadConfig({ ...TEST_ENV } as NodeJS.ProcessEnv);
		const delayedApp = createServer({ config, logger: createLogger(config), db: delayedDb });
		let enrollmentRequest: Promise<Response> | undefined;
		let disableRequest: Promise<Response> | undefined;
		const blocker = blockerSql.begin(async (tx) => {
			const [backend] = await tx<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
			if (!backend) throw new Error("expected blocker backend");
			await tx`SELECT pg_advisory_xact_lock(
				hashtextextended(${`node:${existing.nodeId}`}::text, 0)
			)`;
			nodeLockAcquired.resolve(backend.pid);
			await releaseNodeLock.promise;
		});

		try {
			const blockerPid = await nodeLockAcquired.promise;
			enrollmentRequest = delayedApp.request("/agents/me/nodes", {
				method: "POST",
				headers: bearer(owner.key),
				body: JSON.stringify({ name: "late-node", capabilities: ["runtime.fake"] }),
			});
			await transactionEntered.promise;

			disableRequest = app.request(`/admin/agents/${owner.id}`, {
				method: "DELETE",
				headers: adminHeaders(),
			});
			await waitForBlockedBy(
				observerSql,
				blockerPid,
				1,
				"disablement did not retain the lifecycle lock while waiting on the Node",
			);
			releaseTransaction.resolve();
			await waitUntil(
				async () => (await advisoryWaiterCount(observerSql)) >= 2,
				"Node enrollment did not wait behind disablement on the lifecycle lock",
			);

			releaseNodeLock.resolve();
			await blocker;
			const disableResponse = await disableRequest;
			expect(disableResponse.status).toBe(204);
			const enrollmentResponse = await enrollmentRequest;
			expect(enrollmentResponse.status).toBe(401);
			expect(await enrollmentResponse.json()).toMatchObject({ code: "unauthenticated" });

			const storedNodes = await handle.db
				.select({ name: nodes.name, status: nodes.status })
				.from(nodes)
				.where(eq(nodes.agentId, owner.id));
			expect(storedNodes).toEqual([{ name: "existing-node", status: "revoked" }]);
			const activeCredentials = await handle.db
				.select({ id: nodeCredentials.id })
				.from(nodeCredentials)
				.innerJoin(nodes, eq(nodes.id, nodeCredentials.nodeId))
				.where(and(eq(nodes.agentId, owner.id), isNull(nodeCredentials.revokedAt)));
			expect(activeCredentials).toEqual([]);
		} finally {
			releaseTransaction.resolve();
			releaseNodeLock.resolve();
			await blocker.catch(() => undefined);
			await enrollmentRequest?.catch(() => undefined);
			await disableRequest?.catch(() => undefined);
			await observerSql.end({ timeout: 2 });
			await blockerSql.end({ timeout: 2 });
		}
	});

	it("locks the union of crossed Missions in one deterministic order", async () => {
		if (!TEST_DATABASE_URL) throw new Error("expected test database URL");
		const left = await createAgent("crossed-left@acme");
		const right = await createAgent("crossed-right@acme");
		const leftFirst = await seedOwnedNode(handle, {
			agentId: left.id,
			nodeId: "20000000-0000-4000-8000-000000000001",
			name: "left-first",
		});
		const leftSecond = await seedOwnedNode(handle, {
			agentId: left.id,
			nodeId: "20000000-0000-4000-8000-000000000002",
			name: "left-second",
		});
		const rightFirst = await seedOwnedNode(handle, {
			agentId: right.id,
			nodeId: "30000000-0000-4000-8000-000000000001",
			name: "right-first",
		});
		const rightSecond = await seedOwnedNode(handle, {
			agentId: right.id,
			nodeId: "30000000-0000-4000-8000-000000000002",
			name: "right-second",
		});
		const firstMissionId = "10000000-0000-4000-8000-000000000001";
		const secondMissionId = "10000000-0000-4000-8000-000000000002";
		await seedMission(handle, {
			missionId: firstMissionId,
			createdByAgentId: left.id,
			participants: [
				{
					agentId: left.id,
					nodeId: leftSecond.nodeId,
					workspaceBindingId: leftSecond.workspaceBindingId,
				},
				{
					agentId: right.id,
					nodeId: rightFirst.nodeId,
					workspaceBindingId: rightFirst.workspaceBindingId,
				},
			],
			deliveryNodeIds: [leftSecond.nodeId, rightFirst.nodeId],
		});
		await seedMission(handle, {
			missionId: secondMissionId,
			createdByAgentId: left.id,
			participants: [
				{
					agentId: left.id,
					nodeId: leftFirst.nodeId,
					workspaceBindingId: leftFirst.workspaceBindingId,
				},
				{
					agentId: right.id,
					nodeId: rightSecond.nodeId,
					workspaceBindingId: rightSecond.workspaceBindingId,
				},
			],
			deliveryNodeIds: [leftFirst.nodeId, rightSecond.nodeId],
		});

		const blockerSql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
		const observerSql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
		const firstMissionLocked = deferred<number>();
		const releaseFirstMission = deferred<void>();
		let leftDisable: Promise<Response> | undefined;
		let rightDisable: Promise<Response> | undefined;
		const blocker = blockerSql.begin(async (tx) => {
			const [backend] = await tx<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
			if (!backend) throw new Error("expected blocker backend");
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${firstMissionId}, 0))`;
			firstMissionLocked.resolve(backend.pid);
			await releaseFirstMission.promise;
		});

		try {
			const blockerPid = await firstMissionLocked.promise;
			leftDisable = app.request(`/admin/agents/${left.id}`, {
				method: "DELETE",
				headers: adminHeaders(),
			});
			rightDisable = app.request(`/admin/agents/${right.id}`, {
				method: "DELETE",
				headers: adminHeaders(),
			});
			await waitForBlockedBy(
				observerSql,
				blockerPid,
				2,
				"both disablements did not wait on the first Mission in UUID order",
			);
			const [probe] = await observerSql<Array<{ acquired: boolean }>>`
				SELECT pg_try_advisory_xact_lock(hashtextextended(${secondMissionId}, 0)) AS acquired
			`;
			expect(probe?.acquired).toBe(true);

			releaseFirstMission.resolve();
			await blocker;
			expect((await leftDisable).status).toBe(204);
			expect((await rightDisable).status).toBe(204);
			const storedAgents = await handle.db
				.select({ id: agents.id, status: agents.status })
				.from(agents)
				.where(inArray(agents.id, [left.id, right.id]))
				.orderBy(asc(agents.id));
			expect(storedAgents.every((agent) => agent.status === "disabled")).toBe(true);
			const storedKeys = await handle.db
				.select({ revokedAt: apiKeys.revokedAt })
				.from(apiKeys)
				.where(inArray(apiKeys.agentId, [left.id, right.id]));
			expect(storedKeys).toHaveLength(2);
			expect(storedKeys.every((key) => key.revokedAt !== null)).toBe(true);
			const storedNodes = await handle.db
				.select({ id: nodes.id, status: nodes.status })
				.from(nodes)
				.where(inArray(nodes.agentId, [left.id, right.id]));
			expect(storedNodes).toHaveLength(4);
			expect(storedNodes.every((node) => node.status === "revoked")).toBe(true);
			const storedCredentials = await handle.db
				.select({ revokedAt: nodeCredentials.revokedAt })
				.from(nodeCredentials)
				.innerJoin(nodes, eq(nodes.id, nodeCredentials.nodeId))
				.where(inArray(nodes.agentId, [left.id, right.id]));
			expect(storedCredentials).toHaveLength(4);
			expect(storedCredentials.every((credential) => credential.revokedAt !== null)).toBe(true);
			const storedWorkspaces = await handle.db
				.select({ status: workspaceBindings.status })
				.from(workspaceBindings)
				.innerJoin(nodes, eq(nodes.id, workspaceBindings.nodeId))
				.where(inArray(nodes.agentId, [left.id, right.id]));
			expect(storedWorkspaces).toHaveLength(4);
			expect(storedWorkspaces.every((workspace) => workspace.status === "revoked")).toBe(true);
			const deliveries = await handle.db
				.select({ status: nodeDeliveries.status })
				.from(nodeDeliveries)
				.where(inArray(nodeDeliveries.missionId, [firstMissionId, secondMissionId]));
			expect(deliveries).toHaveLength(4);
			expect(deliveries.every((delivery) => delivery.status === "cancelled")).toBe(true);
		} finally {
			releaseFirstMission.resolve();
			await blocker.catch(() => undefined);
			await leftDisable?.catch(() => undefined);
			await rightDisable?.catch(() => undefined);
			await observerSql.end({ timeout: 2 });
			await blockerSql.end({ timeout: 2 });
		}
	});

	it("rejects malformed bearer tokens", async () => {
		const res = await app.request("/agents", {
			headers: { authorization: "Bearer not-a-real-key" },
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("unauthenticated");
	});
});

interface SeedMissionParticipant {
	readonly agentId: string;
	readonly nodeId: string;
	readonly workspaceBindingId: string;
}

interface SeedMissionResult {
	readonly missionId: string;
	readonly deliveryIds: readonly string[];
}

async function seedMission(
	handle: TestDb,
	input: {
		readonly missionId?: string;
		readonly createdByAgentId: string;
		readonly participants: readonly SeedMissionParticipant[];
		readonly deliveryNodeIds: readonly string[];
	},
): Promise<SeedMissionResult> {
	const missionId = input.missionId ?? randomUUID();
	const eventId = randomUUID();
	await handle.db.insert(missions).values({
		id: missionId,
		createdByAgentId: input.createdByAgentId,
		coordinatorConfig: {},
		state: {},
		status: "active",
		expiresAt: new Date(Date.now() + 120_000),
	});
	await handle.db.insert(missionParticipants).values(
		input.participants.map((participant, index) => ({
			missionId,
			agentId: participant.agentId,
			nodeId: participant.nodeId,
			workspaceBindingId: participant.workspaceBindingId,
			role: `participant-${index + 1}`,
		})),
	);
	await handle.db.insert(missionEvents).values({
		id: eventId,
		missionId,
		sequenceNo: 1,
		type: "participants_accepted",
		actorAgentId: input.createdByAgentId,
		idempotencyKey: `event:${eventId}`,
		payload: {},
	});
	const deliveryIds = input.deliveryNodeIds.map(() => randomUUID());
	await handle.db.insert(nodeDeliveries).values(
		input.deliveryNodeIds.map((nodeId, index) => ({
			id: deliveryIds[index]!,
			nodeId,
			missionId,
			missionEventId: eventId,
			kind: "turn",
			contractVersion: 1,
			idempotencyKey: `delivery:${deliveryIds[index]}`,
		})),
	);
	return { missionId, deliveryIds };
}

async function seedOwnedNode(
	handle: TestDb,
	input: { readonly agentId: string; readonly nodeId: string; readonly name: string },
): Promise<{ nodeId: string; workspaceBindingId: string }> {
	const credentialId = randomUUID();
	const workspaceBindingId = randomUUID();
	await handle.db.insert(nodes).values({
		id: input.nodeId,
		agentId: input.agentId,
		name: input.name,
	});
	await handle.db.insert(nodeCredentials).values({
		id: credentialId,
		nodeId: input.nodeId,
		keyHash: Buffer.from(`hash:${credentialId}`),
		salt: Buffer.from(`salt:${credentialId}`),
	});
	await handle.db.insert(workspaceBindings).values({
		id: workspaceBindingId,
		nodeId: input.nodeId,
		alias: `${input.name}-workspace`,
		repositoryUrl: `https://example.test/${input.name}.git`,
	});
	return { nodeId: input.nodeId, workspaceBindingId };
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve: (value?: T) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve = (_value?: T): void => undefined;
	const promise = new Promise<T>((done) => {
		resolve = (value) => done(value as T);
	});
	return { promise, resolve };
}

function delayFirstTransaction(
	db: Database,
	entered: Deferred<void>,
	release: Deferred<void>,
): Database {
	let shouldDelay = true;
	return new Proxy(db, {
		get(target, property, receiver) {
			if (property !== "transaction") return Reflect.get(target, property, receiver);
			return async (callback: Parameters<Database["transaction"]>[0]) => {
				if (shouldDelay) {
					shouldDelay = false;
					entered.resolve();
					await release.promise;
				}
				return target.transaction(callback);
			};
		},
	});
}

async function waitForBlockedBy(
	sql: Sql,
	blockerPid: number,
	expectedWaiters: number,
	message: string,
	timeoutMs = 2_000,
): Promise<void> {
	await waitUntil(
		async () => {
			const [row] = await sql<Array<{ waiters: string }>>`
			SELECT count(*)::text AS waiters
			FROM pg_stat_activity
			WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
		`;
			return Number(row?.waiters ?? "0") >= expectedWaiters;
		},
		message,
		timeoutMs,
	);
}

async function advisoryWaiterCount(sql: Sql): Promise<number> {
	const [row] = await sql<Array<{ waiters: string }>>`
		SELECT count(*)::text AS waiters
		FROM pg_locks
		WHERE locktype = 'advisory'
			AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
			AND NOT granted
	`;
	return Number(row?.waiters ?? "0");
}

async function waitUntil(
	predicate: () => Promise<boolean>,
	message: string,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(message);
}
