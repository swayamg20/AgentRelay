#!/usr/bin/env node

import { dirname, join } from "node:path";
import { FakeAgentHostAdapter } from "@agentrelay/protocol/testing";
import { cac } from "cac";
import pino from "pino";
import { loadNodeConfig, resolveNodeConfigPath } from "../config.js";
import { ForegroundNode } from "../daemon.js";
import { assertFakeRuntimeCredential } from "../fake-runtime.js";
import { createFileJournalStorage } from "../file-journal.js";
import { NodeJournal } from "../journal.js";
import { acquireProcessLock } from "../process-lock.js";
import { createNodeRelayClient } from "../relay-client.js";

const cli = cac("agentrelay-node");

cli
	.command("run", "Run the foreground AgentRelay Node with the deterministic fake adapter")
	.option("--config <path>", "Path to the mode-0600 Node config")
	.option("--poll-ms <milliseconds>", "Polling interval", { default: 1_000 })
	.option("--once", "Run one recovery/poll/processing cycle and exit")
	.option("--fake-outcome <outcome>", "Fake turn disposition: ready or reply", {
		default: "ready",
	})
	.action(async (options) => {
		const configPath = options.config ?? resolveNodeConfigPath();
		const config = await loadNodeConfig(configPath);
		assertFakeRuntimeCredential(config.node.token);
		const stateDirectory = join(dirname(configPath), "state");
		const lock = await acquireProcessLock(join(dirname(configPath), "run.lock"));
		const controller = new AbortController();
		const stop = () => controller.abort();
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);

		try {
			const journal = await NodeJournal.open(
				createFileJournalStorage(join(stateDirectory, "journal.json")),
			);
			const adapter = fakeAdapter(options.fakeOutcome);
			const node = new ForegroundNode({
				config,
				client: createNodeRelayClient({
					relayUrl: config.relay_url,
					credential: config.node.token,
				}),
				journal,
				adapter,
				pollIntervalMs: Number(options.pollMs),
				logger: pino({ level: process.env.AGENTRELAY_NODE_LOG_LEVEL ?? "info" }),
			});
			if (options.once) {
				await node.runCycle(controller.signal);
			} else {
				await node.run(controller.signal);
			}
		} finally {
			process.removeListener("SIGINT", stop);
			process.removeListener("SIGTERM", stop);
			await lock.release();
		}
	});

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
