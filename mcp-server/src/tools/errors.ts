/**
 * Maps relay JSON-RPC error codes (lld.md §3.5) onto human-readable strings
 * surfaced as MCP tool errors. The MCP SDK doesn't have a structured error
 * code field for tool results, so we render a stable `code: <symbol>` prefix
 * the agent can pattern-match on.
 */

import { A2AHttpError, A2ARpcError } from "../a2a-client.js";

const CODE_TO_SYMBOL: Record<number, string> = {
	[-32700]: "parse_error",
	[-32600]: "invalid_request",
	[-32601]: "method_not_found",
	[-32602]: "invalid_params",
	[-32001]: "unauthenticated",
	[-32002]: "forbidden",
	[-32003]: "rate_limited",
	[-32004]: "recipient_not_found",
	[-32005]: "not_a_participant",
	[-32006]: "thread_not_found",
	[-32007]: "thread_terminal",
	[-32008]: "invalid_transition",
	[-32009]: "not_authorized_transition",
	[-32010]: "state_changed",
	[-32011]: "duplicate_idempotency_key",
	[-32012]: "invalid_intent_payload",
	[-32013]: "teammate_blocked",
	[-32099]: "internal",
};

export interface ToolErrorBody {
	content: { type: "text"; text: string }[];
	isError: true;
}

export function relayErrorToTool(err: unknown): ToolErrorBody {
	if (err instanceof A2ARpcError) {
		const symbol = CODE_TO_SYMBOL[err.rpc.code] ?? "rpc_error";
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: `code: ${symbol} (${err.rpc.code})\n${err.rpc.message}`,
				},
			],
		};
	}
	if (err instanceof A2AHttpError) {
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: `code: http_${err.status}\n${err.body.slice(0, 500)}`,
				},
			],
		};
	}
	const msg = err instanceof Error ? err.message : String(err);
	return {
		isError: true,
		content: [{ type: "text", text: `code: internal\n${msg}` }],
	};
}

export function symbolForCode(code: number): string | undefined {
	return CODE_TO_SYMBOL[code];
}
