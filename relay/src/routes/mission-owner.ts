import { missionCoordinatorConfigSchema, missionCreationResultSchema } from "@agentrelay/protocol";
import type { Hono } from "hono";
import type { AuthenticatedAgent } from "../auth/middleware.js";
import type { Database } from "../db/client.js";
import { RelayError } from "../errors.js";
import { createMissionLedger } from "../services/mission-ledger.js";
import type { AppEnv } from "../types.js";

export interface MissionOwnerRoutesOptions {
	readonly db: Database;
}

export function registerMissionOwnerRoutes(
	router: Hono<AppEnv>,
	opts: MissionOwnerRoutesOptions,
): void {
	router.post("/me/missions", async (c) => {
		const agent = requireAgent(c.get("agent"));
		const body = await c.req.json().catch(() => null);
		const parsed = missionCoordinatorConfigSchema.safeParse(body);
		if (!parsed.success) {
			throw new RelayError("invalid_params", "Invalid Mission creation payload", {
				issues: parsed.error.issues,
			});
		}

		const result = await createMissionLedger(opts.db, {
			createdByAgentId: agent.id,
			coordinatorConfig: parsed.data,
			requestId: c.get("requestId"),
		});
		const response = missionCreationResultSchema.parse({
			mission_id: result.missionId,
			state: result.state,
			participant_bindings: result.participantBindings.map((binding) => ({
				agent_id: binding.agentId,
				node_id: binding.nodeId,
				workspace_binding_id: binding.workspaceBindingId,
			})),
			replayed: result.replayed,
		});
		return c.json(response, result.replayed ? 200 : 201);
	});
}

function requireAgent(agent: AuthenticatedAgent | undefined): AuthenticatedAgent {
	if (!agent) throw new RelayError("unauthenticated", "Auth required");
	return agent;
}
