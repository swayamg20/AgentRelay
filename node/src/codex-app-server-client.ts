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
	codexInitializeResponseSchema,
	codexRelevantNotificationSchema,
	codexThreadReadResultSchema,
	codexThreadStartResultSchema,
	codexTurnStartResultSchema,
	isCodexRelevantNotificationMethod,
} from "./codex-app-server-protocol.js";
import { CodexAppServerTransport } from "./codex-app-server-transport.js";
import type { CodexProcessBoundary } from "./codex-process-boundary.js";

export { CodexAppServerError } from "./codex-app-server-process.js";
export type { CodexAppServerCommand } from "./codex-app-server-process.js";
export { CodexAppServerResponseError } from "./codex-app-server-transport.js";
export type { StartCodexTurnInput } from "./codex-app-server-policy.js";

export interface CodexAppServerClientOptions {
	readonly command: CodexAppServerCommand;
	readonly cwd: string;
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

	static async start(options: CodexAppServerClientOptions): Promise<CodexAppServerClient> {
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
			cwd: options.cwd,
			env,
			boundary: options.boundary,
			authoritySignal: options.authoritySignal,
			requestTimeoutMs: options.requestTimeoutMs,
			processFactory: options.processFactory,
			handleServerRequest: denyCodexServerRequest,
		});
		const client = new CodexAppServerClient(transport, codexHome, options.authoritySignal);
		try {
			await client.initialize();
			return client;
		} catch (error) {
			await client.close();
			throw error;
		}
	}

	get identity(): CodexInitializeResponse {
		if (this.#identity === null)
			throw new CodexAppServerError("closed", "Client is not initialized");
		return structuredClone(this.#identity);
	}

	async startThread(): Promise<CodexThreadStartResult> {
		return this.runProviderCall(async () => {
			const result = parseCodexProviderResult(
				codexThreadStartResultSchema,
				await this.#transport.request("thread/start", {
					cwd: this.#transport.cwd,
					approvalPolicy: "never",
					approvalsReviewer: "user",
					sandbox: "read-only",
					serviceName: "agentrelay_node",
					ephemeral: false,
				}),
				"thread/start",
			);
			assertReadOnlyThread(result, this.#transport.cwd);
			return result;
		});
	}

	async resumeThread(threadIdValue: string): Promise<CodexThreadStartResult> {
		this.assertUsable();
		const threadId = parseCodexReference(threadIdValue);
		return this.runProviderCall(async () => {
			const result = parseCodexProviderResult(
				codexThreadStartResultSchema,
				await this.#transport.request("thread/resume", {
					threadId,
					cwd: this.#transport.cwd,
					approvalPolicy: "never",
					approvalsReviewer: "user",
					sandbox: "read-only",
				}),
				"thread/resume",
			);
			assertReadOnlyThread(result, this.#transport.cwd, threadId);
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
			assertThreadVersionAndScope(result.thread, this.#transport.cwd, threadId);
			return result.thread;
		});
	}

	async startReadOnlyTurn(inputValue: StartCodexTurnInput): Promise<CodexTurn> {
		this.assertUsable();
		const input = parseStartCodexTurnInput(inputValue, this.#transport.cwd);
		return this.runProviderCall(async () => {
			const result = parseCodexProviderResult(
				codexTurnStartResultSchema,
				await this.#transport.request("turn/start", {
					threadId: input.threadId,
					clientUserMessageId: input.clientUserMessageId,
					input: [{ type: "text", text: input.text, text_elements: [] }],
					cwd: this.#transport.cwd,
					approvalPolicy: "never",
					approvalsReviewer: "user",
					sandboxPolicy: { type: "readOnly", networkAccess: false },
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
						experimentalApi: false,
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
