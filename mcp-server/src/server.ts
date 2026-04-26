/**
 * MCP server boot. Wires the stdio transport per `docs/lld.md` §3.2 and
 * registers the v0.1 tool surface (M2). When config or trust is missing,
 * tool calls return an instructive error instead of silently failing.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createA2AClient } from "./a2a-client.js";
import { type LoadConfigResult, unavailableMessage } from "./config.js";
import { logger } from "./logger.js";
import { registerTools } from "./tools/index.js";
import { FALLBACK_TRUST, loadTrust } from "./trust.js";

export interface ServerHandle {
	stop(): Promise<void>;
}

export async function startServer(opts: {
	configResult: LoadConfigResult;
}): Promise<ServerHandle> {
	const server = new Server(
		{ name: "agentrelay-mcp", version: "0.0.1" },
		{ capabilities: { tools: {} } },
	);

	if (opts.configResult.ok) {
		const cfg = opts.configResult.config;
		const client = createA2AClient({
			relayUrl: cfg.relay_url,
			apiKey: cfg.api_key,
		});

		const trustResult = await loadTrust();
		if (!trustResult.ok) {
			logger.warn(
				{ reason: trustResult.reason, path: trustResult.path },
				"trust.yaml unreadable — falling back to safe defaults",
			);
		} else if (trustResult.source === "fallback") {
			logger.info(
				{ path: trustResult.path },
				"no trust.yaml found — using safe defaults (every Edit/Write/Bash requires approval)",
			);
		}
		const trust = trustResult.ok ? trustResult.trust : FALLBACK_TRUST;

		registerTools(server, { client, trust, senderHandle: cfg.agent_handle });
		logger.info({ handle: cfg.agent_handle, relay: cfg.relay_url }, "agentrelay-mcp ready");
	} else {
		// No config → register a stub that explains how to fix it for every call.
		const reason = unavailableMessage(opts.configResult);
		logger.warn(
			{ reason: opts.configResult.reason, path: opts.configResult.path },
			"agentrelay config unavailable",
		);
		server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
		server.setRequestHandler(CallToolRequestSchema, async () => ({
			isError: true,
			content: [{ type: "text", text: reason }],
		}));
	}

	const transport = new StdioServerTransport();
	await server.connect(transport);

	return {
		async stop() {
			await server.close();
		},
	};
}
