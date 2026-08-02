import {
	deliveryClaimInputSchema,
	deliveryCompleteInputSchema,
	deliveryReleaseInputSchema,
	deliveryRenewInputSchema,
	deliveryStartInputSchema,
	missionParticipantAcceptanceInputSchema,
	nodeMissionAssignmentListRequestSchema,
	nodeMissionAssignmentListSchema,
	nodeMissionAssignmentSchema,
	recoverableMissionDeliveryPageRequestSchema,
	storedDeliveryCursorPageRequestSchema,
	uuidSchema,
	workspaceRegistrationInputSchema,
} from "@agentrelay/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthenticatedNode, nodeBearerAuth } from "../auth/middleware.js";
import type { Database } from "../db/client.js";
import { RelayError } from "../errors.js";
import {
	claimDelivery,
	completeDelivery,
	listAvailableDeliveryEvents,
	listRecoverableDeliveryEvents,
	releaseDelivery,
	renewDelivery,
	startDelivery,
} from "../services/delivery-ledger.js";
import {
	acceptMissionParticipant,
	getNodeMissionAssignment,
	listNodeMissionAssignments,
} from "../services/mission-ledger.js";
import {
	type NodeCredentialContext,
	getNode,
	listWorkspaces,
	registerWorkspace,
	revokeWorkspace,
} from "../services/node-enrollment.js";
import type { AppEnv } from "../types.js";

const workspaceAliasParamSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
	.refine((value) => value !== "." && value !== "..", "Alias cannot be a path segment");

export interface NodeRoutesOptions {
	db: Database;
	pepper: string;
}

