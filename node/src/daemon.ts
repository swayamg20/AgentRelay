import { setTimeout as delay } from "node:timers/promises";
import type { AgentHostAdapter } from "@agentrelay/protocol";
import type { NodeConfig } from "./config.js";
import { DeliveryProcessor } from "./delivery-processor.js";
import type { NodeJournal } from "./journal.js";
import { acceptPendingMissions, verifyNodeIdentityAndWorkspaces } from "./mission-acceptance.js";
import type { NodeRelayClient } from "./relay-client.js";
import type { RuntimeAuthorityPort } from "./runtime-authority-port.js";

export interface NodeLog {
	info(fields: Record<string, unknown>, message: string): void;
	warn(fields: Record<string, unknown>, message: string): void;
	error(fields: Record<string, unknown>, message: string): void;
}

export interface ForegroundNodeOptions {
	readonly config: NodeConfig;
	readonly client: NodeRelayClient;
	readonly journal: NodeJournal;
	readonly adapter: AgentHostAdapter;
	readonly authorityPort?: RuntimeAuthorityPort;
	readonly pollIntervalMs?: number;
	readonly logger?: NodeLog;
}

export interface NodeCycleResult {
	readonly acceptedMissions: number;
	readonly recoveredDeliveries: number;
	readonly discoveredDeliveries: number;
	readonly processedDeliveryId: string | null;
}

export class ForegroundNode {
	readonly #config: NodeConfig;
	readonly #client: NodeRelayClient;
	readonly #journal: NodeJournal;
	readonly #processor: DeliveryProcessor;
	readonly #pollIntervalMs: number;
	readonly #logger: NodeLog;
	#initialized = false;

	constructor(options: ForegroundNodeOptions) {
		this.#config = options.config;
		this.#client = options.client;
		this.#journal = options.journal;
		this.#processor = new DeliveryProcessor(options);
		this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
		this.#logger = options.logger ?? silentLogger;
		if (!Number.isInteger(this.#pollIntervalMs) || this.#pollIntervalMs < 50) {
			throw new Error("Node poll interval must be an integer of at least 50ms");
		}
	}

	async initialize(signal?: AbortSignal): Promise<void> {
		if (this.#initialized) return;
		signal?.throwIfAborted();
		await verifyNodeIdentityAndWorkspaces(this.#config, this.#client, signal);
		signal?.throwIfAborted();
		this.#initialized = true;
		this.#logger.info(
			{ node_id: this.#config.node.node_id, agent_id: this.#config.node.agent_id },
			"AgentRelay Node identity and workspaces verified",
		);
	}

	async runCycle(signal?: AbortSignal): Promise<NodeCycleResult> {
		signal?.throwIfAborted();
		await this.initialize(signal);
		signal?.throwIfAborted();
		const recoverable = await this.#client.recoverDeliveries();
		await this.#journal.ingestRecoverable(recoverable.items);
		signal?.throwIfAborted();
		const cursor = this.#journal.snapshot().cursor;
		const discovered = await this.#client.pollDeliveries(cursor);
		await this.#journal.ingestCursorPage(discovered.items, discovered.next_cursor);
		signal?.throwIfAborted();
		const processedDeliveryId = await this.#processor.processNext(
			signal,
			new Date(recoverable.as_of),
		);
		signal?.throwIfAborted();
		const acceptedMissions = await acceptPendingMissions(
			this.#config,
			this.#client,
			this.#journal,
			{
				onLocalFailure: (failure) =>
					this.#logger.warn(failure, "AgentRelay Node did not accept Mission"),
				signal,
			},
		);
		return {
			acceptedMissions,
			recoveredDeliveries: recoverable.items.length,
			discoveredDeliveries: discovered.items.length,
			processedDeliveryId,
		};
	}

	async run(signal: AbortSignal): Promise<void> {
		if (signal.aborted) {
			this.#logger.info({}, "AgentRelay Node stopped");
			return;
		}
		try {
			await this.initialize(signal);
		} catch (error) {
			if (!signal.aborted) throw error;
			this.#logger.info({}, "AgentRelay Node stopped");
			return;
		}
		while (!signal.aborted) {
			try {
				const cycle = await this.runCycle(signal);
				if (
					cycle.acceptedMissions > 0 ||
					cycle.recoveredDeliveries > 0 ||
					cycle.discoveredDeliveries > 0 ||
					cycle.processedDeliveryId !== null
				) {
					this.#logger.info({ ...cycle }, "AgentRelay Node cycle completed");
				}
			} catch (error) {
				if (signal.aborted) break;
				this.#logger.error({ error: safeError(error) }, "AgentRelay Node cycle failed");
			}
			if (signal.aborted) break;
			try {
				await delay(this.#pollIntervalMs, undefined, { signal });
			} catch {
				if (!signal.aborted) throw new Error("Node polling delay failed");
			}
		}
		this.#logger.info({}, "AgentRelay Node stopped");
	}
}

const silentLogger: NodeLog = {
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

function safeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}
