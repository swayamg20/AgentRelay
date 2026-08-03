import {
	nodeCredentialRotationInputSchema,
	nodeCredentialRotationResultSchema,
	nodeEnrollmentInputSchema,
	nodeEnrollmentResultSchema,
	ownedNodeListSchema,
	uuidSchema,
} from "@agentrelay/protocol";
import type { Hono } from "hono";
import type { AuthenticatedAgent } from "../auth/middleware.js";
import type { Database } from "../db/client.js";
import { RelayError } from "../errors.js";
import {
	enrollNode,
	listNodes,
	revokeNode,
	rotateNodeCredential,
} from "../services/node-enrollment.js";
import type { AppEnv } from "../types.js";

export interface NodeOwnerRoutesOptions {
	db: Database;
	pepper: string;
	keyEnvironment: "live" | "test";
}

export function registerNodeOwnerRoutes(router: Hono<AppEnv>, opts: NodeOwnerRoutesOptions): void {
	router.post("/me/nodes", async (c) => {
		const agent = requireAgent(c.get("agent"));
		const body = await c.req.json().catch(() => null);
		const parsed = nodeEnrollmentInputSchema.safeParse(body);
		if (!parsed.success) {
			throw new RelayError("invalid_params", "Invalid Node enrollment payload", {
				issues: parsed.error.issues,
			});
		}

		const result = await enrollNode(
			opts.db,
			agent.id,
			parsed.data,
			opts.keyEnvironment,
			opts.pepper,
			{ requestId: c.get("requestId") },
		);
		return c.json(nodeEnrollmentResultSchema.parse(result), 201);
	});

	router.get("/me/nodes", async (c) => {
		const agent = requireAgent(c.get("agent"));
		return c.json(ownedNodeListSchema.parse({ nodes: await listNodes(opts.db, agent.id) }));
	});

	router.post("/me/nodes/:nodeId/credentials/rotate", async (c) => {
		const agent = requireAgent(c.get("agent"));
		const nodeId = parseNodeId(c.req.param("nodeId"));
		const body = await c.req.json().catch(() => null);
		const parsed = nodeCredentialRotationInputSchema.safeParse(body);
		if (!parsed.success) {
			throw new RelayError("invalid_params", "Invalid Node credential rotation payload", {
				issues: parsed.error.issues,
			});
		}
		const credential = await rotateNodeCredential(
			opts.db,
			agent.id,
			nodeId,
			parsed.data,
			opts.keyEnvironment,
			opts.pepper,
			{ requestId: c.get("requestId") },
		);
		return c.json(nodeCredentialRotationResultSchema.parse({ node_id: nodeId, credential }));
	});

	router.delete("/me/nodes/:nodeId", async (c) => {
		const agent = requireAgent(c.get("agent"));
		const nodeId = parseNodeId(c.req.param("nodeId"));
		await revokeNode(opts.db, agent.id, nodeId, { requestId: c.get("requestId") });
		return c.body(null, 204);
	});
}

function requireAgent(agent: AuthenticatedAgent | undefined): AuthenticatedAgent {
	if (!agent) throw new RelayError("unauthenticated", "Auth required");
	return agent;
}

function parseNodeId(value: string): string {
	const parsed = uuidSchema.safeParse(value);
	if (!parsed.success) {
		throw new RelayError("invalid_params", "Invalid Node ID", {
			issues: parsed.error.issues,
		});
	}
	return parsed.data;
}