export function createNodeRoutes(opts: NodeRoutesOptions): Hono<AppEnv> {
	const router = new Hono<AppEnv>();
	router.use("*", nodeBearerAuth({ db: opts.db, pepper: opts.pepper }));

	router.get("/me", async (c) => {
		const node = requireNode(c.get("node"));
		return c.json({ node: await getNode(opts.db, node.id, node.agentId) });
	});

	router.post("/workspaces", async (c) => {
		const node = requireNode(c.get("node"));
		const body = await c.req.json().catch(() => null);
		const parsed = workspaceRegistrationInputSchema.safeParse(body);
		if (!parsed.success) {
			throw new RelayError("invalid_params", "Invalid workspace registration payload", {
				issues: parsed.error.issues,
			});
		}

		const result = await registerWorkspace(
			opts.db,
			{
				nodeId: node.id,
				agentId: node.agentId,
				credentialId: node.credentialId,
				requestId: c.get("requestId"),
			},
			parsed.data,
		);
		return c.json(result, result.replayed ? 200 : 201);
	});

	router.get("/workspaces", async (c) => {
		const node = requireNode(c.get("node"));
		return c.json({ workspaces: await listWorkspaces(opts.db, node.id, node.agentId) });
	});

	router.delete("/workspaces/:alias", async (c) => {
		const node = requireNode(c.get("node"));
		const alias = parseWorkspaceAlias(c.req.param("alias"));
		await revokeWorkspace(
			opts.db,
			{
				nodeId: node.id,
				agentId: node.agentId,
				credentialId: node.credentialId,
				requestId: c.get("requestId"),
			},
			alias,
		);
		return c.body(null, 204);
	});

	router.get("/deliveries", async (c) => {
		const node = requireNode(c.get("node"));
		const page = parseProtocolInput(
			storedDeliveryCursorPageRequestSchema,
			{
				after_cursor: c.req.query("after_cursor"),
				limit: queryNumber(c.req.query("limit")),
			},
			"Invalid delivery list query",
		);
		return c.json(await listAvailableDeliveryEvents(opts.db, { nodeId: node.id, page }));
	});

	router.get("/deliveries/recoverable", async (c) => {
		const node = requireNode(c.get("node"));
		const page = parseProtocolInput(
			recoverableMissionDeliveryPageRequestSchema,
			{ limit: queryNumber(c.req.query("limit")) },
			"Invalid recoverable delivery list query",
		);
		return c.json(await listRecoverableDeliveryEvents(opts.db, { nodeId: node.id, page }));
	});

	router.post("/deliveries/:deliveryId/claim", async (c) => {
		const node = requireNode(c.get("node"));
		const deliveryId = parseUuid(c.req.param("deliveryId"), "delivery ID");
		const input = parseProtocolInput(
			deliveryClaimInputSchema,
			await c.req.json().catch(() => null),
			"Invalid delivery claim payload",
		);
		const result = await claimDelivery(
			opts.db,
			toNodeCredentialContext(node, c.get("requestId")),
			deliveryId,
			input,
		);
		return c.json(result, result.replayed ? 200 : 201);
	});

	router.post("/deliveries/:deliveryId/start", async (c) => {
		const node = requireNode(c.get("node"));
		const deliveryId = parseUuid(c.req.param("deliveryId"), "delivery ID");
		const input = parseProtocolInput(
			deliveryStartInputSchema,
			await c.req.json().catch(() => null),
			"Invalid delivery start payload",
		);
		return c.json(
			await startDelivery(
				opts.db,
				toNodeCredentialContext(node, c.get("requestId")),
				deliveryId,
				input,
			),
		);
	});

	router.post("/deliveries/:deliveryId/renew", async (c) => {
		const node = requireNode(c.get("node"));
		const deliveryId = parseUuid(c.req.param("deliveryId"), "delivery ID");
		const input = parseProtocolInput(
			deliveryRenewInputSchema,
			await c.req.json().catch(() => null),
			"Invalid delivery renewal payload",
		);
		return c.json(
			await renewDelivery(
				opts.db,
				toNodeCredentialContext(node, c.get("requestId")),
				deliveryId,
				input,
			),
		);
	});

	router.post("/deliveries/:deliveryId/complete", async (c) => {
		const node = requireNode(c.get("node"));
		const deliveryId = parseUuid(c.req.param("deliveryId"), "delivery ID");
		const input = parseProtocolInput(
			deliveryCompleteInputSchema,
			await c.req.json().catch(() => null),
			"Invalid delivery completion payload",
		);
		return c.json(
			await completeDelivery(
				opts.db,
				toNodeCredentialContext(node, c.get("requestId")),
				deliveryId,
				input,
			),
		);
	});

	router.post("/deliveries/:deliveryId/release", async (c) => {
		const node = requireNode(c.get("node"));
		const deliveryId = parseUuid(c.req.param("deliveryId"), "delivery ID");
		const input = parseProtocolInput(
			deliveryReleaseInputSchema,
			await c.req.json().catch(() => null),
			"Invalid delivery release payload",
		);
		return c.json(
			await releaseDelivery(
				opts.db,
				toNodeCredentialContext(node, c.get("requestId")),
				deliveryId,
				input,
			),
		);
	});

	router.get("/missions", async (c) => {
		const node = requireNode(c.get("node"));
		const parsed = parseProtocolInput(
			nodeMissionAssignmentListRequestSchema,
			{
				status: c.req.query("status"),
				limit: queryNumber(c.req.query("limit")),
			},
			"Invalid Mission list query",
		);
		const assignments = await listNodeMissionAssignments(opts.db, {
			nodeId: node.id,
			...parsed,
		});
		return c.json(nodeMissionAssignmentListSchema.parse({ missions: assignments }));
	});

	router.get("/missions/:missionId", async (c) => {
		const node = requireNode(c.get("node"));
		const missionId = parseUuid(c.req.param("missionId"), "Mission ID");
		const assignment = await getNodeMissionAssignment(opts.db, {
			nodeId: node.id,
			missionId,
		});
		return c.json({ mission: nodeMissionAssignmentSchema.parse(assignment) });
	});

	router.post("/missions/:missionId/accept", async (c) => {
		const node = requireNode(c.get("node"));
		const missionId = parseUuid(c.req.param("missionId"), "Mission ID");
		const body = await c.req.json().catch(() => null);
		const parsed = missionParticipantAcceptanceInputSchema.safeParse(body);
		if (!parsed.success) {
			throw new RelayError("invalid_params", "Invalid Mission acceptance payload", {
				issues: parsed.error.issues,
			});
		}
		const result = await acceptMissionParticipant(opts.db, {
			missionId,
			participantAgentId: node.agentId,
			acceptance: parsed.data,
			requestId: c.get("requestId"),
			nodeAuth: {
				nodeId: node.id,
				agentId: node.agentId,
				credentialId: node.credentialId,
				requestId: c.get("requestId"),
			},
		});
		return c.json(result, result.replayed ? 200 : 201);
	});

	return router;
}

function requireNode(node: AuthenticatedNode | undefined): AuthenticatedNode {
	if (!node) throw new RelayError("unauthenticated", "Node auth required");
	return node;
}

function parseWorkspaceAlias(value: string): string {
	const parsed = workspaceAliasParamSchema.safeParse(value);
	if (!parsed.success) {
		throw new RelayError("invalid_params", "Invalid workspace alias", {
			issues: parsed.error.issues,
		});
	}
	return parsed.data;
}

function parseUuid(value: string, label: string): string {
	const parsed = uuidSchema.safeParse(value);
	if (!parsed.success) {
		throw new RelayError("invalid_params", `Invalid ${label}`, { issues: parsed.error.issues });
	}
	return parsed.data;
}

function parseProtocolInput<TSchema extends z.ZodTypeAny>(
	schema: TSchema,
	value: unknown,
	message: string,
): z.output<TSchema> {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new RelayError("invalid_params", message, { issues: parsed.error.issues });
	}
	return parsed.data;
}

function queryNumber(value: string | undefined): number | undefined {
	return value === undefined ? undefined : Number(value);
}

function toNodeCredentialContext(
	node: AuthenticatedNode,
	requestId: string,
): NodeCredentialContext {
	return {
		nodeId: node.id,
		agentId: node.agentId,
		credentialId: node.credentialId,
		requestId,
	};
}
