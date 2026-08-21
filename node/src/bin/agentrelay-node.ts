#!/usr/bin/env node

import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeAgentHostAdapter } from "@agentrelay/protocol/testing";
import { cac } from "cac";
import pino from "pino";
import { PINNED_CODEX_CLI_VERSION } from "../codex-artifact.js";
import {
	CODEX_OWNER_CREDENTIAL_FD_OPTION_CONFIG,
	openCodexNodeCommandRuntime,
	withOwnedCodexOwnerCredentialFd,
} from "../codex-node-command.js";
import { runCodexRuntimeDoctor } from "../codex-runtime-doctor.js";
import {
	type NodeCommandLifecycle,
	type NodeCommandRunContext,
	type NodeCommandRuntime,
	runForegroundNodeCommand,
} from "../node-command.js";
import {
	PersistentFakeCapsuleAdapter,
	createDetachedCapsuleLauncher,
} from "../persistent-capsule-adapter.js";

const cli = cac("agentrelay-node");

cli
	.command("run", "Run the foreground AgentRelay Node with the deterministic fake adapter")
	.option("--config <path>", "Path to the mode-0600 Node config")
	.option("--poll-ms <milliseconds>", "Polling interval", { default: 1_000 })
	.option("--once", "Run one recovery/poll/processing cycle and exit")
	.option("--fake-outcome <outcome>", "Fake turn disposition: ready or reply", {
		default: "ready",
	})
	.action((options) => runNode(options, () => ({ adapter: fakeAdapter(options.fakeOutcome) })));

cli
	.command(
		"run-capsule",
		"Run the foreground Node with independently persistent fake Mission capsules",
	)
	.option("--config <path>", "Path to the mode-0600 Node config")
	.option("--poll-ms <milliseconds>", "Polling interval", { default: 1_000 })
	.option("--once", "Run one recovery/poll/processing cycle and exit")
	.option("--capsule-root <path>", "Private directory containing Mission capsules")
	.option("--fake-outcome <outcome>", "Fake turn disposition: ready or reply", {
		default: "ready",
	})
	.option("--completion-delay-ms <milliseconds>", "Delay before the fake capsule completes", {
		default: 0,
	})
	.action((options) =>
		runNode(options, async ({ stateDirectory }) => {
			const capsuleRoot =
				typeof options.capsuleRoot === "string"
					? resolve(options.capsuleRoot)
					: join(stateDirectory, "capsules");
			const adapter = await PersistentFakeCapsuleAdapter.open({
				rootDirectory: capsuleRoot,
				launcher: createDetachedCapsuleLauncher(capsuleProcessCommand()),
				outcome: options.fakeOutcome,
				completionDelayMs: Number(options.completionDelayMs),
			});
			return { adapter, authorityPort: adapter };
		}),
	);

cli
	.command(
		"run-codex",
		"Run the experimental foreground Node with owner-authenticated Codex capsules",
	)
	.option("--config <path>", "Path to the mode-0600 Node config")
	.option("--poll-ms <milliseconds>", "Polling interval", { default: 1_000 })
	.option("--once", "Run one recovery/poll/processing cycle and exit")
	.option(
		"--owner-credential-fd <fd>",
		"Inherited FIFO or Unix socket containing the Codex owner credential",
		CODEX_OWNER_CREDENTIAL_FD_OPTION_CONFIG,
	)
	.option("--git-executable <path>", "Exact trusted Git executable for write-enabled workspaces")
	.action(runCodexNode);

cli
	.command(
		"doctor-codex",
		"Verify the pinned Codex runtime locally without polling or claiming Relay work",
	)
	.action(runCodexDoctor);

cli.help();
cli.version("0.0.1");

try {
	cli.parse(process.argv, { run: false });
	if (process.argv.slice(2).length === 0) {
		cli.outputHelp();
	} else {
		await cli.runMatchedCommand();
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}

function fakeAdapter(outcome: unknown): FakeAgentHostAdapter {
	if (outcome !== "ready" && outcome !== "reply") {
		throw new Error("--fake-outcome must be ready or reply");
	}
	const adapter = new FakeAgentHostAdapter();
	adapter.setDefaultOutcome({
		kind: "completed",
		disposition:
			outcome === "ready"
				? { kind: "ready", evidence: [] }
				: {
						kind: "reply",
						message_type: "progress",
						message: "Deterministic fake Node processed this delivery.",
					},
	});
	return adapter;
}

async function runCodexDoctor(): Promise<void> {
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await runCodexRuntimeDoctor({ signal: controller.signal });
		process.stdout.write(
			`Pinned Codex ${PINNED_CODEX_CLI_VERSION} preflight passed on linux/x64.\nNo Relay work or model turn was attempted. Experimental run-codex requires --owner-credential-fd; configured write workspaces also require --git-executable.\n`,
		);
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
	}
}

async function runNode(
	options: Record<string, unknown>,
	createRuntime: (
		context: NodeCommandRunContext,
	) => NodeCommandRuntime | Promise<NodeCommandRuntime>,
	lifecycle: NodeCommandLifecycle = { credentialMode: "fake-only" },
): Promise<void> {
	await runForegroundNodeCommand(
		{
			configPath: options.config,
			pollIntervalMs: options.pollMs,
			once: options.once,
			createLogger: () => pino({ level: process.env.AGENTRELAY_NODE_LOG_LEVEL ?? "info" }),
		},
		createRuntime,
		lifecycle,
	);
}

async function runCodexNode(options: Record<string, unknown>): Promise<void> {
	await withOwnedCodexOwnerCredentialFd(options.ownerCredentialFd, async (ownerCredentialFd) => {
		await runNode(
			options,
			({ config, stateDirectory, lifetimeSignal }) =>
				openCodexNodeCommandRuntime({
					config,
					stateDirectory,
					lifetimeSignal,
					gitExecutable: options.gitExecutable,
					capsuleCommand: capsuleProcessCommand(),
					ownerCredentialFd,
				}),
			{
				credentialMode: "configured",
				closeBeforeLockRelease: () => ownerCredentialFd.close(),
			},
		);
	});
}

function capsuleProcessCommand() {
	const currentEntrypoint = fileURLToPath(import.meta.url);
	const extension = extname(currentEntrypoint);
	const capsuleEntrypoint = join(dirname(currentEntrypoint), `agentrelay-capsule${extension}`);
	return {
		executable: process.execPath,
		args:
			extension === ".ts"
				? [createRequire(import.meta.url).resolve("tsx/cli"), capsuleEntrypoint]
				: [capsuleEntrypoint],
	};
}
