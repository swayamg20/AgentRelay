import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { directCodexProcessBoundaryForTests } from "../test-support/direct-codex-process-boundary.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import { SUPPORTED_CODEX_CLI_VERSION } from "./codex-app-server-protocol.js";

let client: CodexAppServerClient | null = null;
let capsuleDirectory: string | null = null;

afterEach(async () => {
	await client?.close();
	client = null;
	if (capsuleDirectory !== null) await rm(capsuleDirectory, { recursive: true });
	capsuleDirectory = null;
});

describe.runIf(process.env.AGENTRELAY_TEST_CODEX_BIN)("installed Codex app-server", () => {
	it("matches the pinned handshake and thread policy without a model turn", async () => {
		const executable = process.env.AGENTRELAY_TEST_CODEX_BIN;
		if (executable === undefined) throw new Error("AGENTRELAY_TEST_CODEX_BIN is required");
		capsuleDirectory = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-live-codex-")));
		await chmod(capsuleDirectory, 0o700);
		client = await CodexAppServerClient.start({
			command: { executable },
			cwd: process.cwd(),
			capsuleDirectory,
			env: allowlistedLiveEnvironment(),
			boundary: directCodexProcessBoundaryForTests,
		});
		expect(await client.startThread()).toMatchObject({
			thread: { cliVersion: SUPPORTED_CODEX_CLI_VERSION, cwd: process.cwd(), ephemeral: false },
			approvalPolicy: "never",
			sandbox: { type: "readOnly", networkAccess: false },
		});
	});
});

function allowlistedLiveEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", "TZ"]) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	return env;
}
