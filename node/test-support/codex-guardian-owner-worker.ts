import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { SupervisedCodexProviderGuardian } from "../src/codex-provider-guardian.js";
import { directCodexProcessBoundaryForTests } from "./direct-codex-process-boundary.js";

const capsuleId = requiredEnvironment("AGENTRELAY_TEST_CAPSULE_ID");
const directory = requiredEnvironment("AGENTRELAY_TEST_CAPSULE_DIRECTORY");
const executable = requiredEnvironment("AGENTRELAY_TEST_CODEX_BIN");
const readyPath = requiredEnvironment("AGENTRELAY_TEST_READY_PATH");

const guardian = new SupervisedCodexProviderGuardian({
	capsuleId,
	command: { executable },
	cwd: directory,
	capsuleDirectory: directory,
	env: process.env,
	boundary: directCodexProcessBoundaryForTests,
	supervisor: {
		executable: process.execPath,
		args: [
			"--import",
			createRequire(import.meta.url).resolve("tsx"),
			fileURLToPath(new URL("../src/bin/agentrelay-codex-guardian.ts", import.meta.url)),
		],
	},
	startupTimeoutMs: 5_000,
	heartbeatIntervalMs: 50,
	heartbeatTimeoutMs: 500,
	heartbeatRecordMs: 100,
});

const generation = await guardian.openGeneration();
await generation.client.startThread();
await writeFile(
	readyPath,
	`${JSON.stringify({ generation_id: generation.generationId, owner_pid: process.pid })}\n`,
	{ mode: 0o600 },
);

await new Promise(() => undefined);

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
	return value;
}
