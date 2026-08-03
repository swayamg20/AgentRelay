import {
	type NodeDescriptor,
	type OwnedNodeSummary,
	type WorkspaceBindingDescriptor,
	nodeDescriptorSchema,
	ownedNodeSummarySchema,
	workspaceBindingDescriptorSchema,
} from "@agentrelay/protocol";
import { and, asc, eq, isNull } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashKey } from "../auth/keys.js";
import { clearLastUsedDebounce, clearNodeLastUsedDebounce } from "../auth/middleware.js";
import { loadConfig } from "../config.js";
import { agents, auditLog, nodeCredentials, nodes, workspaceBindings } from "../db/schema.js";
import { type TestDb, truncateAll, tryConnect } from "../db/test-utils.js";
import { createLogger } from "../logger.js";
import { createServer } from "../server.js";

const conn = await tryConnect();
const d = conn.available ? describe : describe.skip;
const TEST_DATABASE_URL = process.env.RELAY_TEST_DATABASE_URL ?? process.env.RELAY_DATABASE_URL;

if (!conn.available) {
	console.warn(`[nodes.test] skipping: ${conn.reason}`);
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

interface AgentIdentity {
	id: string;
	key: string;
}

interface IssuedCredential {
	id: string;
	token: string;
}

interface EnrollmentResponse {
	node: NodeDescriptor;
	credential: IssuedCredential;
}

interface WorkspaceResponse {
	workspace: WorkspaceBindingDescriptor;
	replayed: boolean;
}

interface ErrorResponse {
	code: string;
	message: string;
	details?: Record<string, unknown>;
}

d("Node enrollment and workspace registration", () => {
	let handle: TestDb;
	let app: ReturnType<typeof createServer>;

	beforeAll(() => {
		if (!conn.handle) throw new Error("expected db handle");
		handle = conn.handle;
		const config = loadConfig({ ...TEST_ENV } as NodeJS.ProcessEnv);
		app = createServer({ config, logger: createLogger(config), db: handle.db });
	});

	beforeEach(async () => {
		await truncateAll(handle.sql);
		clearLastUsedDebounce();
		clearNodeLastUsedDebounce();
	});

	afterAll(async () => {
		if (handle) await handle.close();
	});

	function adminHeaders(): Record<string, string> {
		return {
			authorization: `Bearer ${TEST_ENV.RELAY_ADMIN_TOKEN}`,
			"content-type": "application/json",
		};
	}

	function bearer(token: string, requestId?: string): Record<string, string> {
		return {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			...(requestId ? { "x-request-id": requestId } : {}),
		};
	}

	async function createAgent(localPart: string): Promise<AgentIdentity> {
		const response = await app.request("/admin/agents", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({
				handle: `${localPart}@acme`,
				email: `${localPart}@acme.test`,
				display_name: localPart,
				role: "engineer",
			}),
		});
		expect(response.status).toBe(201);
		const body = (await response.json()) as { agent_id: string; api_key: string };
		return { id: body.agent_id, key: body.api_key };
	}

	async function enrollNode(
		agentKey: string,
		name = "backend-mac",
		capabilities = ["runtime.codex", "runtime.fake"],
		requestId?: string,
	): Promise<EnrollmentResponse> {
		const response = await app.request("/agents/me/nodes", {
			method: "POST",
			headers: bearer(agentKey, requestId),
			body: JSON.stringify({ name, capabilities }),
		});
		expect(response.status).toBe(201);
		return (await response.json()) as EnrollmentResponse;
	}

	async function registerWorkspace(
		nodeToken: string,
		input: {
			alias: string;
			repository_url: string;
			allowed_base_refs: string[];
		},
		requestId?: string,
	): Promise<{ response: Response; body: WorkspaceResponse }> {
		const response = await app.request("/node/v1/workspaces", {
			method: "POST",
			headers: bearer(nodeToken, requestId),
			body: JSON.stringify(input),
		});
		const body = (await response.json()) as WorkspaceResponse;
		return { response, body };
	}

	async function expectError(
		response: Response,
		status: number,
		code: string,
	): Promise<ErrorResponse> {
		expect(response.status).toBe(status);
		const body = (await response.json()) as ErrorResponse;
		expect(body.code).toBe(code);
		expect(body.message.length).toBeGreaterThan(0);
		return body;
	}

	it("issues a one-time Node credential, stores only its hash, and returns protocol descriptors", async () => {
		const owner = await createAgent("alice");
		const enrolled = await enrollNode(owner.key, "backend-mac", ["runtime.fake", "runtime.codex"]);

		expect(enrolled.credential.token).toMatch(/^ar_node_test_[a-z2-7]{32}$/);
		expect(enrolled.credential.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(nodeDescriptorSchema.parse(enrolled.node)).toEqual(enrolled.node);
		expect(enrolled.node).toMatchObject({
			agent_id: owner.id,
			name: "backend-mac",
			status: "active",
			capabilities: ["runtime.codex", "runtime.fake"],
			last_seen_at: null,
			revoked_at: null,
		});

		const [stored] = await handle.db
			.select({
				id: nodeCredentials.id,
				nodeId: nodeCredentials.nodeId,
				keyHash: nodeCredentials.keyHash,
				salt: nodeCredentials.salt,
				label: nodeCredentials.label,
			})
			.from(nodeCredentials)
			.where(eq(nodeCredentials.id, enrolled.credential.id));
		expect(stored).toBeDefined();
		expect(stored?.nodeId).toBe(enrolled.node.node_id);
		expect(stored?.label).toBe("enrollment");
		expect(
			Buffer.from(stored?.keyHash ?? []).equals(
				hashKey(enrolled.credential.token, TEST_ENV.RELAY_PEPPER),
			),
		).toBe(true);
		expect(Buffer.from(stored?.salt ?? [])).toHaveLength(16);
		expect(JSON.stringify(stored)).not.toContain(enrolled.credential.token);

		const ownerListResponse = await app.request("/agents/me/nodes", {
			headers: bearer(owner.key),
		});
		expect(ownerListResponse.status).toBe(200);
		const ownerList = (await ownerListResponse.json()) as { nodes: OwnedNodeSummary[] };
		expect(ownerList.nodes).toHaveLength(1);
		expect(ownedNodeSummarySchema.parse(ownerList.nodes[0])).toEqual(ownerList.nodes[0]);
		expect(ownerList.nodes[0]?.node).toEqual(enrolled.node);
		expect(ownerList.nodes[0]?.active_credential_id).toBe(enrolled.credential.id);
		expect(JSON.stringify(ownerList)).not.toContain(enrolled.credential.token);
		expect(JSON.stringify(ownerList)).not.toContain("key_hash");
		expect(JSON.stringify(ownerList)).not.toContain("salt");

		const nodeMeResponse = await app.request("/node/v1/me", {
			headers: bearer(enrolled.credential.token),
		});
		expect(nodeMeResponse.status).toBe(200);
		const nodeMe = (await nodeMeResponse.json()) as { node: NodeDescriptor };
		expect(nodeDescriptorSchema.parse(nodeMe.node)).toEqual(nodeMe.node);
		expect(nodeMe.node.node_id).toBe(enrolled.node.node_id);
		expect(JSON.stringify(nodeMe)).not.toContain(enrolled.credential.token);
	});

	it("strictly rejects local authority and invalid or duplicate Node capabilities", async () => {
		const owner = await createAgent("alice");
		const invalidPayloads = [
			{
				name: "backend-mac",
				capabilities: ["runtime.fake"],
				local_path: "/Users/alice/backend",
			},
			{ name: "backend-mac", capabilities: ["runtime.fake", "runtime.fake"] },
			{ name: "backend-mac", capabilities: ["../execute"] },
			{ name: "..", capabilities: ["runtime.fake"] },
		];

		for (const payload of invalidPayloads) {
			const response = await app.request("/agents/me/nodes", {
				method: "POST",
				headers: bearer(owner.key),
				body: JSON.stringify(payload),
			});
			await expectError(response, 400, "invalid_params");
		}

		const storedNodes = await handle.db.select({ id: nodes.id }).from(nodes);
		expect(storedNodes).toEqual([]);
	});

	it("keeps agent and Node bearer types separate and isolates Node ownership", async () => {
		const alice = await createAgent("alice");
		const bob = await createAgent("bob");
		const aliceNode = await enrollNode(alice.key, "shared-name");
		const bobNode = await enrollNode(bob.key, "shared-name");

		await expectError(
			await app.request("/agents/me", { headers: bearer(aliceNode.credential.token) }),
			401,
			"unauthenticated",
		);
		await expectError(
			await app.request("/node/v1/me", { headers: bearer(alice.key) }),
			401,
			"unauthenticated",
		);

		const aliceList = (await (
			await app.request("/agents/me/nodes", { headers: bearer(alice.key) })
		).json()) as { nodes: OwnedNodeSummary[] };
		const bobList = (await (
			await app.request("/agents/me/nodes", { headers: bearer(bob.key) })
		).json()) as { nodes: OwnedNodeSummary[] };
		expect(aliceList.nodes.map((summary) => summary.node.node_id)).toEqual([
			aliceNode.node.node_id,
		]);
		expect(bobList.nodes.map((summary) => summary.node.node_id)).toEqual([bobNode.node.node_id]);

		await expectError(
			await app.request(`/agents/me/nodes/${aliceNode.node.node_id}/credentials/rotate`, {
				method: "POST",
				headers: bearer(bob.key),
				body: JSON.stringify({ expected_credential_id: aliceNode.credential.id }),
			}),
			404,
			"node_not_found",
		);
		await expectError(
			await app.request(`/agents/me/nodes/${aliceNode.node.node_id}`, {
				method: "DELETE",
				headers: bearer(bob.key),
			}),
			404,
			"node_not_found",
		);

		const stillAuthorized = await app.request("/node/v1/me", {
			headers: bearer(aliceNode.credential.token),
		});
		expect(stillAuthorized.status).toBe(200);
	});

	it("rejects an active duplicate Node name without changing the original", async () => {
		const owner = await createAgent("alice");
		const original = await enrollNode(owner.key, "backend-mac");

		const duplicateResponse = await app.request("/agents/me/nodes", {
			method: "POST",
			headers: bearer(owner.key),
			body: JSON.stringify({
				name: "backend-mac",
				capabilities: ["runtime.other"],
			}),
		});
		const error = await expectError(duplicateResponse, 409, "state_changed");
		expect(error.details).toMatchObject({ node_id: original.node.node_id });

		const ownerList = (await (
			await app.request("/agents/me/nodes", { headers: bearer(owner.key) })
		).json()) as { nodes: OwnedNodeSummary[] };
		expect(ownerList.nodes).toHaveLength(1);
		expect(ownerList.nodes[0]?.node.capabilities).toEqual(["runtime.codex", "runtime.fake"]);
		const credentials = await handle.db.select().from(nodeCredentials);
		expect(credentials).toHaveLength(1);
	});

	it("rotates a Node credential atomically and immediately invalidates the old token", async () => {
		const owner = await createAgent("alice");
		const enrolled = await enrollNode(owner.key);
		await expectError(
			await app.request(`/agents/me/nodes/${enrolled.node.node_id}/credentials/rotate`, {
				method: "POST",
				headers: bearer(owner.key),
			}),
			400,
			"invalid_params",
		);

		const rotateResponse = await app.request(
			`/agents/me/nodes/${enrolled.node.node_id}/credentials/rotate`,
			{
				method: "POST",
				headers: bearer(owner.key, "req_node_rotate"),
				body: JSON.stringify({ expected_credential_id: enrolled.credential.id }),
			},
		);
		expect(rotateResponse.status).toBe(200);
		const rotated = (await rotateResponse.json()) as {
			node_id: string;
			credential: IssuedCredential;
		};
		expect(rotated.node_id).toBe(enrolled.node.node_id);
		expect(rotated.credential.token).toMatch(/^ar_node_test_[a-z2-7]{32}$/);
		expect(rotated.credential.token).not.toBe(enrolled.credential.token);

		await expectError(
			await app.request("/node/v1/me", { headers: bearer(enrolled.credential.token) }),
			401,
			"unauthenticated",
		);
		const freshResponse = await app.request("/node/v1/me", {
			headers: bearer(rotated.credential.token),
		});
		expect(freshResponse.status).toBe(200);
		const staleRotation = await app.request(
			`/agents/me/nodes/${enrolled.node.node_id}/credentials/rotate`,
			{
				method: "POST",
				headers: bearer(owner.key),
				body: JSON.stringify({ expected_credential_id: enrolled.credential.id }),
			},
		);
		const staleError = await expectError(staleRotation, 409, "state_changed");
		expect(staleError.details).toMatchObject({
			active_credential_id: rotated.credential.id,
		});

		const credentials = await handle.db
			.select({ id: nodeCredentials.id, revokedAt: nodeCredentials.revokedAt })
			.from(nodeCredentials)
			.where(eq(nodeCredentials.nodeId, enrolled.node.node_id))
			.orderBy(asc(nodeCredentials.createdAt), asc(nodeCredentials.id));
		expect(credentials).toHaveLength(2);
		expect(credentials.filter((credential) => credential.revokedAt === null)).toEqual([
			{ id: rotated.credential.id, revokedAt: null },
		]);
		const rotationAudits = await handle.db
			.select({ id: auditLog.id })
			.from(auditLog)
			.where(eq(auditLog.action, "node.credential.rotate"));
		expect(rotationAudits).toHaveLength(1);
	});

	it("allows exactly one concurrent credential rotation and supports list-based recovery", async () => {
		const owner = await createAgent("alice");
		const enrolled = await enrollNode(owner.key);
		const rotationPath = `/agents/me/nodes/${enrolled.node.node_id}/credentials/rotate`;
		const rotationInit = {
			method: "POST",
			headers: bearer(owner.key),
			body: JSON.stringify({ expected_credential_id: enrolled.credential.id }),
		};

		const responses = await Promise.all([
			app.request(rotationPath, rotationInit),
			app.request(rotationPath, rotationInit),
		]);
		expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
		const winnerResponse = responses.find((response) => response.status === 200);
		const staleResponse = responses.find((response) => response.status === 409);
		if (!winnerResponse || !staleResponse) throw new Error("expected one rotation winner");
		const winner = (await winnerResponse.json()) as {
			credential: IssuedCredential;
		};
		const staleError = await expectError(staleResponse, 409, "state_changed");
		expect(staleError.details).toMatchObject({
			active_credential_id: winner.credential.id,
		});

		await expectError(
			await app.request("/node/v1/me", { headers: bearer(enrolled.credential.token) }),
			401,
			"unauthenticated",
		);
		expect(
			(await app.request("/node/v1/me", { headers: bearer(winner.credential.token) })).status,
		).toBe(200);

		const ownerListResponse = await app.request("/agents/me/nodes", {
			headers: bearer(owner.key),
		});
		expect(ownerListResponse.status).toBe(200);
		const ownerList = (await ownerListResponse.json()) as { nodes: OwnedNodeSummary[] };
		const current = ownedNodeSummarySchema.parse(ownerList.nodes[0]);
		expect(current.active_credential_id).toBe(winner.credential.id);

		const recoveryResponse = await app.request(rotationPath, {
			method: "POST",
			headers: bearer(owner.key),
			body: JSON.stringify({ expected_credential_id: current.active_credential_id }),
		});
		expect(recoveryResponse.status).toBe(200);
		const recovered = (await recoveryResponse.json()) as { credential: IssuedCredential };
		await expectError(
			await app.request("/node/v1/me", { headers: bearer(winner.credential.token) }),
			401,
			"unauthenticated",
		);
		expect(
			(await app.request("/node/v1/me", { headers: bearer(recovered.credential.token) })).status,
		).toBe(200);

		const activeCredentials = await handle.db
			.select({ id: nodeCredentials.id })
			.from(nodeCredentials)
			.where(
				and(eq(nodeCredentials.nodeId, enrolled.node.node_id), isNull(nodeCredentials.revokedAt)),
			);
		expect(activeCredentials).toEqual([{ id: recovered.credential.id }]);
		const rotationAudits = await handle.db
			.select({ id: auditLog.id })
			.from(auditLog)
			.where(eq(auditLog.action, "node.credential.rotate"));
		expect(rotationAudits).toHaveLength(2);
	});

	it("invalidates Node authentication when the owning agent is disabled", async () => {
		const owner = await createAgent("alice");
		const enrolled = await enrollNode(owner.key);

		const disableResponse = await app.request(`/admin/agents/${owner.id}`, {
			method: "DELETE",
			headers: adminHeaders(),
		});
		expect(disableResponse.status).toBe(204);
		await expectError(
			await app.request("/node/v1/me", { headers: bearer(enrolled.credential.token) }),
			401,
			"unauthenticated",
		);

		const [storedOwner] = await handle.db
			.select({ status: agents.status })
			.from(agents)
			.where(eq(agents.id, owner.id));
		expect(storedOwner?.status).toBe("disabled");
	});

	it("rejects local paths, credential-bearing or file URLs, and unsafe or duplicate refs", async () => {
		const owner = await createAgent("alice");
		const enrolled = await enrollNode(owner.key);
		const base = {
			alias: "backend-api",
			repository_url: "https://github.com/acme/backend.git",
			allowed_base_refs: ["refs/heads/main"],
		};
		const invalidPayloads = [
			{ ...base, local_path: "/Users/alice/backend" },
			{ ...base, repository_url: "file:///Users/alice/backend" },
			{ ...base, repository_url: "https://alice:secret@github.com/acme/backend.git" },
			{ ...base, repository_url: "ssh://alice@github.com/acme/backend.git" },
			{ ...base, allowed_base_refs: ["../outside"] },
			{ ...base, allowed_base_refs: ["refs/heads/main", "refs/heads/main"] },
		];

		for (const payload of invalidPayloads) {
			const response = await app.request("/node/v1/workspaces", {
				method: "POST",
				headers: bearer(enrolled.credential.token),
				body: JSON.stringify(payload),
			});
			await expectError(response, 400, "invalid_params");
		}

		const storedWorkspaces = await handle.db
			.select({ id: workspaceBindings.id })
			.from(workspaceBindings);
		expect(storedWorkspaces).toEqual([]);
	});

	it("normalizes workspace refs, replays exact registration, rejects divergence, and retires revoked aliases", async () => {
		const owner = await createAgent("alice");
		const enrolled = await enrollNode(owner.key);
		const originalInput = {
			alias: "backend-api",
			repository_url: "https://github.com/acme/backend.git",
			allowed_base_refs: ["refs/heads/release", "refs/heads/main"],
		};

		const created = await registerWorkspace(
			enrolled.credential.token,
			originalInput,
			"req_workspace_register",
		);
		expect(created.response.status).toBe(201);
		expect(created.body.replayed).toBe(false);
		expect(workspaceBindingDescriptorSchema.parse(created.body.workspace)).toEqual(
			created.body.workspace,
		);
		expect(created.body.workspace).toMatchObject({
			node_id: enrolled.node.node_id,
			agent_id: owner.id,
			alias: "backend-api",
			allowed_base_refs: ["refs/heads/main", "refs/heads/release"],
			status: "active",
			revoked_at: null,
		});

		const replay = await registerWorkspace(enrolled.credential.token, {
			...originalInput,
			allowed_base_refs: ["refs/heads/main", "refs/heads/release"],
		});
		expect(replay.response.status).toBe(200);
		expect(replay.body).toEqual({ ...created.body, replayed: true });

		for (const divergent of [
			{ ...originalInput, repository_url: "https://github.com/acme/other.git" },
			{ ...originalInput, allowed_base_refs: ["refs/heads/develop"] },
		]) {
			const response = await app.request("/node/v1/workspaces", {
				method: "POST",
				headers: bearer(enrolled.credential.token),
				body: JSON.stringify(divergent),
			});
			await expectError(response, 409, "state_changed");
		}

		const listResponse = await app.request("/node/v1/workspaces", {
			headers: bearer(enrolled.credential.token),
		});
		expect(listResponse.status).toBe(200);
		const list = (await listResponse.json()) as { workspaces: WorkspaceBindingDescriptor[] };
		expect(list.workspaces).toHaveLength(1);
		expect(workspaceBindingDescriptorSchema.parse(list.workspaces[0])).toEqual(list.workspaces[0]);
		expect(list.workspaces[0]?.workspace_binding_id).toBe(
			created.body.workspace.workspace_binding_id,
		);
		expect(JSON.stringify(list)).not.toContain("local_path");

		const revokeResponse = await app.request("/node/v1/workspaces/backend-api", {
			method: "DELETE",
			headers: bearer(enrolled.credential.token, "req_workspace_revoke"),
		});
		expect(revokeResponse.status).toBe(204);
		const repeatedRevoke = await app.request("/node/v1/workspaces/backend-api", {
			method: "DELETE",
			headers: bearer(enrolled.credential.token),
		});
		expect(repeatedRevoke.status).toBe(204);

		const afterRevokeResponse = await app.request("/node/v1/workspaces", {
			headers: bearer(enrolled.credential.token),
		});
		expect(afterRevokeResponse.status).toBe(200);
		const afterRevoke = (await afterRevokeResponse.json()) as {
			workspaces: WorkspaceBindingDescriptor[];
		};
		expect(afterRevoke.workspaces).toHaveLength(1);
		expect(afterRevoke.workspaces[0]?.status).toBe("revoked");
		expect(afterRevoke.workspaces[0]?.revoked_at).not.toBeNull();
		expect(workspaceBindingDescriptorSchema.parse(afterRevoke.workspaces[0])).toEqual(
			afterRevoke.workspaces[0],
		);

		const reuseResponse = await app.request("/node/v1/workspaces", {
			method: "POST",
			headers: bearer(enrolled.credential.token),
			body: JSON.stringify(originalInput),
		});
		await expectError(reuseResponse, 409, "invalid_transition");

		const workspaceAudit = await handle.db
			.select({ action: auditLog.action, requestId: auditLog.requestId })
			.from(auditLog)
			.where(eq(auditLog.resourceType, "workspace_binding"))
			.orderBy(asc(auditLog.id));
		expect(workspaceAudit).toEqual([
			{ action: "workspace.register", requestId: "req_workspace_register" },
			{ action: "workspace.revoke", requestId: "req_workspace_revoke" },
		]);
	});

	it("audits Node mutations and cascades Node revocation to every credential and workspace", async () => {
		const owner = await createAgent("alice");
		const enrolled = await enrollNode(
			owner.key,
			"backend-mac",
			["runtime.fake"],
			"req_node_enroll",
		);
		const registered = await registerWorkspace(
			enrolled.credential.token,
			{
				alias: "backend-api",
				repository_url: "https://github.com/acme/backend.git",
				allowed_base_refs: ["refs/heads/main"],
			},
			"req_workspace_register",
		);
		expect(registered.response.status).toBe(201);

		const rotateResponse = await app.request(
			`/agents/me/nodes/${enrolled.node.node_id}/credentials/rotate`,
			{
				method: "POST",
				headers: bearer(owner.key, "req_node_rotate"),
				body: JSON.stringify({ expected_credential_id: enrolled.credential.id }),
			},
		);
		expect(rotateResponse.status).toBe(200);
		const rotated = (await rotateResponse.json()) as { credential: IssuedCredential };

		const revokeResponse = await app.request(`/agents/me/nodes/${enrolled.node.node_id}`, {
			method: "DELETE",
			headers: bearer(owner.key, "req_node_revoke"),
		});
		expect(revokeResponse.status).toBe(204);
		const repeatedRevoke = await app.request(`/agents/me/nodes/${enrolled.node.node_id}`, {
			method: "DELETE",
			headers: bearer(owner.key),
		});
		expect(repeatedRevoke.status).toBe(204);

		for (const token of [enrolled.credential.token, rotated.credential.token]) {
			await expectError(
				await app.request("/node/v1/me", { headers: bearer(token) }),
				401,
				"unauthenticated",
			);
		}

		const credentialRows = await handle.db
			.select({ revokedAt: nodeCredentials.revokedAt })
			.from(nodeCredentials)
			.where(eq(nodeCredentials.nodeId, enrolled.node.node_id));
		expect(credentialRows).toHaveLength(2);
		expect(credentialRows.every((credential) => credential.revokedAt !== null)).toBe(true);

		const [workspace] = await handle.db
			.select({ status: workspaceBindings.status, revokedAt: workspaceBindings.revokedAt })
			.from(workspaceBindings)
			.where(eq(workspaceBindings.id, registered.body.workspace.workspace_binding_id));
		expect(workspace?.status).toBe("revoked");
		expect(workspace?.revokedAt).not.toBeNull();

		const ownerListResponse = await app.request("/agents/me/nodes", {
			headers: bearer(owner.key),
		});
		expect(ownerListResponse.status).toBe(200);
		const ownerList = (await ownerListResponse.json()) as { nodes: OwnedNodeSummary[] };
		expect(ownerList.nodes).toHaveLength(1);
		expect(ownerList.nodes[0]?.node.status).toBe("revoked");
		expect(ownerList.nodes[0]?.node.revoked_at).not.toBeNull();
		expect(ownerList.nodes[0]?.active_credential_id).toBeNull();
		expect(ownedNodeSummarySchema.parse(ownerList.nodes[0])).toEqual(ownerList.nodes[0]);

		const mutationAudit = await handle.db
			.select({
				action: auditLog.action,
				actorId: auditLog.actorId,
				resourceType: auditLog.resourceType,
				resourceId: auditLog.resourceId,
				requestId: auditLog.requestId,
				metadata: auditLog.metadata,
			})
			.from(auditLog)
			.where(eq(auditLog.actorId, owner.id))
			.orderBy(asc(auditLog.id));
		expect(mutationAudit.map((row) => row.action)).toEqual([
			"node.enroll",
			"workspace.register",
			"node.credential.rotate",
			"node.revoke",
		]);
		expect(mutationAudit.map((row) => row.requestId)).toEqual([
			"req_node_enroll",
			"req_workspace_register",
			"req_node_rotate",
			"req_node_revoke",
		]);
		expect(mutationAudit[0]).toMatchObject({
			resourceType: "node",
			resourceId: enrolled.node.node_id,
			metadata: { credential_id: enrolled.credential.id, name: "backend-mac" },
		});
		expect(mutationAudit[1]).toMatchObject({
			resourceType: "workspace_binding",
			resourceId: registered.body.workspace.workspace_binding_id,
			metadata: {
				node_id: enrolled.node.node_id,
				credential_id: enrolled.credential.id,
				alias: "backend-api",
			},
		});
		expect(mutationAudit[2]).toMatchObject({
			resourceType: "node",
			resourceId: enrolled.node.node_id,
			metadata: { credential_id: rotated.credential.id },
		});
		expect(mutationAudit[3]).toMatchObject({
			resourceType: "node",
			resourceId: enrolled.node.node_id,
		});
	});

	it("serializes workspace registration against Node revocation", async () => {
		const owner = await createAgent("alice");
		const enrolled = await enrollNode(owner.key);

		const [registerResponse, revokeResponse] = await Promise.all([
			app.request("/node/v1/workspaces", {
				method: "POST",
				headers: bearer(enrolled.credential.token),
				body: JSON.stringify({
					alias: "racing-workspace",
					repository_url: "https://github.com/acme/backend.git",
					allowed_base_refs: ["refs/heads/main"],
				}),
			}),
			app.request(`/agents/me/nodes/${enrolled.node.node_id}`, {
				method: "DELETE",
				headers: bearer(owner.key),
			}),
		]);

		expect(revokeResponse.status).toBe(204);
		expect([201, 401]).toContain(registerResponse.status);
		if (registerResponse.status === 401) {
			const body = (await registerResponse.json()) as ErrorResponse;
			expect(body.code).toBe("unauthenticated");
		}

		const activeCredentials = await handle.db
			.select({ id: nodeCredentials.id })
			.from(nodeCredentials)
			.where(
				and(eq(nodeCredentials.nodeId, enrolled.node.node_id), isNull(nodeCredentials.revokedAt)),
			);
		const activeWorkspaces = await handle.db
			.select({ id: workspaceBindings.id })
			.from(workspaceBindings)
			.where(
				and(
					eq(workspaceBindings.nodeId, enrolled.node.node_id),
					eq(workspaceBindings.status, "active"),
				),
			);
		expect(activeCredentials).toEqual([]);
		expect(activeWorkspaces).toEqual([]);

		await expectError(
			await app.request("/node/v1/workspaces", {
				method: "POST",
				headers: bearer(enrolled.credential.token),
				body: JSON.stringify({
					alias: "after-revocation",
					repository_url: "https://github.com/acme/backend.git",
					allowed_base_refs: ["refs/heads/main"],
				}),
			}),
			401,
			"unauthenticated",
		);
	});

	it("keeps revocation chronology valid when presence lands after the transaction begins", async () => {
		if (!TEST_DATABASE_URL) throw new Error("expected test database URL");
		const owner = await createAgent("alice");
		const enrolled = await enrollNode(owner.key);
		const lockSql = postgres(TEST_DATABASE_URL, {
			max: 1,
			onnotice: () => undefined,
		});
		const lockAcquired = deferred();
		const releaseLock = deferred();
		let revokeRequest: Promise<Response> | undefined;
		const blocker = lockSql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(
				hashtextextended(${`node:${enrolled.node.node_id}`}::text, 0)
			)`;
			lockAcquired.resolve();
			await releaseLock.promise;
		});

		try {
			await lockAcquired.promise;
			revokeRequest = app.request(`/agents/me/nodes/${enrolled.node.node_id}`, {
				method: "DELETE",
				headers: bearer(owner.key),
			});
			await waitUntil(async () => {
				const [row] = await handle.sql<Array<{ waiters: string }>>`
					SELECT count(*)::text AS waiters
					FROM pg_locks
					WHERE locktype = 'advisory' AND NOT granted
				`;
				return Number(row?.waiters ?? "0") > 0;
			}, "revocation did not wait on the Node lock");

			const presenceResponse = await app.request("/node/v1/me", {
				headers: bearer(enrolled.credential.token),
			});
			expect(presenceResponse.status).toBe(200);
			await waitUntil(async () => {
				const [row] = await handle.db
					.select({ lastSeenAt: nodes.lastSeenAt })
					.from(nodes)
					.where(eq(nodes.id, enrolled.node.node_id));
				return Boolean(row?.lastSeenAt);
			}, "Node presence did not persist");

			releaseLock.resolve();
			await blocker;
			const revokeResponse = await revokeRequest;
			expect(revokeResponse.status).toBe(204);

			const ownerListResponse = await app.request("/agents/me/nodes", {
				headers: bearer(owner.key),
			});
			expect(ownerListResponse.status).toBe(200);
			const ownerList = (await ownerListResponse.json()) as { nodes: OwnedNodeSummary[] };
			const summary = ownedNodeSummarySchema.parse(ownerList.nodes[0]);
			expect(summary.active_credential_id).toBeNull();
			const revoked = nodeDescriptorSchema.parse(summary.node);
			expect(revoked.status).toBe("revoked");
			expect(revoked.last_seen_at).not.toBeNull();
			expect(revoked.revoked_at).not.toBeNull();
			expect(Date.parse(revoked.last_seen_at ?? "")).toBeLessThanOrEqual(
				Date.parse(revoked.updated_at),
			);
			expect(Date.parse(revoked.revoked_at ?? "")).toBeLessThanOrEqual(
				Date.parse(revoked.updated_at),
			);
		} finally {
			releaseLock.resolve();
			await blocker.catch(() => undefined);
			await revokeRequest?.catch(() => undefined);
			await lockSql.end({ timeout: 2 });
		}
	});
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitUntil(
	condition: () => Promise<boolean>,
	message: string,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(message);
}
