import { dirname, join, resolve } from "node:path";
import type { AgentHostAdapter } from "@agentrelay/protocol";
import { z } from "zod";
import { type NodeConfig, loadNodeConfig, resolveNodeConfigPath } from "./config.js";
import { ForegroundNode, type ForegroundNodeOptions, type NodeLog } from "./daemon.js";
import { assertFakeRuntimeCredential } from "./fake-runtime.js";
import { createFileJournalStorage } from "./file-journal.js";
import { NodeJournal } from "./journal.js";
import { type ProcessLock, acquireProcessLock } from "./process-lock.js";
import { createNodeRelayClient } from "./relay-client.js";
import type { RuntimeAuthorityPort } from "./runtime-authority-port.js";
import type { RuntimeProvisioner } from "./runtime-provisioner.js";

export interface NodeCommandRunContext {
	readonly config: NodeConfig;
	readonly stateDirectory: string;
	readonly lifetimeSignal: AbortSignal;
}

export interface NodeCommandRuntime {
	readonly adapter: AgentHostAdapter;
	readonly authorityPort?: RuntimeAuthorityPort;
	readonly runtimeProvisioner?: RuntimeProvisioner;
	close?(): void | Promise<void>;
}

export interface NodeCommandLifecycle {
	readonly credentialMode: "configured" | "fake-only";
	closeBeforeLockRelease?(): void | Promise<void>;
}

export interface NodeCommandOptions {
	readonly configPath?: unknown;
	readonly pollIntervalMs: unknown;
	readonly once?: unknown;
	readonly createLogger: () => NodeLog;
}

const configPathOptionSchema = z.union([
	z.undefined(),
	z
		.string()
		.min(1)
		.max(4_096)
		.refine((value) => !value.includes("\0")),
]);
const pollIntervalOptionSchema = z.number().int().min(50);
const onceOptionSchema = z.union([z.undefined(), z.literal(true)]);

interface ForegroundNodeRunner {
	runCycle(signal?: AbortSignal): Promise<unknown>;
	run(signal: AbortSignal): Promise<void>;
}

interface NodeCommandSignalProcess {
	once(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
	removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
}

export interface NodeCommandDependencies {
	readonly resolveConfigPath?: () => string;
	readonly loadConfig?: (path: string) => Promise<NodeConfig>;
	readonly assertFakeCredential?: (token: string) => void;
	readonly acquireLock?: (path: string) => Promise<ProcessLock>;
	readonly openJournal?: (path: string) => Promise<NodeJournal>;
	readonly createRelayClient?: typeof createNodeRelayClient;
	readonly createForegroundNode?: (options: ForegroundNodeOptions) => ForegroundNodeRunner;
	readonly signals?: NodeCommandSignalProcess;
}

/** Runs one foreground Node while preserving command ownership and shutdown ordering. */
export async function runForegroundNodeCommand(
	options: NodeCommandOptions,
	createRuntime: (
		context: NodeCommandRunContext,
	) => NodeCommandRuntime | Promise<NodeCommandRuntime>,
	lifecycle: NodeCommandLifecycle = { credentialMode: "fake-only" },
	dependencies: NodeCommandDependencies = {},
): Promise<void> {
	const configPathOption = configPathOptionSchema.safeParse(options.configPath);
	if (!configPathOption.success) {
		throw new Error("--config must be supplied at most once as a non-empty path");
	}
	const pollInterval = pollIntervalOptionSchema.safeParse(options.pollIntervalMs);
	if (!pollInterval.success) {
		throw new Error("--poll-ms must be an integer of at least 50ms");
	}
	const once = onceOptionSchema.safeParse(options.once);
	if (!once.success) throw new Error("--once may be supplied at most once");
	const configPath = resolve(
		configPathOption.data ?? (dependencies.resolveConfigPath ?? resolveNodeConfigPath)(),
	);
	const config = await (dependencies.loadConfig ?? loadNodeConfig)(configPath);
	if (lifecycle.credentialMode === "fake-only") {
		(dependencies.assertFakeCredential ?? assertFakeRuntimeCredential)(config.node.token);
	}
	const stateDirectory = join(dirname(configPath), "state");
	const lock = await (dependencies.acquireLock ?? acquireProcessLock)(
		join(dirname(configPath), "run.lock"),
	);
	const controller = new AbortController();
	const stop = () => controller.abort();
	const signals = dependencies.signals ?? processSignals;
	signals.once("SIGINT", stop);
	signals.once("SIGTERM", stop);

	let runtime: NodeCommandRuntime | null = null;
	try {
		const journal = await (dependencies.openJournal ?? openNodeJournal)(
			join(stateDirectory, "journal.json"),
		);
		runtime = await createRuntime({ config, stateDirectory, lifetimeSignal: controller.signal });
		const node = (dependencies.createForegroundNode ?? createForegroundNode)({
			config,
			client: (dependencies.createRelayClient ?? createNodeRelayClient)({
				relayUrl: config.relay_url,
				credential: config.node.token,
			}),
			journal,
			adapter: runtime.adapter,
			authorityPort: runtime.authorityPort,
			runtimeProvisioner: runtime.runtimeProvisioner,
			pollIntervalMs: pollInterval.data,
			logger: options.createLogger(),
		});
		if (once.data === true) {
			await node.runCycle(controller.signal);
		} else {
			await node.run(controller.signal);
		}
	} finally {
		controller.abort();
		try {
			await runtime?.close?.();
		} finally {
			try {
				await lifecycle.closeBeforeLockRelease?.();
			} finally {
				try {
					await lock.release();
				} finally {
					signals.removeListener("SIGINT", stop);
					signals.removeListener("SIGTERM", stop);
				}
			}
		}
	}
}

function openNodeJournal(path: string): Promise<NodeJournal> {
	return NodeJournal.open(createFileJournalStorage(path));
}

function createForegroundNode(options: ForegroundNodeOptions): ForegroundNode {
	return new ForegroundNode(options);
}

const processSignals: NodeCommandSignalProcess = {
	once(signal, listener) {
		process.once(signal, listener);
	},
	removeListener(signal, listener) {
		process.removeListener(signal, listener);
	},
};
