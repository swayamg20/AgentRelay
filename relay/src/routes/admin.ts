import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type KeyEnvironment, generateKey } from "../auth/keys.js";
import { adminAuth } from "../auth/middleware.js";
import type { Database } from "../db/client.js";
import { agents, apiKeys, nodeCredentials, nodes, workspaceBindings } from "../db/schema.js";
import { RelayError } from "../errors.js";
import { registerAgentWithInitialKey } from "../services/agent-registration.js";
import { writeAudit } from "../services/audit.js";
import { cancelDeliveriesForNodeRevocations } from "../services/delivery-revocation.js";
import { lockAgentLifecycle, lockNodeMutation } from "../services/node-enrollment.js";
import type { AppEnv } from "../types.js";

const handleRegex = /^[a-z0-9._-]+@[a-z0-9.-]+$/;

const createAgentSchema = z.object({
	handle: z.string().min(1).max(120).regex(handleRegex, "handle must look like name@team"),
	email: z.string().email().max(254),
	display_name: z.string().min(1).max(120),
	role: z.string().min(1).max(60),
});

const handleParamSchema = z.object({ id: z.string().uuid() });

export interface AdminRoutesOptions {
	db: Database;
	adminToken: string;
	pepper: string;
	keyEnvironment: KeyEnvironment;
}

export function createAdminRoutes(opts: AdminRoutesOptions): Hono<AppEnv> {
	const router = new Hono<AppEnv>();
	router.use("*", adminAuth({ adminToken: opts.adminToken }));

	// POST /admin/agents — register a new agent + return one-time API key.
	router.post("/agents", async (c) => {
		const body = await c.req.json().catch(() => null);
		const parsed = createAgentSchema.safeParse(body);
		if (!parsed.success) {
			throw new RelayError("invalid_params", "Invalid agent payload", {
				issues: parsed.error.issues,
			});
		}
		const input = parsed.data;

		const result = await opts.db.transaction(async (tx) =>
			registerAgentWithInitialKey(tx, {
				handle: input.handle,
				email: input.email,
				role: input.role,
				displayName: input.display_name,
				pepper: opts.pepper,
				keyEnvironment: opts.keyEnvironment,
			}),
		);

		return c.json(
			{
				agent_id: result.agent.id,
				handle: result.agent.handle,
				api_key: result.apiKey,
			},
			201,
		);
	});

	// POST /admin/agents/:id/keys/rotate
	router.post("/agents/:id/keys/rotate", async (c) => {
		const params = handleParamSchema.safeParse(c.req.param());
		if (!params.success) {
			throw new RelayError("invalid_params", "Invalid agent id");
		}
		const agentId = params.data.id;
		const generated = generateKey(opts.keyEnvironment, opts.pepper);

		const newKey = await opts.db.transaction(async (tx) => {
			await lockAgentLifecycle(tx, agentId);
			const [agent] = await tx
				.select({ id: agents.id, status: agents.status })
				.from(agents)
				.where(eq(agents.id, agentId));
			if (!agent) throw new RelayError("recipient_not_found", "Agent not found");
			if (agent.status !== "active") {
				throw new RelayError("invalid_transition", "Cannot rotate keys for a disabled agent");
			}

			// revoke all currently-active keys atomically
			await tx.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.agentId, agentId));

			const [created] = await tx
				.insert(apiKeys)
				.values({
					agentId,
					keyHash: generated.hash,
					salt: generated.salt,
					label: "rotated",
				})
				.returning();
			if (!created) throw new RelayError("internal", "Failed to issue rotated key");
			return created;
		});

		return c.json({
			agent_id: agentId,
			api_key: generated.raw,
			key_id: newKey.id,
		});
	});

	// DELETE /admin/agents/:id — soft delete
	router.delete("/agents/:id", async (c) => {
		const params = handleParamSchema.safeParse(c.req.param());
		if (!params.success) {
			throw new RelayError("invalid_params", "Invalid agent id");
		}
		const agentId = params.data.id;
		await opts.db.transaction(async (tx) => {
			await lockAgentLifecycle(tx, agentId);
			const [agent] = await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId));
			if (!agent) throw new RelayError("recipient_not_found", "Agent not found");

			const ownedNodes = await tx
				.select({ id: nodes.id })
				.from(nodes)
				.where(eq(nodes.agentId, agentId))
				.orderBy(asc(nodes.id));
			for (const node of ownedNodes) await lockNodeMutation(tx, node.id);

			const nodeIds = ownedNodes.map((node) => node.id);
			if (nodeIds.length > 0) {
				await cancelDeliveriesForNodeRevocations(tx, {
					nodeIds,
					actorKind: "admin",
					actorId: null,
					targetAgentId: agentId,
					requestId: c.get("requestId"),
				});
				await tx
					.update(nodeCredentials)
					.set({ revokedAt: sql`clock_timestamp()` })
					.where(and(inArray(nodeCredentials.nodeId, nodeIds), isNull(nodeCredentials.revokedAt)));
				await tx
					.update(workspaceBindings)
					.set({ status: "revoked", revokedAt: sql`clock_timestamp()` })
					.where(
						and(inArray(workspaceBindings.nodeId, nodeIds), eq(workspaceBindings.status, "active")),
					);
				await tx
					.update(nodes)
					.set({ status: "revoked", revokedAt: sql`clock_timestamp()` })
					.where(and(inArray(nodes.id, nodeIds), eq(nodes.status, "active")));
			}
			await tx.update(agents).set({ status: "disabled" }).where(eq(agents.id, agentId));
			await tx
				.update(apiKeys)
				.set({ revokedAt: sql`clock_timestamp()` })
				.where(and(eq(apiKeys.agentId, agentId), isNull(apiKeys.revokedAt)));
			await writeAudit(tx, {
				actorKind: "admin",
				actorId: null,
				action: "agent.disable",
				resourceType: "agent",
				resourceId: agentId,
				requestId: c.get("requestId"),
				metadata: {
					target_agent_id: agentId,
					revoked_node_ids: nodeIds,
				},
			});
		});
		return c.body(null, 204);
	});

	return router;
}
