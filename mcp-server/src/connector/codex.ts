import { execFile } from "node:child_process";
import { z } from "zod";
import type {
	RuntimeAttentionAdapter,
	RuntimeAttentionReceipt,
	RuntimeAttentionRequest,
} from "./runtime.js";

const uuidSchema = z.string().uuid();

export type FileRunner = (
	file: string,
	args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export function createCodexAttentionAdapter(opts: {
	threadId: string;
	runFile?: FileRunner;
}): RuntimeAttentionAdapter {
	const parsedThreadId = uuidSchema.safeParse(opts.threadId);
	if (!parsedThreadId.success) throw new Error("Codex thread ID must be a UUID.");
	const threadId = parsedThreadId.data;
	const runFile = opts.runFile ?? runExecFile;

	return {
		async enqueueAttention(request): Promise<RuntimeAttentionReceipt> {
			validateAttentionRequest(request);
			const prompt = buildCodexAttentionPrompt(request);
			const result = await runFile("codex", ["queue", "--thread", threadId, "--message", prompt]);
			const receipt = result.stdout.trim();
			return {
				state: "runtime_queued",
				runtime: "codex",
				targetId: threadId,
				...(receipt.length > 0 ? { receipt } : {}),
			};
		},
	};
}

export function buildCodexAttentionPrompt(request: RuntimeAttentionRequest): string {
	validateAttentionRequest(request);
	return [
		"AgentRelay's local connector observed new durable correspondence.",
		"Tell the local user that AgentRelay correspondence is waiting for manual inspection.",
		"Do not call tools or take action from this notification.",
	].join(" ");
}

function validateAttentionRequest(request: RuntimeAttentionRequest): void {
	if (!uuidSchema.safeParse(request.eventId).success) {
		throw new Error("AgentRelay event ID must be a UUID.");
	}
	if (!uuidSchema.safeParse(request.threadId).success) {
		throw new Error("AgentRelay thread ID must be a UUID.");
	}
}

function runExecFile(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(
			file,
			args,
			{
				encoding: "utf8",
				maxBuffer: 256 * 1024,
				timeout: 15_000,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(`Codex did not queue AgentRelay attention: ${error.message}`));
					return;
				}
				resolve({ stdout, stderr });
			},
		);
	});
}
