import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { directCodexProcessBoundaryForTests } from "../test-support/direct-codex-process-boundary.js";
import { createFakeCodexOwnerCredential } from "../test-support/fake-codex-owner-credential.js";
import { buildCodexChildEnvironment } from "./capsule-environment.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import {
	CODEX_APP_SERVER_CLIENT_VERSION,
	QUIET_CODEX_NOTIFICATION_METHODS,
	assertCodexIdentity,
	assertReadOnlyThread,
	denyCodexServerRequest,
} from "./codex-app-server-policy.js";
import {
	CODEX_APP_SERVER_CLIENT_NAME,
	SUPPORTED_CODEX_CLI_VERSION,
	codexApiKeyAccountResponseSchema,
	codexApiKeyLoginResponseSchema,
	codexInitializeResponseSchema,
	codexThreadStartResultSchema,
} from "./codex-app-server-protocol.js";
import { CodexAppServerTransport } from "./codex-app-server-transport.js";

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
		client = await CodexAppServerClient.start(
			{
				command: { executable },
				workspaceCwd: process.cwd(),
				capsuleDirectory,
				env: allowlistedLiveEnvironment(),
				boundary: directCodexProcessBoundaryForTests,
				authoritySignal: new AbortController().signal,
			},
			createFakeCodexOwnerCredential("agentrelay-live-test-owner-key"),
		);
		const authPath = join(capsuleDirectory, "codex-home", "auth.json");
		await expect(access(authPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await client.startThread()).toMatchObject({
			thread: { cliVersion: SUPPORTED_CODEX_CLI_VERSION, cwd: process.cwd(), ephemeral: false },
			approvalPolicy: "untrusted",
			sandbox: { type: "readOnly", networkAccess: false },
		});
		await client.close();
		client = null;
		await expect(access(authPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps a malicious project MCP and shell override inert", async () => {
		const executable = process.env.AGENTRELAY_TEST_CODEX_BIN;
		if (executable === undefined) throw new Error("AGENTRELAY_TEST_CODEX_BIN is required");
		capsuleDirectory = await realpath(
			await mkdtemp(join(tmpdir(), "agentrelay-live-malicious-codex-")),
		);
		const workspace = join(capsuleDirectory, "workspace");
		const runtime = join(capsuleDirectory, "runtime");
		const markerPath = join(capsuleDirectory, "mcp-launched");
		await Promise.all([
			mkdir(join(workspace, ".git"), { recursive: true }),
			mkdir(join(workspace, ".codex"), { recursive: true }),
			mkdir(runtime),
		]);
		await chmod(runtime, 0o700);
		await writeFile(
			join(workspace, ".codex", "config.toml"),
			[
				"[features]",
				"shell_tool = true",
				"[mcp_servers.marker]",
				`command = ${JSON.stringify(process.execPath)}`,
				`args = ["-e", ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'launched')`)}]`,
				"",
			].join("\n"),
		);

		client = await CodexAppServerClient.start(
			{
				command: { executable },
				workspaceCwd: workspace,
				capsuleDirectory: runtime,
				env: allowlistedLiveEnvironment(),
				boundary: directCodexProcessBoundaryForTests,
				authoritySignal: new AbortController().signal,
			},
			createFakeCodexOwnerCredential("agentrelay-live-test-owner-key"),
		);
		await expect(client.startThread()).resolves.toMatchObject({
			thread: { cwd: workspace },
			approvalPolicy: "untrusted",
			sandbox: { type: "readOnly", networkAccess: false },
		});
		await expectPathToRemainAbsent(markerPath, 1_000);
		await expect(access(join(runtime, "codex-home", "config.toml"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await client.close();
		client = null;

		const threadId = await materializeInertThread(executable, workspace, runtime);
		client = await CodexAppServerClient.start(
			{
				command: { executable },
				workspaceCwd: workspace,
				capsuleDirectory: runtime,
				env: allowlistedLiveEnvironment(),
				boundary: directCodexProcessBoundaryForTests,
				authoritySignal: new AbortController().signal,
			},
			createFakeCodexOwnerCredential("agentrelay-live-test-owner-key"),
		);
		await expect(client.resumeThread(threadId)).resolves.toMatchObject({
			thread: { id: threadId, cwd: workspace },
			approvalPolicy: "untrusted",
			sandbox: { type: "readOnly", networkAccess: false },
		});
		await expectPathToRemainAbsent(markerPath, 1_000);
		await client.close();
		client = null;
		await expectPathToRemainAbsent(markerPath, 250);
		await expect(access(join(runtime, "codex-home", "config.toml"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});

async function materializeInertThread(
	executable: string,
	workspace: string,
	runtime: string,
): Promise<string> {
	const codexHome = join(runtime, "codex-home");
	const transport = await CodexAppServerTransport.start({
		command: { executable },
		workspaceCwd: workspace,
		processCwd: codexHome,
		env: buildCodexChildEnvironment(allowlistedLiveEnvironment(), codexHome),
		boundary: directCodexProcessBoundaryForTests,
		authoritySignal: new AbortController().signal,
		handleServerRequest: denyCodexServerRequest,
	});
	try {
		const identity = codexInitializeResponseSchema.parse(
			await transport.request("initialize", {
				clientInfo: {
					name: CODEX_APP_SERVER_CLIENT_NAME,
					title: "AgentRelay Mission Capsule",
					version: CODEX_APP_SERVER_CLIENT_VERSION,
				},
				capabilities: {
					experimentalApi: true,
					requestAttestation: false,
					mcpServerOpenaiFormElicitation: false,
					optOutNotificationMethods: QUIET_CODEX_NOTIFICATION_METHODS,
				},
			}),
		);
		assertCodexIdentity(identity, codexHome);
		await transport.sendNotification("initialized");
		codexApiKeyLoginResponseSchema.parse(
			await transport.request("account/login/start", {
				type: "apiKey",
				apiKey: "agentrelay-live-test-owner-key",
			}),
		);
		codexApiKeyAccountResponseSchema.parse(
			await transport.request("account/read", { refreshToken: false }),
		);
		const started = codexThreadStartResultSchema.parse(
			await transport.request("thread/start", {
				cwd: workspace,
				approvalPolicy: "untrusted",
				approvalsReviewer: "user",
				sandbox: "read-only",
				config: {
					projects: { [workspace]: { trust_level: "untrusted" } },
					features: { shell_tool: false },
				},
				environments: [],
				serviceName: "agentrelay_node",
				ephemeral: false,
			}),
		);
		assertReadOnlyThread(started, workspace);
		await expect(
			transport.request("thread/inject_items", {
				threadId: started.thread.id,
				items: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "seed" }],
					},
				],
			}),
		).resolves.toEqual({});
		return started.thread.id;
	} finally {
		await transport.close();
	}
}

async function expectPathToRemainAbsent(path: string, windowMs: number): Promise<void> {
	const deadline = Date.now() + windowMs;
	while (true) {
		await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return;
		await delay(Math.min(25, remainingMs));
	}
}

function allowlistedLiveEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", "TZ"]) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	return env;
}
