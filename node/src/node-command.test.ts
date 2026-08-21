import type { AgentHostAdapter } from "@agentrelay/protocol";
import { describe, expect, it, vi } from "vitest";
import { withOwnedCodexOwnerCredentialFd } from "./codex-node-command.js";
import type { NodeConfig } from "./config.js";
import type { ForegroundNodeOptions, NodeLog } from "./daemon.js";
import type { NodeJournal } from "./journal.js";
import {
	type NodeCommandDependencies,
	type NodeCommandRuntime,
	runForegroundNodeCommand,
} from "./node-command.js";
import type { ProcessLock } from "./process-lock.js";
import type { NodeRelayClient } from "./relay-client.js";
import type { RuntimeAuthorityPort } from "./runtime-authority-port.js";
import type { RuntimeProvisioner } from "./runtime-provisioner.js";

const NODE_ID = "82000000-0000-4000-8000-000000000001";
const AGENT_ID = "82000000-0000-4000-8000-000000000002";
const CREDENTIAL_ID = "82000000-0000-4000-8000-000000000003";

describe("runForegroundNodeCommand", () => {
	it("rejects a live credential in fake mode before lock or state construction", async () => {
		const events: string[] = [];
		const harness = commandHarness(events, { tokenKind: "live" });
		harness.assertFakeCredential.mockImplementation(() => {
			events.push("fake-credential-check");
			throw new Error("fake runtime rejected live authority");
		});
		const createRuntime = vi.fn(async () => harness.runtime);

		await expect(
			runForegroundNodeCommand(harness.options, createRuntime, undefined, harness.dependencies),
		).rejects.toThrow("fake runtime rejected live authority");

		expect(events).toEqual(["config-load", "fake-credential-check"]);
		expect(harness.acquireLock).not.toHaveBeenCalled();
		expect(harness.openJournal).not.toHaveBeenCalled();
		expect(createRuntime).not.toHaveBeenCalled();
	});

	it.each(["success", "node-failure"] as const)(
		"forwards the exact configured runtime and closes in authority order on %s",
		async (outcome) => {
			const events: string[] = [];
			const harness = commandHarness(events, { nodeOutcome: outcome });
			let lifetimeSignal: AbortSignal | undefined;
			const createRuntime = vi.fn(async (context) => {
				events.push("runtime-open");
				lifetimeSignal = context.lifetimeSignal;
				context.lifetimeSignal.addEventListener("abort", () => events.push("lifetime-abort"), {
					once: true,
				});
				return harness.runtime;
			});
			const closeBeforeLockRelease = vi.fn(async () => {
				events.push("unread-fd-close");
			});

			const operation = runForegroundNodeCommand(
				harness.options,
				createRuntime,
				{ credentialMode: "configured", closeBeforeLockRelease },
				harness.dependencies,
			);
			if (outcome === "node-failure") {
				await expect(operation).rejects.toThrow("foreground Node failed");
			} else {
				await expect(operation).resolves.toBeUndefined();
			}

			expect(harness.assertFakeCredential).not.toHaveBeenCalled();
			expect(createRuntime).toHaveBeenCalledOnce();
			expect(harness.createRelayClient).toHaveBeenCalledOnce();
			expect(createRuntime.mock.invocationCallOrder[0]!).toBeLessThan(
				harness.createRelayClient.mock.invocationCallOrder[0]!,
			);
			expect(harness.foregroundOptions).toMatchObject({
				adapter: harness.runtime.adapter,
				authorityPort: harness.runtime.authorityPort,
				runtimeProvisioner: harness.runtime.runtimeProvisioner,
				pollIntervalMs: 75,
			});
			expect(lifetimeSignal?.aborted).toBe(true);
			expect(closeBeforeLockRelease).toHaveBeenCalledOnce();
			expect(events).toEqual([
				"config-load",
				"lock-acquire",
				"listen:SIGINT",
				"listen:SIGTERM",
				"journal-open",
				"runtime-open",
				"relay-client-create",
				"logger-create",
				"foreground-node-create",
				"node-cycle",
				...(outcome === "node-failure" ? ["node-error"] : []),
				"lifetime-abort",
				"runtime-close:aborted",
				"unread-fd-close",
				"lock-release",
				"remove:SIGINT",
				"remove:SIGTERM",
			]);
		},
	);

	it("closes the unread fd before releasing the lock when runtime construction fails", async () => {
		const events: string[] = [];
		const harness = commandHarness(events);
		const createRuntime = vi.fn(async () => {
			events.push("runtime-open");
			throw new Error("passive runtime preflight failed");
		});

		await expect(
			runForegroundNodeCommand(
				harness.options,
				createRuntime,
				{
					credentialMode: "configured",
					closeBeforeLockRelease: () => {
						events.push("unread-fd-close");
					},
				},
				harness.dependencies,
			),
		).rejects.toThrow("passive runtime preflight failed");

		expect(events).toEqual([
			"config-load",
			"lock-acquire",
			"listen:SIGINT",
			"listen:SIGTERM",
			"journal-open",
			"runtime-open",
			"unread-fd-close",
			"lock-release",
			"remove:SIGINT",
			"remove:SIGTERM",
		]);
		expect(harness.createRelayClient).not.toHaveBeenCalled();
	});

	it.each([
		["duplicate config", { configPath: ["/first/config.json", "/second/config.json"] }],
		["invalid poll interval", { pollIntervalMs: 49 }],
		["duplicate once flag", { once: [true, true] }],
	] as const)(
		"closes the admitted owner channel before any state or runtime work on %s",
		async (_label, override) => {
			const events: string[] = [];
			const harness = commandHarness(events);
			const createRuntime = vi.fn(async () => harness.runtime);

			await expect(
				withOwnedCodexOwnerCredentialFd(
					["7"],
					(ownerCredentialFd) =>
						runForegroundNodeCommand(
							{ ...harness.options, ...override },
							createRuntime,
							{
								credentialMode: "configured",
								closeBeforeLockRelease: () => ownerCredentialFd.close(),
							},
							harness.dependencies,
						),
					{
						inspectFd: () => ({ isFIFO: () => true, isSocket: () => false }),
						closeFd: async () => {
							events.push("owner-fd-close");
						},
					},
				),
			).rejects.toThrow(/^--(?:config|poll-ms|once)/);

			expect(events).toEqual(["owner-fd-close"]);
			expect(harness.acquireLock).not.toHaveBeenCalled();
			expect(harness.openJournal).not.toHaveBeenCalled();
			expect(createRuntime).not.toHaveBeenCalled();
			expect(harness.createRelayClient).not.toHaveBeenCalled();
		},
	);
});

