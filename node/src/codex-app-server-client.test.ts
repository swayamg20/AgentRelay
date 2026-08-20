import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
import { createFakeCodexOwnerCredential } from "../test-support/fake-codex-owner-credential.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import {
	CODEX_DISABLED_AGENTS_CONFIG,
	CODEX_DISABLED_WEB_SEARCH_CONFIG,
	CODEX_EPHEMERAL_AUTH_CONFIG,
	DISABLED_CODEX_FEATURES,
	codexUntrustedProjectConfig,
} from "./codex-app-server-command.js";
import { startCodexAppServerProcess } from "./codex-app-server-process.js";
import {
	CODEX_APP_SERVER_CLIENT_NAME,
	SUPPORTED_CODEX_CLI_VERSION,
} from "./codex-app-server-protocol.js";
import {
	CODEX_PROVIDER_BASE_URL_CONFIG,
	CODEX_PROVIDER_CONFIG,
} from "./codex-provider-egress-policy.js";

const fixtures: FakeAppServerFixture[] = [];
const clients: CodexAppServerClient[] = [];
const TEST_OWNER_API_KEY = "opaque owner key with spaces";

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
			approvalPolicy: "untrusted",
			sandbox: { type: "readOnly", networkAccess: false },
		});

		const messages = await waitForMessages(fixture.logPath, 8);
		expect(messages.slice(0, 8)).toEqual([
			expect.objectContaining({
				method: "initialize",
				params: expect.objectContaining({
					clientInfo: expect.objectContaining({ name: CODEX_APP_SERVER_CLIENT_NAME }),
					capabilities: expect.objectContaining({
						experimentalApi: true,
						requestAttestation: false,
					}),
				}),
			}),
			{ method: "initialized" },
			expect.objectContaining({
				method: "account/login/start",
				params: { type: "apiKey", apiKey: "[redacted]" },
			}),
			expect.objectContaining({
				method: "account/read",
				params: { refreshToken: false },
			}),
			expect.objectContaining({
				method: "config/read",
				params: { cwd: fixture.directory, includeLayers: false },
			}),
			expect.objectContaining({
				method: "thread/start",
				params: expect.objectContaining({
					cwd: fixture.directory,
					approvalPolicy: "untrusted",
					approvalsReviewer: "user",
					sandbox: "read-only",
					config: {
						projects: { [fixture.directory]: { trust_level: "untrusted" } },
						features: { shell_tool: false },
					},
					environments: [],
					ephemeral: false,
				}),
			}),
			expect.objectContaining({
				method: "experimentalFeature/list",
				params: { threadId: "thread-1" },
			}),
			expect.objectContaining({
				method: "config/read",
				params: { cwd: join(fixture.directory, "codex-home"), includeLayers: false },
			}),
		]);
		expect(await waitForArgv(fixture.argvPath)).toEqual([
			"--strict-config",
			"--config",
			CODEX_EPHEMERAL_AUTH_CONFIG,
			"--config",
			CODEX_PROVIDER_CONFIG,
			"--config",
			CODEX_PROVIDER_BASE_URL_CONFIG,
			"--config",
			CODEX_DISABLED_AGENTS_CONFIG,
			"--config",
			CODEX_DISABLED_WEB_SEARCH_CONFIG,
			"--config",
			codexUntrustedProjectConfig(fixture.directory),
			...DISABLED_CODEX_FEATURES.flatMap((feature) => ["--disable", feature]),
			"app-server",
			"--listen",
			"stdio://",
		]);
		expect((await readFile(fixture.credentialDigestPath, "utf8")).trim()).toBe(
			createHash("sha256").update(TEST_OWNER_API_KEY, "utf8").digest("hex"),
		);
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
		expect((await readFile(fixture.processCwdPath, "utf8")).trim()).toBe(
			join(fixture.directory, "codex-home"),
		);
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

		const messages = await waitForMessages(fixture.logPath, 9);
		expect(messages.find((message) => message.method === "turn/start")).toMatchObject({
			params: {
				threadId: "thread-1",
				clientUserMessageId: "delivery-id:1",
				cwd: fixture.directory,
				approvalPolicy: "untrusted",
				approvalsReviewer: "user",
				sandboxPolicy: { type: "readOnly", networkAccess: false },
				environments: [],
			},
		});
		expect(messages).not.toContainEqual(expect.objectContaining({ method: "thread/read" }));
	});

	it.each([
		["enabled", [[{ name: "shell_tool", enabled: true }]]],
		["missing", [[{ name: "apps", enabled: false }]]],
		[
			"duplicate",
			[[{ name: "shell_tool", enabled: false }], [{ name: "shell_tool", enabled: false }]],
		],
	] as const)("poisons and tears down on %s shell-tool feature state", async (_name, pages) => {
		const fixture = await fakeAppServer({ featurePages: pages, spawnDescendant: true });
		const client = await openClient(fixture);
		const descendantPid = await waitForPid(fixture.childPidPath);

		await expect(client.startThread()).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "policy",
		});
		await waitForProcessExit(descendantPid);
		await expect(client.readThread("thread-1")).rejects.toMatchObject({ reason: "policy" });
	});

	it("poisons and tears down when feature attestation returns an error", async () => {
		const fixture = await fakeAppServer({ featureError: true, spawnDescendant: true });
		const client = await openClient(fixture);
		const descendantPid = await waitForPid(fixture.childPidPath);

		await expect(client.startThread()).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "policy",
		});
		await waitForProcessExit(descendantPid);
	});

	it.each([
		["altered trust", { effectiveTrust: "trusted" as const }],
		["effective MCP server", { effectiveMcpServers: { marker: { command: "/bin/false" } } }],
	] as const)("rejects %s before starting a thread", async (_name, options) => {
		const fixture = await fakeAppServer({ ...options, spawnDescendant: true });
		const client = await openClient(fixture);
		const descendantPid = await waitForPid(fixture.childPidPath);

		await expect(client.startThread()).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "policy",
		});
		await waitForProcessExit(descendantPid);
		const messages = await waitForMessages(fixture.logPath, 5);
		expect(messages).not.toContainEqual(expect.objectContaining({ method: "thread/start" }));
	});

	it("allows only a cold resume and pins the resumed thread configuration", async () => {
		const fixture = await fakeAppServer({
			featurePages: [[{ name: "apps", enabled: false }], [{ name: "shell_tool", enabled: false }]],
		});
		const client = await openClient(fixture);

		await expect(client.resumeThread("thread-1")).resolves.toMatchObject({
			thread: { id: "thread-1" },
			approvalPolicy: "untrusted",
		});
		await client.startReadOnlyTurn({
			threadId: "thread-1",
			clientUserMessageId: "resumed-delivery:1",
			text: "Return a bounded reply.",
			cwd: fixture.workspacePath,
			outputSchema: {
				type: "object",
				properties: { kind: { const: "reply" } },
				required: ["kind"],
				additionalProperties: false,
			},
		});
		await expect(client.resumeThread("thread-1")).rejects.toMatchObject({
			name: "CodexAppServerError",
			reason: "policy",
		});

		const messages = await waitForMessages(fixture.logPath, 13);
		const resumes = messages.filter((message) => message.method === "thread/resume");
		expect(resumes).toEqual([
			expect.objectContaining({
				params: {
					threadId: "thread-1",
					cwd: fixture.workspacePath,
					approvalPolicy: "untrusted",
					approvalsReviewer: "user",
					sandbox: "read-only",
					config: {
						projects: { [fixture.workspacePath]: { trust_level: "untrusted" } },
						features: { shell_tool: false },
					},
				},
			}),
		]);
		expect(messages.filter((message) => message.method === "thread/loaded/list")).toEqual([
			expect.objectContaining({ params: { limit: 256 } }),
			expect.objectContaining({ params: { limit: 256 } }),
		]);
		expect(messages.find((message) => message.method === "turn/start")).toMatchObject({
			params: expect.objectContaining({
				threadId: "thread-1",
				environments: [],
			}),
		});
		expect(messages.filter((message) => message.method === "experimentalFeature/list")).toEqual([
			expect.objectContaining({ params: { threadId: "thread-1" } }),
			expect.objectContaining({ params: { threadId: "thread-1", cursor: "page-1" } }),
		]);
	});

	it("ignores malicious repository config on direct start and cold resume", async () => {
		const workspace = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-malicious-repo-")));
		const markerPath = join(workspace, "mcp-launched");
		try {
			await Promise.all([mkdir(join(workspace, ".git")), mkdir(join(workspace, ".codex"))]);
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

			const startFixture = await fakeAppServer({
				workspacePath: workspace,
				maliciousMcpMarkerPath: markerPath,
			});
			const startClient = await openClient(startFixture);
			await startClient.startThread();
			const startMessages = await waitForMessages(startFixture.logPath, 8);
			expect((await readFile(startFixture.processCwdPath, "utf8")).trim()).toBe(
				join(startFixture.directory, "codex-home"),
			);
			expect(startMessages.at(-1)).toMatchObject({
				method: "config/read",
				params: {
					cwd: join(startFixture.directory, "codex-home"),
					includeLayers: false,
				},
			});
			await expect(
				access(join(startFixture.directory, "codex-home", "config.toml")),
			).rejects.toMatchObject({ code: "ENOENT" });
			await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });

			const resumeFixture = await fakeAppServer({
				workspacePath: workspace,
				maliciousMcpMarkerPath: markerPath,
			});
			const resumeClient = await openClient(resumeFixture);
			await resumeClient.resumeThread("thread-1");
			const resumeMessages = await waitForMessages(resumeFixture.logPath, 9);
			expect(resumeMessages.find((message) => message.method === "thread/resume")).toMatchObject({
				params: {
					threadId: "thread-1",
					cwd: workspace,
					approvalPolicy: "untrusted",
					approvalsReviewer: "user",
					sandbox: "read-only",
					config: {
						projects: { [workspace]: { trust_level: "untrusted" } },
						features: { shell_tool: false },
					},
				},
			});
			await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
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
		expect(await waitForMessages(fixture.logPath, 5)).not.toContainEqual(
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
		const resumeMessages = await waitForMessages(resumeFixture.logPath, 7);
		expect(resumeMessages.filter((message) => message.method === "thread/resume")).toHaveLength(1);
		expect(resumeMessages).not.toContainEqual(expect.objectContaining({ method: "thread/read" }));

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

	it("preserves the exact authority reason after transport EOF and group teardown", async () => {
		const fixture = await fakeAppServer({ ignoreRead: true, spawnDescendant: true });
		const authority = new AbortController();
		const client = await openClient(fixture, { authoritySignal: authority.signal });
		const descendantPid = await waitForPid(fixture.childPidPath);
		const pending = client.readThread("thread-1");
		await waitForMessages(fixture.logPath, 5);

		authority.abort("expired");

		await expect(settleWithin(pending, 1_000)).rejects.toBe("expired");
		await waitForProcessExit(descendantPid);
	});

	it("does not release a queued notification after authority revocation", async () => {
		const fixture = await fakeAppServer({ notificationMode: "valid" });
		const authority = new AbortController();
		let releaseTeardown!: () => void;
		const teardownGate = new Promise<void>((resolve) => {
			releaseTeardown = resolve;
		});
		const client = await openClient(fixture, {
			authoritySignal: authority.signal,
			processFactory: async (options) => {
				const processRef = await startCodexAppServerProcess(options);
				return {
					...processRef,
					authorityTermination: processRef.authorityTermination?.catch(async (error) => {
						if (error !== "expired") throw error;
						await teardownGate;
						throw error;
					}),
				};
			},
		});
		await client.startThread();
		await delay(25);
		const pending = client.events()[Symbol.asyncIterator]().next();

		authority.abort("expired");
		const early = await Promise.race([
			pending.then(
				() => "settled",
				() => "settled",
			),
			delay(25).then(() => "pending"),
		]);
		expect(early).toBe("pending");

		releaseTeardown();
		await expect(settleWithin(pending, 1_000)).rejects.toBe("expired");
	});

	it("revalidates authority after a clean event queue completion", async () => {
		const fixture = await fakeAppServer();
		const authority = new AbortController();
		const client = await openClient(fixture, { authoritySignal: authority.signal });
		const pending = client.events()[Symbol.asyncIterator]().next();
		await delay(0);

		const closing = client.close();
		authority.abort("expired");

		await expect(settleWithin(pending, 1_000)).rejects.toBe("expired");
		await expect(settleWithin(closing, 1_000)).rejects.toBe("expired");
		clients.splice(clients.indexOf(client), 1);
	});

	it("keeps teardown-proof failure ahead of authority and request timeout failures", async () => {
		const fixture = await fakeAppServer({ ignoreRead: true });
		const authority = new AbortController();
		const teardownFailure = new Error("authority teardown proof failed");
		const requestTimeoutMs = 1_000;
		const teardownFailureDelayMs = requestTimeoutMs + 250;
		const client = await openClient(fixture, {
			authoritySignal: authority.signal,
			requestTimeoutMs,
			processFactory: async (options) => {
				const processRef = await startCodexAppServerProcess(options);
				return {
					...processRef,
					authorityTermination: processRef.authorityTermination?.catch(async (error) => {
						if (error !== "expired") throw error;
						await delay(teardownFailureDelayMs);
						throw teardownFailure;
					}),
				};
			},
		});
		const pending = client.readThread("thread-1");
		await waitForMessages(fixture.logPath, 5);

		authority.abort("expired");
		const failure = await settleWithin(
			pending.catch((error: unknown) => error),
			4_000,
		);

		expect(failure).toBe(teardownFailure);
		clients.splice(clients.indexOf(client), 1);
		await client.close().catch(() => undefined);
	});

	it("surfaces cleanup failure instead of the prior provider failure", async () => {
		const fixture = await fakeAppServer({ initializedFailure: "invalid_json" });
		const cleanupFailure = new Error("process-group cleanup was not proven");
		await expect(
			CodexAppServerClient.start(
				{
					command: { executable: fixture.scriptPath },
					workspaceCwd: fixture.directory,
					capsuleDirectory: fixture.directory,
					env: fixture.env,
					boundary: directCodexProcessBoundaryForTests,
					authoritySignal: new AbortController().signal,
					processFactory: async (options) => {
						const processRef = await startCodexAppServerProcess(options);
						return {
							...processRef,
							stop: async () => {
								await processRef.stop?.();
								throw cleanupFailure;
							},
						};
					},
				},
				createFakeCodexOwnerCredential(TEST_OWNER_API_KEY),
			),
		).rejects.toBe(cleanupFailure);
	});
});

