import { createMissionCoordinatorState } from "@agentrelay/protocol";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/client.js";
import { RelayError } from "../errors.js";
import type { AppEnv } from "../types.js";
import { registerMissionOwnerRoutes } from "./mission-owner.js";
import { createNodeRoutes } from "./node.js";

const testState = vi.hoisted(() => ({
	agent: {
		id: "20000000-0000-4000-8000-000000000002",
		handle: "backend@agentrelay.test",
		email: "backend@agentrelay.test",
		role: "backend",
		status: "active",
		apiKeyId: "60000000-0000-4000-8000-000000000006",
	},
	node: {
		id: "10000000-0000-4000-8000-000000000001",
		agentId: "20000000-0000-4000-8000-000000000002",
		name: "test-node",
		status: "active",
		credentialId: "30000000-0000-4000-8000-000000000003",
	},
	services: {
		claimDelivery: vi.fn(),
		completeDelivery: vi.fn(),
		listAvailableDeliveryEvents: vi.fn(),
		listRecoverableDeliveryEvents: vi.fn(),
		releaseDelivery: vi.fn(),
		renewDelivery: vi.fn(),
		startDelivery: vi.fn(),
	},
	missionServices: {
		acceptMissionParticipant: vi.fn(),
		createMissionLedger: vi.fn(),
		getNodeMissionAssignment: vi.fn(),
		listNodeMissionAssignments: vi.fn(),
	},
}));

vi.mock("../auth/middleware.js", () => ({
	nodeBearerAuth:
		() =>
		async (context: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
			context.set("node", testState.node);
			await next();
		},
}));

vi.mock("../services/delivery-ledger.js", () => testState.services);
vi.mock("../services/mission-ledger.js", () => testState.missionServices);

const DELIVERY_ID = "40000000-0000-4000-8000-000000000004";
const LEASE_ID = "50000000-0000-4000-8000-000000000005";
const MISSION_ID = "70000000-0000-4000-8000-000000000007";
const PEER_AGENT_ID = "80000000-0000-4000-8000-000000000008";
const PEER_NODE_ID = "90000000-0000-4000-8000-000000000009";
const BACKEND_BINDING_ID = "a0000000-0000-4000-8000-00000000000a";
const PEER_BINDING_ID = "b0000000-0000-4000-8000-00000000000b";
const CONTRACT_ID = "c0000000-0000-4000-8000-00000000000c";
const REQUEST_ID = "req_delivery-route-test";
const db = {} as Database;

const CONTRACT = {
	artifact_id: CONTRACT_ID,
	type: "api_contract",
	version: 1,
	sha256: "a".repeat(64),
	media_type: "application/json",
	byte_size: 128,
};

const MISSION_CONFIG = {
	mission_context: {
		manifest: {
			schema_version: 1,
			mission_id: MISSION_ID,
			objective: "Ship one compatible backend and Android contract.",
			public_acceptance_criteria: ["Both repositories pass the contract fixture."],
			participants: [
				{
					agent_id: testState.agent.id,
					role: "backend",
					workspace_alias: "backend-api",
					repository_url: "https://github.com/acme/backend.git",
					expected_base_commit: "1".repeat(40),
					initial_assignment: "Implement the response contract.",
					requested_local_policy_profile: "bounded-code",
				},
				{
					agent_id: PEER_AGENT_ID,
					role: "android",
					workspace_alias: "android-app",
					repository_url: "https://github.com/acme/android.git",
					expected_base_commit: "2".repeat(40),
					initial_assignment: "Consume the response contract.",
					requested_local_policy_profile: "bounded-code",
				},
			],
			shared_contract: CONTRACT,
			max_turns: 12,
			max_wall_time_seconds: 3_600,
			token_budget: 100_000,
			expires_at: "2026-08-03T10:00:00.000Z",
			allowed_artifact_types: ["api_contract"],
			created_at: "2026-08-02T10:00:00.000Z",
		},
		created_by: { principal_id: testState.agent.id, kind: "agent" },
	},
	required_verification_commands: {
		[testState.agent.id]: ["backend-test"],
		[PEER_AGENT_ID]: ["android-test"],
	},
};

