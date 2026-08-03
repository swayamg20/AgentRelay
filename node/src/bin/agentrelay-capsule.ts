#!/usr/bin/env node

import { cac } from "cac";
import { PersistentFakeCapsuleServer } from "../fake-capsule-server.js";

const cli = cac("agentrelay-capsule");

cli
	.command("serve", "Serve one persisted Mission-scoped fake capsule")
	.option("--directory <path>", "Private capsule state and socket directory")
	.action(async (options) => {
		if (typeof options.directory !== "string" || options.directory.length === 0) {
			throw new Error("--directory is required");
		}
		const server = await PersistentFakeCapsuleServer.start(options.directory);
		const stop = () => void server.close();
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		try {
			await server.waitUntilClosed();
		} finally {
			process.removeListener("SIGINT", stop);
			process.removeListener("SIGTERM", stop);
			await server.close();
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
