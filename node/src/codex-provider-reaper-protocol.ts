import { uuidSchema } from "@agentrelay/protocol";
import { z } from "zod";
import {
	CODEX_PROVIDER_STOP_CAUSES,
	type CodexProviderStopCause,
} from "./codex-provider-generation-state.js";
import { absolutePathSchema } from "./codex-provider-supervisor-protocol.js";

const initializeSchema = z
	.object({
		version: z.literal(1),
		kind: z.literal("initialize"),
		capsule_id: uuidSchema,
		generation_id: uuidSchema,
		lock_path: absolutePathSchema,
		state_directory: absolutePathSchema,
		target_process_group_id: z.number().int().positive(),
		deadline_at_ms: z.number().int().safe().positive(),
		heartbeat_timeout_ms: z.number().int().min(250).max(60_000),
	})
	.strict();

const heartbeatSchema = z
	.object({
		version: z.literal(1),
		kind: z.literal("heartbeat"),
		generation_id: uuidSchema,
	})
	.strict();

const stopSchema = z
	.object({
		version: z.literal(1),
		kind: z.literal("stop"),
		generation_id: uuidSchema,
		cause: z.enum(CODEX_PROVIDER_STOP_CAUSES),
	})
	.strict();

const commandSchema = z.discriminatedUnion("kind", [initializeSchema, heartbeatSchema, stopSchema]);

const readySchema = z
	.object({
		version: z.literal(1),
		kind: z.literal("ready"),
		generation_id: uuidSchema,
	})
	.strict();

export type CodexProviderReaperCommand = z.infer<typeof commandSchema>;
export type CodexProviderReaperInit = z.infer<typeof initializeSchema>;
export type CodexProviderReaperEvent = z.infer<typeof readySchema>;

export function parseCodexProviderReaperCommand(value: unknown): CodexProviderReaperCommand {
	return commandSchema.parse(value);
}

export function parseCodexProviderReaperEvent(value: unknown): CodexProviderReaperEvent {
	return readySchema.parse(value);
}

export function initializeReaperCommand(input: {
	readonly capsuleId: string;
	readonly generationId: string;
	readonly lockPath: string;
	readonly stateDirectory: string;
	readonly targetProcessGroupId: number;
	readonly deadlineAtMs: number;
	readonly heartbeatTimeoutMs: number;
}): CodexProviderReaperCommand {
	return initializeSchema.parse({
		version: 1,
		kind: "initialize",
		capsule_id: input.capsuleId,
		generation_id: input.generationId,
		lock_path: input.lockPath,
		state_directory: input.stateDirectory,
		target_process_group_id: input.targetProcessGroupId,
		deadline_at_ms: input.deadlineAtMs,
		heartbeat_timeout_ms: input.heartbeatTimeoutMs,
	});
}

export function heartbeatReaperCommand(generationId: string): CodexProviderReaperCommand {
	return heartbeatSchema.parse({ version: 1, kind: "heartbeat", generation_id: generationId });
}

export function stopReaperCommand(
	generationId: string,
	cause: CodexProviderStopCause,
): CodexProviderReaperCommand {
	return stopSchema.parse({
		version: 1,
		kind: "stop",
		generation_id: generationId,
		cause,
	});
}

export function readyReaperEvent(generationId: string): CodexProviderReaperEvent {
	return readySchema.parse({ version: 1, kind: "ready", generation_id: generationId });
}
