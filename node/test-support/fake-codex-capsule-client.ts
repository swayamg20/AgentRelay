import type { JsonValue } from "@agentrelay/protocol";
import { BoundedAsyncQueue } from "../src/bounded-async-queue.js";
import type {
	CodexAppServerClientEvent,
	StartCodexTurnInput,
} from "../src/codex-app-server-client.js";
import { SUPPORTED_CODEX_CLI_VERSION } from "../src/codex-app-server-protocol.js";
import type {
	CodexThread,
	CodexThreadStartResult,
	CodexTurn,
} from "../src/codex-app-server-protocol.js";
import type { CodexCapsuleTurnIntent } from "../src/codex-capsule-prompt.js";
import type { CodexCapsuleClient } from "../src/codex-capsule-runner.js";

export type FakeTurnStartBehavior = "in_progress" | "complete" | "throw_after_record";

export interface FakeCodexProviderState {
	readonly turns: CodexTurn[];
}

export class FakeCodexCapsuleClient implements CodexCapsuleClient {
	readonly calls: string[] = [];
	readonly turnStarts: StartCodexTurnInput[] = [];
	readonly interrupts: Array<{ threadId: string; turnId: string }> = [];
	readonly #events = new BoundedAsyncQueue<CodexAppServerClientEvent>(
		100,
		100,
		() => new Error("Fake Codex event queue overflowed"),
	);
	readonly #turns: CodexTurn[];
	readonly #cwd: string;
	readonly #threadId: string;
	startBehavior: FakeTurnStartBehavior = "complete";
	threadStartBarrier: Promise<void> | null = null;
	threadStartFailure: Error | null = null;
	interruptBarrier: Promise<void> | null = null;
	interruptFailure: Error | null = null;
	readCalls = 0;
	closeCalls = 0;
	eventConsumers = 0;

	constructor(
		cwd: string,
		threadId = "thread-1",
		providerState: FakeCodexProviderState = { turns: [] },
	) {
		this.#cwd = cwd;
		this.#threadId = threadId;
		this.#turns = providerState.turns;
	}

	async startThread(): Promise<CodexThreadStartResult> {
		this.calls.push("startThread");
		await this.threadStartBarrier;
		if (this.threadStartFailure !== null) throw this.threadStartFailure;
		return this.threadResult();
	}

	async resumeThread(threadId: string): Promise<CodexThreadStartResult> {
		this.calls.push("resumeThread");
		if (threadId !== this.#threadId) throw new Error("Fake Codex resumed the wrong thread");
		return this.threadResult();
	}

	async readThread(threadId: string): Promise<CodexThread> {
		this.calls.push("readThread");
		this.readCalls += 1;
		if (threadId !== this.#threadId) throw new Error("Fake Codex read the wrong thread");
		return this.thread();
	}

	async startReadOnlyTurn(input: StartCodexTurnInput): Promise<CodexTurn> {
		this.calls.push("startReadOnlyTurn");
		this.turnStarts.push(structuredClone(input));
		const turn = providerTurn(`turn-${this.turnStarts.length}`, "inProgress", input);
		this.#turns.push(turn);
		if (this.startBehavior === "throw_after_record") {
			this.complete(turn.id, "completed");
			throw new Error("Fake lost the turn/start response after provider acceptance");
		}
		if (this.startBehavior === "complete") {
			queueMicrotask(() => this.complete(turn.id, "completed"));
		}
		return structuredClone(turn);
	}

	async interruptTurn(threadId: string, turnId: string): Promise<void> {
		this.calls.push("interruptTurn");
		this.interrupts.push({ threadId, turnId });
		if (threadId !== this.#threadId) throw new Error("Fake Codex interrupted the wrong thread");
		await this.interruptBarrier;
		if (this.interruptFailure !== null) throw this.interruptFailure;
		this.complete(turnId, "interrupted");
	}

	events(): AsyncIterable<CodexAppServerClientEvent> {
		this.calls.push("events");
		this.eventConsumers += 1;
		return this.#events;
	}

	async close(): Promise<void> {
		this.closeCalls += 1;
		this.#events.close();
	}

	seedTurn(intent: CodexCapsuleTurnIntent, status: CodexTurn["status"]): CodexTurn {
		const input: StartCodexTurnInput = {
			threadId: this.#threadId,
			clientUserMessageId: intent.clientUserMessageId,
			text: intent.text,
			cwd: this.#cwd,
			outputSchema: intent.outputSchema,
		};
		const turn = providerTurn(`seeded-${this.#turns.length + 1}`, status, input);
		this.#turns.push(turn);
		return structuredClone(turn);
	}

	failEvents(error: Error): void {
		this.#events.close(error);
	}

	private complete(turnId: string, status: "completed" | "interrupted"): void {
		const index = this.#turns.findIndex((turn) => turn.id === turnId);
		if (index < 0) throw new Error(`Fake Codex turn not found: ${turnId}`);
		const previous = this.#turns[index]!;
		const input = inputFromTurn(previous, this.#cwd, this.#threadId);
		const terminal = providerTurn(turnId, status, input);
		this.#turns[index] = terminal;
		if (status === "completed") {
			this.push({
				kind: "notification",
				notification: {
					method: "thread/tokenUsage/updated",
					params: {
						threadId: this.#threadId,
						turnId,
						tokenUsage: {
							total: usage(20, 5),
							last: usage(20, 5),
							modelContextWindow: 128_000,
						},
					},
				},
			});
		}
		this.push({
			kind: "notification",
			notification: {
				method: "turn/completed",
				params: { threadId: this.#threadId, turn: structuredClone(terminal) },
			},
		});
	}

	private push(event: CodexAppServerClientEvent): void {
		this.#events.push(event, 1);
	}

	private threadResult(): CodexThreadStartResult {
		return {
			thread: this.thread(),
			model: "fake-model",
			modelProvider: "openai",
			serviceTier: null,
			cwd: this.#cwd,
			instructionSources: [],
			approvalPolicy: "never",
			approvalsReviewer: "user",
			sandbox: { type: "readOnly", networkAccess: false },
			reasoningEffort: null,
		};
	}

	private thread(): CodexThread {
		return {
			id: this.#threadId,
			sessionId: this.#threadId,
			ephemeral: false,
			modelProvider: "openai",
			status: { type: "idle" },
			cwd: this.#cwd,
			cliVersion: SUPPORTED_CODEX_CLI_VERSION,
			turns: structuredClone(this.#turns),
		};
	}
}

function providerTurn(
	id: string,
	status: CodexTurn["status"],
	input: StartCodexTurnInput,
): CodexTurn {
	const items: Array<{ [key: string]: unknown; type: string; id: string }> = [
		{
			type: "userMessage",
			id: `${id}-user`,
			clientId: input.clientUserMessageId,
			content: [{ type: "text", text: input.text, text_elements: [] }],
		},
	];
	if (status === "completed") {
		items.push({
			type: "agentMessage",
			id: `${id}-answer`,
			text: JSON.stringify({ kind: "reply", message_type: "progress", message: "Done" }),
			phase: "final_answer",
		});
	}
	return {
		id,
		items,
		itemsView: "full",
		status,
		error: null,
		startedAt: 1,
		completedAt: status === "inProgress" ? null : 2,
		durationMs: status === "inProgress" ? null : 1_000,
	};
}

function inputFromTurn(turn: CodexTurn, cwd: string, threadId: string): StartCodexTurnInput {
	const user = turn.items.find((item) => item.type === "userMessage") as {
		clientId: string;
		content: Array<{ text: string }>;
	};
	return {
		threadId,
		clientUserMessageId: user.clientId,
		text: user.content[0]!.text,
		cwd,
		outputSchema: {} as JsonValue,
	};
}

function usage(inputTokens: number, outputTokens: number) {
	return {
		totalTokens: inputTokens + outputTokens,
		inputTokens,
		cachedInputTokens: 0,
		cacheWriteInputTokens: 0,
		outputTokens,
		reasoningOutputTokens: 0,
	};
}
