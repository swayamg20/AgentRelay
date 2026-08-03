import { workspaceRegistrationInputSchema } from "@agentrelay/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthenticatedNode, nodeBearerAuth } from "../auth/middleware.js";
import type { Database } from "../db/client.js";
import { RelayError } from "../errors.js";
import {
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
