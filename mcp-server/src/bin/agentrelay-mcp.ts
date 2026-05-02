#!/usr/bin/env node
/**
 * Entry point for the `agentrelay-mcp` binary. Boots the stdio MCP server.
 */

import { logger } from "../logger.js";
import { CLI_MISUSE_HINT, isCliMisuse } from "./argv-guard.js";
import { DEPRECATION_NOTICE, shouldEmitDeprecationNotice } from "./deprecation-notice.js";
import { runMcpServer } from "./run-mcp.js";

async function main(): Promise<void> {
	if (isCliMisuse(process.argv[2])) {
		process.stderr.write(CLI_MISUSE_HINT);
		process.exit(2);
	}

	if (shouldEmitDeprecationNotice(process.env, process.stdin.isTTY === true)) {
		process.stderr.write(DEPRECATION_NOTICE);
	}

	await runMcpServer();
}

main().catch((err) => {
	logger.fatal({ err }, "fatal startup error");
	process.exit(1);
});
