#!/usr/bin/env node

import { CodexProviderReaper } from "../codex-provider-reaper.js";
import { CodexProviderSupervisor } from "../codex-provider-supervisor.js";

try {
	if (process.argv[2] === "--reaper") {
		new CodexProviderReaper().run();
	} else if (process.argv.length === 2) {
		new CodexProviderSupervisor().run();
	} else {
		throw new Error("Unsupported Codex guardian child mode");
	}
} catch {
	process.stderr.write("Codex provider supervisor failed\n");
	process.exitCode = 1;
}
