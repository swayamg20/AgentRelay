import pino from "pino";

const level = process.env.AGENTRELAY_LOG_LEVEL ?? "info";

/**
 * Shared pino logger. Writes structured JSON to stderr so it never collides
 * with the stdio MCP transport on stdout.
 */
export const logger = pino(
	{
		level,
		base: { component: "agentrelay-mcp" },
	},
	pino.destination(2),
);