const MISSION_STATE = createMissionCoordinatorState(MISSION_CONFIG);
const ACCEPTANCE = {
	idempotency_key: "accept:backend",
	contract: CONTRACT,
	local_policy_grant: {
		profile_name: "bounded-code",
		grant_sha256: "b".repeat(64),
	},
};
const ACCEPTANCE_RECEIPT = {
	mission_id: MISSION_ID,
	participant_agent_id: testState.agent.id,
	...ACCEPTANCE,
	accepted_at: "2026-08-02T10:01:00.000Z",
};
const MISSION_ASSIGNMENT = {
	mission_id: MISSION_ID,
	coordinator_config: MISSION_CONFIG,
	coordinator_state: MISSION_STATE,
	participant_agent_id: testState.agent.id,
	workspace_binding_id: BACKEND_BINDING_ID,
	acceptance_status: "pending" as const,
	acceptance_receipt: null,
};

function buildApp(): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("requestId", REQUEST_ID);
		await next();
	});
	app.route("/", createNodeRoutes({ db, pepper: "p".repeat(32) }));
	app.onError((error, c) => {
		if (error instanceof RelayError) {
			return c.json(error.toEnvelope(c.get("requestId")), error.httpStatus as never);
		}
		throw error;
	});
	return app;
}

function buildMissionOwnerApp(): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("requestId", REQUEST_ID);
		c.set("agent", testState.agent);
		await next();
	});
	const router = new Hono<AppEnv>();
	registerMissionOwnerRoutes(router, { db });
	app.route("/agents", router);
	app.onError((error, c) => {
		if (error instanceof RelayError) {
			return c.json(error.toEnvelope(c.get("requestId")), error.httpStatus as never);
		}
		throw error;
	});
	return app;
}

