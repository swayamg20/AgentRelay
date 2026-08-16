#!/usr/bin/env node

import { CodexProviderSupervisor } from "../codex-provider-supervisor.js";

try {
	new CodexProviderSupervisor().run();
} catch {
	process.stderr.write("Codex provider supervisor failed\n");
	process.exitCode = 1;
}
