import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { buildCodexChildEnvironment, prepareCodexHome } from "./capsule-environment.js";
import {
	CODEX_APP_SERVER_CLIENT_VERSION,
	QUIET_CODEX_NOTIFICATION_METHODS,
	type StartCodexTurnInput,
	assertCodexIdentity,
	assertReadOnlyThread,
	assertThreadVersionAndScope,
	codexEmptyResultSchema,
	denyCodexServerRequest,
	parseCodexProviderResult,
	parseCodexReference,
	parseStartCodexTurnInput,
} from "./codex-app-server-policy.js";
import {
	type CodexAppServerCommand,
	CodexAppServerError,
	type CodexAppServerProcessFactory,
} from "./codex-app-server-process.js";
import {
	CODEX_APP_SERVER_CLIENT_NAME,
	type CodexInitializeResponse,
	type CodexRelevantNotification,
	type CodexThread,
	type CodexThreadStartResult,
	type CodexTurn,
	codexApiKeyAccountResponseSchema,
	codexApiKeyLoginResponseSchema,
	codexConfigReadResultSchema,
	codexExperimentalFeatureListResultSchema,
	codexInitializeResponseSchema,
	codexRelevantNotificationSchema,
	codexThreadLoadedListResultSchema,
	codexThreadReadResultSchema,
	codexThreadStartResultSchema,
	codexTurnStartResultSchema,
	isCodexRelevantNotificationMethod,
} from "./codex-app-server-protocol.js";
import {
	CodexAppServerResponseError,
	CodexAppServerTransport,
} from "./codex-app-server-transport.js";
import { type CodexOwnerCredential, CodexOwnerCredentialError } from "./codex-owner-credential.js";
import type { CodexProcessBoundary } from "./codex-process-boundary.js";

export { CodexAppServerError } from "./codex-app-server-process.js";
export type { CodexAppServerCommand } from "./codex-app-server-process.js";
export { CodexAppServerResponseError } from "./codex-app-server-transport.js";
export type { StartCodexTurnInput } from "./codex-app-server-policy.js";

export interface CodexAppServerClientOptions {
	readonly command: CodexAppServerCommand;
	readonly workspaceCwd: string;
	readonly capsuleDirectory: string;
	readonly env: NodeJS.ProcessEnv;
	readonly boundary: CodexProcessBoundary;
	readonly authoritySignal: AbortSignal;
	readonly requestTimeoutMs?: number;
	readonly processFactory?: CodexAppServerProcessFactory;
}

export interface CodexAppServerClientEvent {
	readonly kind: "notification";
	readonly notification: CodexRelevantNotification;
}

/** Policy-limited app-server facade used by one read-only Mission Capsule. */
export class CodexAppServerClient {
	readonly #transport: CodexAppServerTransport;
	readonly #codexHome: string;
	readonly #authoritySignal: AbortSignal;
	#identity: CodexInitializeResponse | null = null;
	#failure: Error | null = null;
	#closed = false;
	#eventsClaimed = false;

	private constructor(
		transport: CodexAppServerTransport,
		codexHome: string,
		authoritySignal: AbortSignal,
	) {
		this.#transport = transport;
		this.#codexHome = codexHome;
		this.#authoritySignal = authoritySignal;
	}

	static async start(
		options: CodexAppServerClientOptions,
		ownerCredential: CodexOwnerCredential,
	): Promise<CodexAppServerClient> {
		let client: CodexAppServerClient | null = null;
		try {
			let codexHome: string;
			try {
				codexHome = await prepareCodexHome(options.capsuleDirectory);
			} catch (error) {
				throw new CodexAppServerError(
					"policy",
					"Codex home must be a canonical, current-user-owned mode-0700 directory",
					{ cause: error },
				);
			}
			const env = buildCodexChildEnvironment(options.env, codexHome);
			const transport = await CodexAppServerTransport.start({
				command: options.command,
				workspaceCwd: options.workspaceCwd,
				processCwd: codexHome,
				env,
				boundary: options.boundary,
				authoritySignal: options.authoritySignal,
				requestTimeoutMs: options.requestTimeoutMs,
				processFactory: options.processFactory,
				handleServerRequest: denyCodexServerRequest,
			});
			client = new CodexAppServerClient(transport, codexHome, options.authoritySignal);
			await client.initialize();
			await client.authenticate(ownerCredential);
			return client;
		} catch (error) {
			await client?.close();
			throw error;
		} finally {
			ownerCredential.dispose();
		}
	}