interface CommandHarnessOptions {
	readonly nodeOutcome?: "success" | "node-failure";
	readonly tokenKind?: "live" | "test";
}

function commandHarness(events: string[], options: CommandHarnessOptions = {}) {
	const config = nodeConfig(options.tokenKind ?? "test");
	const runtimeProvisioner: RuntimeProvisioner = {
		provision: vi.fn(async () => undefined),
		recover: vi.fn(async () => undefined),
	};
	let lifetimeSignal: AbortSignal | undefined;
	const runtime: NodeCommandRuntime = {
		adapter: {} as AgentHostAdapter,
		authorityPort: {} as RuntimeAuthorityPort,
		runtimeProvisioner,
		close: vi.fn(async () =>
			events.push(`runtime-close:${lifetimeSignal?.aborted ? "aborted" : "live"}`),
		),
	};
	const assertFakeCredential = vi.fn();
	const acquireLock = vi.fn(async () => {
		events.push("lock-acquire");
		return {
			release: vi.fn(async () => events.push("lock-release")),
		} as unknown as ProcessLock;
	});
	const openJournal = vi.fn(async () => {
		events.push("journal-open");
		return {} as NodeJournal;
	});
	const createRelayClient = vi.fn(() => {
		events.push("relay-client-create");
		return {} as NodeRelayClient;
	});
	let foregroundOptions: ForegroundNodeOptions | undefined;
	const createForegroundNode = vi.fn((input: ForegroundNodeOptions) => {
		events.push("foreground-node-create");
		foregroundOptions = input;
		lifetimeSignal = undefined;
		return {
			runCycle: vi.fn(async (signal?: AbortSignal) => {
				lifetimeSignal = signal;
				events.push("node-cycle");
				if (options.nodeOutcome === "node-failure") {
					events.push("node-error");
					throw new Error("foreground Node failed");
				}
			}),
			run: vi.fn(async () => undefined),
		};
	});
	const dependencies: NodeCommandDependencies = {
		resolveConfigPath: () => "/private/node/config.json",
		loadConfig: async () => {
			events.push("config-load");
			return config;
		},
		assertFakeCredential,
		acquireLock,
		openJournal,
		createRelayClient,
		createForegroundNode,
		signals: {
			once(signal) {
				events.push(`listen:${signal}`);
			},
			removeListener(signal) {
				events.push(`remove:${signal}`);
			},
		},
	};
	const logger: NodeLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	return {
		options: {
			pollIntervalMs: 75,
			once: true,
			createLogger: () => {
				events.push("logger-create");
				return logger;
			},
		},
		dependencies,
		assertFakeCredential,
		acquireLock,
		openJournal,
		createRelayClient,
		createForegroundNode,
		get foregroundOptions() {
			return foregroundOptions;
		},
		runtime,
	};
}

function nodeConfig(tokenKind: "live" | "test"): NodeConfig {
	return {
		schema_version: 1,
		relay_url: "https://relay.example.com",
		node: {
			node_id: NODE_ID,
			agent_id: AGENT_ID,
			credential_id: CREDENTIAL_ID,
			token: `ar_node_${tokenKind}_${"a".repeat(32)}`,
		},
		workspaces: {},
		policy_profiles: {},
	};
}
