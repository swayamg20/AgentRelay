/**
 * Public exports for the @agentrelay/mcp package. Consumers (the bin
 * scripts and tests) import from here.
 */

export { wrap, wrapAsMcpText } from "./provenance.js";
export { loadConfig, resolveConfigPath, unavailableMessage } from "./config.js";
export type { AgentRelayConfig, LoadConfigResult } from "./config.js";
export { createA2AClient, A2AHttpError, A2ARpcError } from "./a2a-client.js";
export type { A2AClient, A2AClientOptions, RequestOptions } from "./a2a-client.js";
export { startServer } from "./server.js";
export { logger } from "./logger.js";
export {
	loadTrust,
	resolveTrustPath,
	computeOverlay,
	isPathAutoWritable,
	FALLBACK_TRUST,
} from "./trust.js";
export type { TrustFile, TrustOverlay, OverlayDecision, LoadTrustResult } from "./trust.js";