	get identity(): CodexInitializeResponse {
		if (this.#identity === null)
			throw new CodexAppServerError("closed", "Client is not initialized");
		return structuredClone(this.#identity);
	}

	async startThread(): Promise<CodexThreadStartResult> {
		return this.runProviderCall(async () => {
			await this.attestEffectiveConfig(this.#transport.workspaceCwd);
			const result = parseCodexProviderResult(
				codexThreadStartResultSchema,
				await this.#transport.request("thread/start", {
					cwd: this.#transport.workspaceCwd,
					approvalPolicy: "untrusted",
					approvalsReviewer: "user",
					sandbox: "read-only",
					config: threadConfig(this.#transport.workspaceCwd),
					environments: [],
					serviceName: "agentrelay_node",
					ephemeral: false,
				}),
				"thread/start",
			);
			assertReadOnlyThread(result, this.#transport.workspaceCwd);
			await this.attestDisabledShellTool(result.thread.id);
			await this.attestPrivateHome();
			return result;
		});
	}

	async resumeThread(threadIdValue: string): Promise<CodexThreadStartResult> {
		this.assertUsable();
		const threadId = parseCodexReference(threadIdValue);
		return this.runProviderCall(async () => {
			await this.attestEffectiveConfig(this.#transport.workspaceCwd);
			await this.assertColdResume(threadId);
			const result = parseCodexProviderResult(
				codexThreadStartResultSchema,
				await this.#transport.request("thread/resume", {
					threadId,
					cwd: this.#transport.workspaceCwd,
					approvalPolicy: "untrusted",
					approvalsReviewer: "user",
					sandbox: "read-only",
					config: threadConfig(this.#transport.workspaceCwd),
				}),
				"thread/resume",
			);
			assertReadOnlyThread(result, this.#transport.workspaceCwd, threadId);
			await this.attestDisabledShellTool(result.thread.id);
			await this.attestPrivateHome();
			return result;
		});
	}

	async readThread(threadIdValue: string): Promise<CodexThread> {
		this.assertUsable();
		const threadId = parseCodexReference(threadIdValue);
		return this.runProviderCall(async () => {
			const result = parseCodexProviderResult(
				codexThreadReadResultSchema,
				await this.#transport.request("thread/read", { threadId, includeTurns: true }),
				"thread/read",
			);
			assertThreadVersionAndScope(result.thread, this.#transport.workspaceCwd, threadId);
			return result.thread;
		});
	}

	async startReadOnlyTurn(inputValue: StartCodexTurnInput): Promise<CodexTurn> {
		this.assertUsable();
		const input = parseStartCodexTurnInput(inputValue, this.#transport.workspaceCwd);
		return this.runProviderCall(async () => {
			const result = parseCodexProviderResult(
				codexTurnStartResultSchema,
				await this.#transport.request("turn/start", {
					threadId: input.threadId,
					clientUserMessageId: input.clientUserMessageId,
					input: [{ type: "text", text: input.text, text_elements: [] }],
					cwd: this.#transport.workspaceCwd,
					approvalPolicy: "untrusted",
					approvalsReviewer: "user",
					sandboxPolicy: { type: "readOnly", networkAccess: false },
					environments: [],
					outputSchema: input.outputSchema,
				}),
				"turn/start",
			);
			if (result.turn.status !== "inProgress") {
				throw new CodexAppServerError("protocol", "Codex accepted a turn in a terminal state");
			}
			return result.turn;
		});
	}

	async interruptTurn(threadIdValue: string, turnIdValue: string): Promise<void> {
		this.assertUsable();
		const threadId = parseCodexReference(threadIdValue);
		const turnId = parseCodexReference(turnIdValue);
		await this.runProviderCall(async () => {
			parseCodexProviderResult(
				codexEmptyResultSchema,
				await this.#transport.request("turn/interrupt", { threadId, turnId }),
				"turn/interrupt",
			);
		});
	}

	async *events(): AsyncIterable<CodexAppServerClientEvent> {
		this.assertUsable();
		try {
			await this.#transport.revalidateAuthority();
		} catch (error) {
			throw await this.resolveAuthorityFailure(error);
		}
		if (this.#eventsClaimed) {
			throw new CodexAppServerError("policy", "Codex event stream already has a consumer");
		}
		this.#eventsClaimed = true;
		try {
			for await (const event of this.#transport.events()) {
				if (!isCodexRelevantNotificationMethod(event.method)) continue;
				const notification = parseCodexProviderResult(
					codexRelevantNotificationSchema,
					{ method: event.method, params: event.params },
					`notification ${event.method}`,
				);
				await this.#transport.revalidateAuthority();
				yield {
					kind: "notification",
					notification,
				};
			}
			await this.#transport.revalidateAuthority();
		} catch (error) {
			throw await this.resolveOperationFailure(error);
		}
	}

	async close(): Promise<void> {
		this.#closed = true;
		await this.#transport.close();
	}

	private async initialize(): Promise<void> {
		await this.runProviderCall(async () => {
			const response = parseCodexProviderResult(
				codexInitializeResponseSchema,
				await this.#transport.request("initialize", {
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
				"initialize",
			);
			assertCodexIdentity(response, this.#codexHome);
			this.#identity = response;
			await this.#transport.sendNotification("initialized");
		});
	}

	private async attestEffectiveConfig(cwd: string): Promise<void> {
		let value: unknown;
		try {
			value = await this.#transport.request("config/read", { cwd, includeLayers: false });
		} catch (error) {
			if (!(error instanceof CodexAppServerResponseError)) throw error;
			throw new CodexAppServerError("policy", "Codex effective configuration is unavailable", {
				cause: error,
			});
		}
		const result = parseCodexProviderResult(codexConfigReadResultSchema, value, "config/read");
		assertEffectiveConfig(result.config, this.#transport.workspaceCwd);
	}

	private async attestPrivateHome(): Promise<void> {
		await this.attestEffectiveConfig(this.#codexHome);
		try {
			await lstat(join(this.#codexHome, "config.toml"));
		} catch (error) {
			if (errorCode(error) === "ENOENT") return;
			throw new CodexAppServerError("policy", "Codex private configuration is not inspectable", {
				cause: error,
			});
		}
		throw new CodexAppServerError("policy", "Codex persisted unexpected private configuration");
	}

	private async assertColdResume(threadId: string): Promise<void> {
		let cursor: string | undefined;
		const seenCursors = new Set<string>();
		for (let page = 0; page < 256; page += 1) {
			let value: unknown;
			try {
				value = await this.#transport.request("thread/loaded/list", {
					limit: 256,
					...(cursor === undefined ? {} : { cursor }),
				});
			} catch (error) {
				if (!(error instanceof CodexAppServerResponseError)) throw error;
				throw new CodexAppServerError("policy", "Codex loaded-thread state is unavailable", {
					cause: error,
				});
			}
			const result = parseCodexProviderResult(
				codexThreadLoadedListResultSchema,
				value,
				"thread/loaded/list",
			);
			if (result.data.includes(threadId)) {
				throw new CodexAppServerError("policy", "Codex resume requires a cold stored thread");
			}
			if (result.nextCursor === null) return;
			if (seenCursors.has(result.nextCursor)) {
				throw new CodexAppServerError(
					"protocol",
					"Codex loaded-thread pagination repeated a cursor",
				);
			}
			seenCursors.add(result.nextCursor);
			cursor = result.nextCursor;
		}
		throw new CodexAppServerError("protocol", "Codex loaded-thread pagination exceeded its bound");
	}

	private async attestDisabledShellTool(threadId: string): Promise<void> {
		let cursor: string | undefined;
		const seenCursors = new Set<string>();
		let shellToolEntries = 0;
		for (let page = 0; page < 256; page += 1) {
			let value: unknown;
			try {
				value = await this.#transport.request("experimentalFeature/list", {
					threadId,
					...(cursor === undefined ? {} : { cursor }),
				});
			} catch (error) {
				if (!(error instanceof CodexAppServerResponseError)) throw error;
				throw new CodexAppServerError("policy", "Codex feature state is unavailable", {
					cause: error,
				});
			}
			const result = parseCodexProviderResult(
				codexExperimentalFeatureListResultSchema,
				value,
				"experimentalFeature/list",
			);
			for (const feature of result.data) {
				if (feature.name !== "shell_tool") continue;
				shellToolEntries += 1;
				if (feature.enabled) {
					throw new CodexAppServerError("policy", "Codex shell tool remained enabled");
				}
			}
			if (result.nextCursor === null) {
				if (shellToolEntries !== 1) {
					throw new CodexAppServerError("policy", "Codex shell tool feature state is not singular");
				}
				return;
			}
			if (seenCursors.has(result.nextCursor)) {
				throw new CodexAppServerError("protocol", "Codex feature pagination repeated a cursor");
			}
			seenCursors.add(result.nextCursor);
			cursor = result.nextCursor;
		}
		throw new CodexAppServerError("protocol", "Codex feature pagination exceeded its bound");
	}

	private async authenticate(ownerCredential: CodexOwnerCredential): Promise<void> {
		await this.runProviderCall(async () => {
			try {
				await ownerCredential.use(async (apiKey) => {
					const response = await this.requestAuthentication("account/login/start", {
						type: "apiKey",
						apiKey,
					});
					if (!codexApiKeyLoginResponseSchema.safeParse(response).success) {
						throw authenticationFailure();
					}
				});
			} catch (error) {
				if (error instanceof CodexOwnerCredentialError) throw authenticationFailure();
				throw error;
			}
		});
		await this.runProviderCall(async () => {
			const account = await this.requestAuthentication("account/read", {
				refreshToken: false,
			});
			if (!codexApiKeyAccountResponseSchema.safeParse(account).success) {
				throw authenticationFailure();
			}
		});
	}

	private async requestAuthentication(method: string, params: unknown): Promise<unknown> {
		try {
			return await this.#transport.request(method, params);
		} catch (error) {
			if (error instanceof CodexAppServerResponseError) throw authenticationFailure();
			throw error;
		}
	}

	private async runProviderCall<T>(operation: () => Promise<T>): Promise<T> {
		this.assertUsable();
		try {
			await this.#transport.revalidateAuthority();
		} catch (error) {
			throw await this.resolveAuthorityFailure(error);
		}
		let result: T;
		try {
			result = await operation();
		} catch (error) {
			throw await this.resolveOperationFailure(error);
		}
		try {
			await this.#transport.revalidateAuthority();
		} catch (error) {
			throw await this.resolveAuthorityFailure(error);
		}
		return result;
	}

	private async resolveOperationFailure(error: unknown): Promise<unknown> {
		if (this.#authoritySignal.aborted) {
			try {
				await this.#transport.revalidateAuthority();
			} catch (authorityFailure) {
				return this.resolveAuthorityFailure(authorityFailure);
			}
		}
		if (error instanceof CodexAppServerError && error.reason === "provider") return error;
		return this.poison(error);
	}

	private resolveAuthorityFailure(error: unknown): unknown | Promise<unknown> {
		return this.isAuthorityReason(error) ? error : this.poison(error);
	}

	private async poison(error: unknown): Promise<unknown> {
		const failure =
			error instanceof CodexAppServerError
				? error
				: new CodexAppServerError("protocol", "Codex app-server violated its client contract", {
						cause: error,
					});
		this.#failure ??= failure;
		try {
			await this.#transport.close();
		} catch (cleanupFailure) {
			if (this.isAuthorityReason(cleanupFailure)) return cleanupFailure;
			this.#failure =
				cleanupFailure instanceof Error
					? cleanupFailure
					: new CodexAppServerError("transport", "Codex app-server cleanup could not be proven", {
							cause: cleanupFailure,
						});
		}
		return this.#failure;
	}

	private assertUsable(): void {
		if (this.#failure !== null) throw this.#failure;
		if (this.#closed) throw new CodexAppServerError("closed", "Codex app-server client is closed");
	}

	private isAuthorityReason(error: unknown): boolean {
		return this.#authoritySignal.aborted && error === this.#authoritySignal.reason;
	}
}

function authenticationFailure(): CodexAppServerError {
	return new CodexAppServerError("authentication", "Codex owner authentication failed");
}

function threadConfig(workspaceCwd: string): Record<string, unknown> {
	return {
		projects: { [workspaceCwd]: { trust_level: "untrusted" } },
		features: { shell_tool: false },
	};
}

function assertEffectiveConfig(config: Record<string, unknown>, workspaceCwd: string): void {
	const projects = objectValue(config.projects);
	const project = projects === null ? null : objectValue(projects[workspaceCwd]);
	const features = objectValue(config.features);
	if (project?.trust_level !== "untrusted" || features?.shell_tool !== false) {
		throw new CodexAppServerError(
			"policy",
			"Codex did not preserve the required untrusted project configuration",
		);
	}
	const mcpServers = config.mcp_servers;
	const effectiveMcpServers = objectValue(mcpServers);
	if (
		mcpServers !== undefined &&
		mcpServers !== null &&
		(effectiveMcpServers === null || Object.keys(effectiveMcpServers).length > 0)
	) {
		throw new CodexAppServerError("policy", "Codex effective configuration includes MCP servers");
	}
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
