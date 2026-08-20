import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SupervisedCodexProviderGuardian } from "../src/codex-provider-guardian.js";
import { directCodexProcessBoundaryForTests } from "./direct-codex-process-boundary.js";
import { createFakeCodexOwnerCredential } from "./fake-codex-owner-credential.js";

const capsuleId = requiredEnvironment("AGENTRELAY_TEST_CAPSULE_ID");
const directory = requiredEnvironment("AGENTRELAY_TEST_CAPSULE_DIRECTORY");
const executable = requiredEnvironment("AGENTRELAY_TEST_CODEX_BIN");
const readyPath = requiredEnvironment("AGENTRELAY_TEST_READY_PATH");
const prepareStartedPath = process.env.AGENTRELAY_TEST_PREPARE_STARTED_PATH;
const prepareDelayMs = Number(process.env.AGENTRELAY_TEST_PREPARE_DELAY_MS ?? 0);

const boundary = {
	async prepare(
		request: Parameters<typeof directCodexProcessBoundaryForTests.prepare>[0],
		signal: AbortSignal,
	) {
		if (prepareStartedPath !== undefined) {
			await writeFile(prepareStartedPath, "started\n", { mode: 0o600 });
		}
		if (prepareDelayMs > 0) await delay(prepareDelayMs);
		return directCodexProcessBoundaryForTests.prepare(request, signal);
	},
};

const guardian = new SupervisedCodexProviderGuardian({
	capsuleId,
	command: { executable },
	workspaceCwd: directory,
	capsuleDirectory: directory,
	env: process.env,
	boundary,
	authoritySignal: new AbortController().signal,
	claimOwnerCredential: async () => createFakeCodexOwnerCredential("guardian-owner-worker"),
	deadlineAtMs: Date.now() + 60_000,
	supervisor: {
		executable: process.execPath,
		args: [
			"--import",
			createRequire(import.meta.url).resolve("tsx"),
			fileURLToPath(new URL("../src/bin/agentrelay-codex-guardian.ts", import.meta.url)),
		],
	},
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