async function fakeAppServer(
	options: Parameters<typeof createFakeAppServer>[0] = {},
): Promise<FakeAppServerFixture> {
	const fixture = await createFakeAppServer(options);
	fixtures.push(fixture);
	return fixture;
}

async function openClient(
	fixture: FakeAppServerFixture,
	options: {
		readonly authoritySignal?: AbortSignal;
		readonly requestTimeoutMs?: number;
		readonly processFactory?: Parameters<typeof CodexAppServerClient.start>[0]["processFactory"];
	} = {},
): Promise<CodexAppServerClient> {
	const client = await CodexAppServerClient.start(
		{
			command: { executable: fixture.scriptPath },
			workspaceCwd: fixture.workspacePath,
			capsuleDirectory: fixture.directory,
			env: fixture.env,
			boundary: directCodexProcessBoundaryForTests,
			authoritySignal: options.authoritySignal ?? new AbortController().signal,
			requestTimeoutMs: options.requestTimeoutMs,
			processFactory: options.processFactory,
		},
		createFakeCodexOwnerCredential(TEST_OWNER_API_KEY),
	);
	clients.push(client);
	return client;
}

function settleWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
	return Promise.race([
		promise,
		delay(milliseconds).then(() => {
			throw new Error("Codex client did not settle within the expected authority bound");
		}),
	]);
}
