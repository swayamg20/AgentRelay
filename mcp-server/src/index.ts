/**
 * Public exports for the agentrelay-mcp package. Consumers (the bin
 * scripts and tests) import from here.
 */

export { markTeammateValue, wrap, wrapAsMcpText } from "./provenance.js";
export type { ProvenanceMarked, TeammateProvenance } from "./provenance.js";
export { loadConfig, resolveConfigPath, unavailableMessage } from "./config.js";
export type { AgentRelayConfig, LoadConfigResult } from "./config.js";
export { bindCodex, unbindCodex } from "./connector/binding.js";
export type { CodexConnectorBinding } from "./connector/binding.js";
export { createCodexAttentionAdapter, buildCodexAttentionPrompt } from "./connector/codex.js";
export {
	MailboxEventHttpError,
	consumeSse,
	createMailboxEventClient,
} from "./connector/event-client.js";
export type {
	MailboxEvent,
	MailboxEventClient,
	MailboxEventPage,
	MailboxLiveSignal,
} from "./connector/event-client.js";
export { ConnectorLockError, acquireConnectorLock } from "./connector/lock.js";
export type {
	AcquireConnectorLockOptions,
	ConnectorProcessLock,
} from "./connector/lock.js";
export { planAutoPickup } from "./connector/pickup.js";
export type { MailboxAttentionReference } from "./connector/pickup.js";
export {
	DEFAULT_PICKUP_COALESCE_MS,
	connectorCursor,
	connectorPickupDecision,
	connectorPickupKey,
	connectorStreamKey,
	loadConnectorState,
	persistConnectorCursor,
	persistConnectorProgress,
} from "./connector/state.js";
export type {
	ConnectorPickupDecision,
	ConnectorPickupReference,
	ConnectorState,
} from "./connector/state.js";
export type {
	RuntimeAttentionAdapter,
	RuntimeAttentionReceipt,
	RuntimeAttentionRequest,
} from "./connector/runtime.js";
export { runMailboxWatch, watchConfiguredCodex } from "./connector/watch.js";
export type { MailboxWatchOptions, MailboxWatchStatus } from "./connector/watch.js";
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
