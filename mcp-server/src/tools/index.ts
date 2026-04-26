/**
 * Registers the six v0.1 MCP tools on a Server instance. Wired from
 * `server.ts` once config is loaded. Each tool:
 *
 * - validates input via the schemas in `./schemas.ts`,
 * - delegates to its handler in `./<tool>.ts`,
 * - maps relay errors to MCP tool errors via `./errors.ts`.
 *
 * The accept_handoff tool is the only one that touches the trust loader;
 * the others are pure relay relays.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { A2AClient } from "../a2a-client.js";
import { logger } from "../logger.js";
import type { TrustFile } from "../trust.js";
import { acceptHandoff, HandoffRejectedByTrustError } from "./accept.js";
import { checkInbox } from "./inbox.js";
import { completeHandoff } from "./complete.js";
import { relayErrorToTool } from "./errors.js";
import { handoffToTeammate } from "./handoff.js";
import { listTeammates } from "./list-teammates.js";
import { sendMessage } from "./message.js";

export interface ToolDeps {
	client: A2AClient;
	trust: TrustFile;
	senderHandle: string;
}

const TOOL_DEFS = [
	{
		name: "handoff_to_teammate",
		description: "Package and send a handoff (a structured task transfer) to another teammate's agent via AgentRelay.",
	},
	{
		name: "check_inbox",
		description: "List handoffs awaiting your attention. Defaults to pending+accepted threads.",
	},
	{
		name: "accept_handoff",
		description:
			"Pull a teammate's handoff into the current session. Returns the thread with provenance-wrapped content and the per-teammate trust overlay.",
	},
	{
		name: "send_message",
		description: "Append a message to an existing handoff thread.",
	},
	{
		name: "complete_handoff",
		description: "Mark a handoff complete with a result summary.",
	},
	{
		name: "list_teammates",
		description: "Discover teammates registered on this relay. Filter by role, skill, or owned repo.",
	},
] as const;

const TOOL_INPUT_SCHEMAS = {
	handoff_to_teammate: {
		type: "object",
		additionalProperties: true,
		properties: {
			to: { type: "string", description: "recipient handle, e.g. frank@acme" },
			intent: { type: "string", enum: ["inform", "ask_question", "propose_action"] },
			summary: { type: "string" },
			artifacts: { type: "array" },
			question: { type: "string" },
			proposed_action: { type: "object" },
			metadata: { type: "object" },
		},
		required: ["to", "intent", "summary"],
	},
	check_inbox: {
		type: "object",
		additionalProperties: false,
		properties: {
			status: { type: "array", items: { type: "string" } },
			since: { type: "string" },
			limit: { type: "number" },
		},
	},
	accept_handoff: {
		type: "object",
		additionalProperties: false,
		properties: {
			thread_id: { type: "string" },
			session_id: { type: "string" },
		},
		required: ["thread_id"],
	},
	send_message: {
		type: "object",
		additionalProperties: false,
		properties: {
			thread_id: { type: "string" },
			body: { type: "string" },
			payload: { type: "object" },
		},
		required: ["thread_id", "body"],
	},
	complete_handoff: {
		type: "object",
		additionalProperties: false,
		properties: {
			thread_id: { type: "string" },
			result_summary: { type: "string" },
			artifacts: { type: "array" },
		},
		required: ["thread_id", "result_summary"],
	},
	list_teammates: {
		type: "object",
		additionalProperties: false,
		properties: {
			role: { type: "string" },
			skill: { type: "string" },
			repo: { type: "string" },
		},
	},
} as const;

export type ToolName = keyof typeof TOOL_INPUT_SCHEMAS;

export async function dispatchTool(
	deps: ToolDeps,
	name: string,
	input: unknown,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
	try {
		switch (name) {
			case "handoff_to_teammate": {
				const r = await handoffToTeammate({ client: deps.client, senderHandle: deps.senderHandle }, input);
				return jsonOk(r);
			}
			case "check_inbox": {
				const r = await checkInbox(deps.client, input);
				return jsonOk(r);
			}
			case "accept_handoff": {
				const r = await acceptHandoff({ client: deps.client, trust: deps.trust }, input);
				return jsonOk(r);
			}
			case "send_message": {
				const r = await sendMessage(deps.client, input);
				return jsonOk(r);
			}
			case "complete_handoff": {
				const r = await completeHandoff(deps.client, input);
				return jsonOk(r);
			}
			case "list_teammates": {
				const r = await listTeammates(deps.client, input);
				return jsonOk(r);
			}
			default:
				return {
					isError: true,
					content: [{ type: "text", text: `code: method_not_found\nUnknown tool '${name}'` }],
				};
		}
	} catch (err) {
		if (err instanceof z.ZodError) {
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: `code: invalid_params\n${err.issues
							.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
							.join("\n")}`,
					},
				],
			};
		}
		if (err instanceof HandoffRejectedByTrustError) {
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: `code: teammate_blocked\nLayer 3 trust policy rejected this handoff: ${err.decision.reason}.`,
					},
				],
			};
		}
		logger.error({ err }, "tool dispatch error");
		return relayErrorToTool(err);
	}
}

export function registerTools(server: Server, deps: ToolDeps): void {
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: TOOL_DEFS.map((d) => ({
			name: d.name,
			description: d.description,
			inputSchema: TOOL_INPUT_SCHEMAS[d.name],
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		return dispatchTool(deps, req.params.name, req.params.arguments ?? {});
	});
}

function jsonOk(payload: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
	};
}