function post(app: Hono<AppEnv>, path: string, body: unknown): Promise<Response> {
	return app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function expectedAuthContext() {
	return {
		nodeId: testState.node.id,
		agentId: testState.node.agentId,
		credentialId: testState.node.credentialId,
		requestId: REQUEST_ID,
	};
}

describe("Mission and delivery routes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		testState.services.listAvailableDeliveryEvents.mockResolvedValue({
			items: [],
			next_cursor: null,
		});
		testState.services.listRecoverableDeliveryEvents.mockResolvedValue({
			items: [],
			as_of: "2026-08-02T00:00:00.000Z",
		});
		testState.missionServices.listNodeMissionAssignments.mockResolvedValue([]);
	});

	it("parses cursor polling and recovery queries with protocol defaults", async () => {
		const app = buildApp();

		const available = await app.request("/deliveries?after_cursor=42&limit=7");
		expect(available.status).toBe(200);
		expect(testState.services.listAvailableDeliveryEvents).toHaveBeenCalledWith(db, {
			nodeId: testState.node.id,
			page: { after_cursor: "42", limit: 7 },
		});

		const recoverable = await app.request("/deliveries/recoverable");
		expect(recoverable.status).toBe(200);
		expect(testState.services.listRecoverableDeliveryEvents).toHaveBeenCalledWith(db, {
			nodeId: testState.node.id,
			page: { limit: 50 },
		});
	});

	it("returns 201 only for a fresh claim and forwards the full Node credential context", async () => {
		const app = buildApp();
		const input = { idempotency_key: "claim-1" };
		testState.services.claimDelivery
			.mockResolvedValueOnce({ outcome: "claimed", replayed: false })
			.mockResolvedValueOnce({ outcome: "claimed", replayed: true });

		const fresh = await post(app, `/deliveries/${DELIVERY_ID}/claim`, input);
		const replay = await post(app, `/deliveries/${DELIVERY_ID}/claim`, input);

		expect(fresh.status).toBe(201);
		expect(replay.status).toBe(200);
		expect(testState.services.claimDelivery).toHaveBeenNthCalledWith(
			1,
			db,
			expectedAuthContext(),
			DELIVERY_ID,
			input,
		);
	});

	it.each([
		{
			operation: "start",
			service: testState.services.startDelivery,
			input: {
				idempotency_key: "start-1",
				lease_id: LEASE_ID,
				fencing_token: "1",
			},
		},
		{
			operation: "renew",
			service: testState.services.renewDelivery,
			input: {
				idempotency_key: "renew-1",
				lease_id: LEASE_ID,
				fencing_token: "1",
			},
		},
		{
			operation: "complete",
			service: testState.services.completeDelivery,
			input: {
				idempotency_key: "complete-1",
				lease_id: LEASE_ID,
				fencing_token: "1",
				result: { type: "contract_acknowledged" },
			},
		},
		{
			operation: "release",
			service: testState.services.releaseDelivery,
			input: {
				idempotency_key: "release-1",
				lease_id: LEASE_ID,
				fencing_token: "1",
				classification: "transient",
				summary: "Retry after the local dependency recovers",
			},
		},
	])("validates and forwards $operation operations", async ({ operation, service, input }) => {
		const app = buildApp();
		const result = { operation, replayed: false };
		service.mockResolvedValue(result);

		const response = await post(app, `/deliveries/${DELIVERY_ID}/${operation}`, input);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(result);
		expect(service).toHaveBeenCalledWith(db, expectedAuthContext(), DELIVERY_ID, input);
	});

	it("returns protocol-validated Mission list and detail responses", async () => {
		const app = buildApp();
		testState.missionServices.listNodeMissionAssignments.mockResolvedValue([MISSION_ASSIGNMENT]);
		testState.missionServices.getNodeMissionAssignment.mockResolvedValue(MISSION_ASSIGNMENT);

		const list = await app.request("/missions?status=awaiting_acceptance&limit=7");
		expect(list.status).toBe(200);
		expect(await list.json()).toEqual({ missions: [MISSION_ASSIGNMENT] });
		expect(testState.missionServices.listNodeMissionAssignments).toHaveBeenCalledWith(db, {
			nodeId: testState.node.id,
			status: "awaiting_acceptance",
			limit: 7,
		});

		const detail = await app.request(`/missions/${MISSION_ID}`);
		expect(detail.status).toBe(200);
		expect(await detail.json()).toEqual({ mission: MISSION_ASSIGNMENT });
		expect(testState.missionServices.getNodeMissionAssignment).toHaveBeenCalledWith(db, {
			nodeId: testState.node.id,
			missionId: MISSION_ID,
		});
	});

	it("returns 201 only for fresh Mission acceptance and forwards Node credential context", async () => {
		const app = buildApp();
		testState.missionServices.acceptMissionParticipant
			.mockResolvedValueOnce({ receipt: ACCEPTANCE_RECEIPT, replayed: false })
			.mockResolvedValueOnce({ receipt: ACCEPTANCE_RECEIPT, replayed: true });

		const fresh = await post(app, `/missions/${MISSION_ID}/accept`, ACCEPTANCE);
		const replay = await post(app, `/missions/${MISSION_ID}/accept`, ACCEPTANCE);

		expect(fresh.status).toBe(201);
		expect(replay.status).toBe(200);
		expect(await fresh.json()).toEqual({ receipt: ACCEPTANCE_RECEIPT, replayed: false });
		expect(await replay.json()).toEqual({ receipt: ACCEPTANCE_RECEIPT, replayed: true });
		expect(testState.missionServices.acceptMissionParticipant).toHaveBeenNthCalledWith(1, db, {
			missionId: MISSION_ID,
			participantAgentId: testState.node.agentId,
			acceptance: ACCEPTANCE,
			requestId: REQUEST_ID,
			nodeAuth: expectedAuthContext(),
		});
	});

	it("rejects malformed Mission IDs, list queries, and strict acceptance bodies", async () => {
		const app = buildApp();

		const badDetailId = await app.request("/missions/not-a-uuid");
		const badAcceptId = await post(app, "/missions/not-a-uuid/accept", ACCEPTANCE);
		const badStatus = await app.request("/missions?status=not-a-status");
		const badLimit = await app.request("/missions?limit=not-a-number");
		const badBody = await post(app, `/missions/${MISSION_ID}/accept`, {
			...ACCEPTANCE,
			participant_agent_id: testState.node.agentId,
		});

		for (const response of [badDetailId, badAcceptId, badStatus, badLimit, badBody]) {
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ code: "invalid_params" });
		}
		expect(testState.missionServices.getNodeMissionAssignment).not.toHaveBeenCalled();
		expect(testState.missionServices.listNodeMissionAssignments).not.toHaveBeenCalled();
		expect(testState.missionServices.acceptMissionParticipant).not.toHaveBeenCalled();
	});

	it("strictly parses agent-authenticated Mission creation and returns 201 then 200", async () => {
		const app = buildMissionOwnerApp();
		const participantBindings = [
			{
				agentId: testState.agent.id,
				nodeId: testState.node.id,
				workspaceBindingId: BACKEND_BINDING_ID,
			},
			{
				agentId: PEER_AGENT_ID,
				nodeId: PEER_NODE_ID,
				workspaceBindingId: PEER_BINDING_ID,
			},
		];
		testState.missionServices.createMissionLedger
			.mockResolvedValueOnce({
				missionId: MISSION_ID,
				state: MISSION_STATE,
				participantBindings,
				replayed: false,
			})
			.mockResolvedValueOnce({
				missionId: MISSION_ID,
				state: MISSION_STATE,
				participantBindings,
				replayed: true,
			});

		const fresh = await post(app, "/agents/me/missions", MISSION_CONFIG);
		const replay = await post(app, "/agents/me/missions", MISSION_CONFIG);

		expect(fresh.status).toBe(201);
		expect(replay.status).toBe(200);
		expect(await fresh.json()).toEqual({
			mission_id: MISSION_ID,
			state: MISSION_STATE,
			participant_bindings: [
				{
					agent_id: testState.agent.id,
					node_id: testState.node.id,
					workspace_binding_id: BACKEND_BINDING_ID,
				},
				{
					agent_id: PEER_AGENT_ID,
					node_id: PEER_NODE_ID,
					workspace_binding_id: PEER_BINDING_ID,
				},
			],
			replayed: false,
		});
		expect((await replay.json()).replayed).toBe(true);
		expect(testState.missionServices.createMissionLedger).toHaveBeenNthCalledWith(1, db, {
			createdByAgentId: testState.agent.id,
			coordinatorConfig: MISSION_CONFIG,
			requestId: REQUEST_ID,
		});
	});

	it("rejects malformed and non-strict Mission creation bodies before dispatch", async () => {
		const app = buildMissionOwnerApp();
		const extraField = await post(app, "/agents/me/missions", {
			...MISSION_CONFIG,
			local_path: "/tmp/backend",
		});
		const malformed = await app.request("/agents/me/missions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		});

		for (const response of [extraField, malformed]) {
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ code: "invalid_params" });
		}
		expect(testState.missionServices.createMissionLedger).not.toHaveBeenCalled();
	});

	it("rejects malformed IDs, query values, and strict operation bodies before dispatch", async () => {
		const app = buildApp();
		const claim = { idempotency_key: "claim-invalid" };

		const badId = await post(app, "/deliveries/not-a-uuid/claim", claim);
		const badQuery = await app.request("/deliveries?limit=not-a-number");
		const badBody = await post(app, `/deliveries/${DELIVERY_ID}/claim`, {
			...claim,
			unexpected: true,
		});

		for (const response of [badId, badQuery, badBody]) {
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ code: "invalid_params" });
		}
		expect(testState.services.claimDelivery).not.toHaveBeenCalled();
		expect(testState.services.listAvailableDeliveryEvents).not.toHaveBeenCalled();
	});
});
