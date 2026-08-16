import { access, chmod } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { directCodexProcessBoundaryForTests } from "../test-support/direct-codex-process-boundary.js";
import {
	type FakeAppServerFixture,
	createFakeAppServer,
	isProcessAlive,
	waitForArgv,
	waitForEnvironment,
	waitForMessages,
	waitForPid,
	waitForProcessExit,
} from "../test-support/fake-codex-app-server.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import { DISABLED_CODEX_FEATURES } from "./codex-app-server-command.js";
import {
	CODEX_APP_SERVER_CLIENT_NAME,
	SUPPORTED_CODEX_CLI_VERSION,
} from "./codex-app-server-protocol.js";

const fixtures: FakeAppServerFixture[] = [];
const clients: CodexAppServerClient[] = [];

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await Promise.all(fixtures.splice(0).map((fixture) => fixture.remove()));
});

describe("CodexAppServerClient", () => {
	it("pins the handshake and enforces a persistent read-only thread", async () => {
		const fixture = await fakeAppServer();
		const client = await openClient(fixture);

		expect(client.identity).toMatchObject({
			userAgent: `${CODEX_APP_SERVER_CLIENT_NAME}/${SUPPORTED_CODEX_CLI_VERSION} (Fake OS; arm64)`,
			platformFamily: "unix",
		});
		const started = await client.startThread();
		expect(started).toMatchObject({
			thread: {
				id: "thread-1",
				ephemeral: false,
				cliVersion: SUPPORTED_CODEX_CLI_VERSION,
				cwd: fixture.directory,
			},
			approvalPolicy: "never",
			sandbox: { type: "readOnly", networkAccess: false },
		});

		const messages = await waitForMessages(fixture.logPath, 3);
		expect(messages.slice(0, 3)).toEqual([
			expect.objectContaining({
				method: "initialize",
				params: expect.objectContaining({
					clientInfo: expect.objectContaining({ name: CODEX_APP_SERVER_CLIENT_NAME }),
					capabilities: expect.objectContaining({
						experimentalApi: false,
						requestAttestation: false,
					}),
				}),
			}),
			{ method: "initialized" },
			expect.objectContaining({
				method: "thread/start",
				params: expect.objectContaining({
					cwd: fixture.directory,
					approvalPolicy: "never",
					approvalsReviewer: "user",
					sandbox: "read-only",
					ephemeral: false,
				}),
			}),
		]);
		expect(await waitForArgv(fixture.argvPath)).toEqual([
			"--strict-config",
			...DISABLED_CODEX_FEATURES.flatMap((feature) => ["--disable", feature]),
			"app-server",
			"--listen",
			"stdio://",
		]);
		const environment = await waitForEnvironment(fixture.environmentPath);
		expect(environment.HOME).toBe(join(fixture.directory, "codex-home"));
		expect(environment.CODEX_HOME).toBe(join(fixture.directory, "codex-home"));
		for (const name of [
			"AGENTRELAY_NODE_TOKEN",
			"OPENAI_API_KEY",
			"CODEX_API_KEY",
			"NODE_OPTIONS",
		]) {
			expect(environment).not.toHaveProperty(name);
		}
	});

	it("starts one correlated read-only turn and fails closed on an approval request", async () => {
		const fixture = await fakeAppServer({ requestApproval: true });
		const client = await openClient(fixture);
		await client.startThread();
		const turn = await client.startReadOnlyTurn({
			threadId: "thread-1",
			clientUserMessageId: "delivery-id:1",
			text: "Return a bounded reply.",
			cwd: fixture.directory,
			outputSchema: {
				type: "object",
				properties: { kind: { const: "reply" } },
				required: ["kind"],
				additionalProperties: false,
			},
		});
		expect(turn).toMatchObject({ id: "turn-1", status: "inProgress" });

		const events = client.events()[Symbol.asyncIterator]();
		await expect(events.next()).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "policy",
		});
		await expect(client.readThread("thread-1")).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "policy",
		});

		const messages = await waitForMessages(fixture.logPath, 4);
		expect(messages.find((message) => message.method === "turn/start")).toMatchObject({
			params: {
				threadId: "thread-1",
				clientUserMessageId: "delivery-id:1",
				cwd: fixture.directory,
				approvalPolicy: "never",
				approvalsReviewer: "user",
				sandboxPolicy: { type: "readOnly", networkAccess: false },
			},
		});
		expect(messages).not.toContainEqual(expect.objectContaining({ method: "thread/read" }));
	});

	it("reads persisted turns for AgentRelay-owned duplicate detection", async () => {
		const client = await openClient(await fakeAppServer());
		const thread = await client.readThread("thread-1");
		expect(thread.turns[0]).toMatchObject({
			id: "existing-turn",
			items: [expect.objectContaining({ type: "userMessage", clientId: "existing-delivery:1" })],
		});
	});

	it("preserves method and code for provider response errors", async () => {
		const client = await openClient(await fakeAppServer({ readErrorCode: -32_001 }));
		await expect(client.readThread("thread-1")).rejects.toMatchObject({
			name: "CodexAppServerResponseError",
			reason: "provider",
			method: "thread/read",
			code: -32_001,
			data: { retryAfterMs: 25 },
		});
		expect(await client.startThread()).toMatchObject({ thread: { id: "thread-1" } });
	});

	it("tolerates notification metadata and allows only one event consumer", async () => {
		const client = await openClient(await fakeAppServer({ notificationMode: "valid" }));
		await client.startThread();
		const first = client.events()[Symbol.asyncIterator]();
		expect(await first.next()).toMatchObject({
			done: false,
			value: {
				kind: "notification",
				notification: { method: "turn/completed" },
			},
		});
		const second = client.events()[Symbol.asyncIterator]();
		await expect(second.next()).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "policy",
		});
	});

	it("poisons the client after a malformed lifecycle notification", async () => {
		const fixture = await fakeAppServer({ notificationMode: "malformed" });
		const client = await openClient(fixture);
		await client.startThread();
		const events = client.events()[Symbol.asyncIterator]();
		await expect(events.next()).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "protocol",
		});
		await expect(client.readThread("thread-1")).rejects.toMatchObject({ reason: "protocol" });
		expect(await waitForMessages(fixture.logPath, 3)).not.toContainEqual(
			expect.objectContaining({ method: "thread/read" }),
		);
	});

	it("rejects a mismatched resumed or read thread identity", async () => {
		const resumeFixture = await fakeAppServer({ mismatchedThreadId: true });
		const resumeClient = await openClient(resumeFixture);
		await expect(resumeClient.resumeThread("thread-1")).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "protocol",
		});
		await expect(resumeClient.readThread("thread-1")).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "protocol",
		});
		expect(await waitForMessages(resumeFixture.logPath, 2)).not.toContainEqual(
			expect.objectContaining({ method: "thread/read" }),
		);

		const readClient = await openClient(await fakeAppServer({ mismatchedThreadId: true }));
		await expect(readClient.readThread("thread-1")).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "protocol",
		});
	});

	it("fails closed when the app-server version or returned sandbox differs", async () => {
		await expect(openClient(await fakeAppServer({ version: "0.147.0" }))).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "version",
		});

		const client = await openClient(await fakeAppServer({ unsafePolicy: true }));
		await expect(client.startThread()).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "policy",
		});

		await expect(
			openClient(await fakeAppServer({ codexHome: "/tmp/not-the-approved-codex-home" })),
		).rejects.toMatchObject({ name: "CodexAppServerError", reason: "policy" });
	});

	it("rejects unsafe Capsule permissions before starting the executable", async () => {
		const fixture = await fakeAppServer();
		await chmod(fixture.directory, 0o500);
		try {
			await expect(openClient(fixture)).rejects.toMatchObject({
				name: "CodexAppServerError",
				reason: "policy",
			});
			await expect(access(fixture.environmentPath)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await chmod(fixture.directory, 0o700);
		}
	});

	it("rejects a turn that tries to escape the Capsule workspace", async () => {
		const fixture = await fakeAppServer();
		const client = await openClient(fixture);
		await client.startThread();
		await expect(
			client.startReadOnlyTurn({
				threadId: "thread-1",
				clientUserMessageId: "delivery-id:1",
				text: "Do work elsewhere.",
				cwd: "/tmp/not-the-capsule-workspace",
				outputSchema: {},
			}),
		).rejects.toMatchObject({ name: "CodexAppServerError", reason: "policy" });
	});

	it("rejects a non-JSON output schema without poisoning the process", async () => {
		const fixture = await fakeAppServer();
		const client = await openClient(fixture);
		await client.startThread();
		await expect(
			client.startReadOnlyTurn({
				threadId: "thread-1",
				clientUserMessageId: "delivery-id:invalid-schema",
				text: "Return structured output.",
				cwd: fixture.directory,
				outputSchema: { invalid: 1n } as never,
			}),
		).rejects.toMatchObject({ name: "ZodError" });
		expect(await client.readThread("thread-1")).toMatchObject({ id: "thread-1" });
	});

	it("terminates descendants in the app-server process group", async () => {
		const fixture = await fakeAppServer({ spawnDescendant: true });
		const client = await openClient(fixture);
		const descendantPid = await waitForPid(fixture.childPidPath);
		expect(isProcessAlive(descendantPid)).toBe(true);

		await client.close();
		clients.splice(clients.indexOf(client), 1);
		await waitForProcessExit(descendantPid);
	});
});

async function fakeAppServer(
	options: Parameters<typeof createFakeAppServer>[0] = {},
): Promise<FakeAppServerFixture> {
	const fixture = await createFakeAppServer(options);
	fixtures.push(fixture);
	return fixture;
}

async function openClient(fixture: FakeAppServerFixture): Promise<CodexAppServerClient> {
	const client = await CodexAppServerClient.start({
		command: { executable: fixture.scriptPath },
		cwd: fixture.directory,
		capsuleDirectory: fixture.directory,
		env: fixture.env,
		boundary: directCodexProcessBoundaryForTests,
	});
	clients.push(client);
	return client;
}
