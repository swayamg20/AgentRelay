import { isAbsolute, normalize } from "node:path";
import { uuidSchema } from "@agentrelay/protocol";
import { z } from "zod";
import {
	CODEX_PROVIDER_STOP_CAUSES,
	type CodexProviderObservation,
	type CodexProviderStopCause,
} from "./codex-provider-generation-state.js";

export const absolutePathSchema = z
	.string()
	.min(1)
	.max(4_096)
	.refine((value) => isAbsolute(value) && normalize(value) === value && !value.includes("\0"));
const argumentSchema = z
	.string()
	.max(16_384)
	.refine((value) => !value.includes("\0"));
const environmentSchema = z
	.record(
		z
			.string()
			.max(65_536)
			.refine((value) => !value.includes("\0")),
	)
	.refine((value) => Object.keys(value).length <= 128);

export const codexPreparedProcessSchema = z
	.object({
		executable: absolutePathSchema,
		argv: z.array(argumentSchema).max(256),
		cwd: absolutePathSchema,
		env: environmentSchema,
	})
	.strict();

export type CodexPreparedProcess = z.infer<typeof codexPreparedProcessSchema>;

const initSchema = z
	.object({
		version: z.literal(1),
		kind: z.literal("initialize"),
		capsule_id: uuidSchema,
		generation_id: uuidSchema,
		owner_pid: z.number().int().positive(),
		lock_path: absolutePathSchema,
		state_directory: absolutePathSchema,
		deadline_at_ms: z.number().int().safe().positive(),
		heartbeat_timeout_ms: z.number().int().min(250).max(60_000),
		heartbeat_record_ms: z.number().int().min(100).max(60_000),
		reaper: codexPreparedProcessSchema,
		version_probe: codexPreparedProcessSchema,
		app_server: codexPreparedProcessSchema,
	})
	.strict();

const heartbeatSchema = z
	.object({
		version: z.literal(1),
		kind: z.literal("heartbeat"),
		generation_id: uuidSchema,
	})
	.strict();

const terminateSchema = z
	.object({
		version: z.literal(1),
		kind: z.literal("terminate"),
		generation_id: uuidSchema,
		cause: z.enum(CODEX_PROVIDER_STOP_CAUSES),
	})
	.strict();

const supervisorCommandSchema = z.discriminatedUnion("kind", [
	initSchema,
	heartbeatSchema,
	terminateSchema,
]);

export type CodexProviderSupervisorInit = z.infer<typeof initSchema>;
export type CodexProviderSupervisorCommand = z.infer<typeof supervisorCommandSchema>;

const readySchema = z
	.object({
		version: z.literal(1),
		kind: z.literal("ready"),
		generation_id: uuidSchema,
	})
	.strict();

const terminalSchema = z
	.object({
		version: z.literal(1),
		kind: z.literal("terminal"),
		generation_id: uuidSchema,
		cause: z.enum(CODEX_PROVIDER_STOP_CAUSES),
		observation: z.enum(["stopped", "crashed", "unresponsive"]),
	})
	.strict();

const failureSchema = z
	.object({
		version: z.literal(1),
		kind: z.literal("failure"),
		generation_id: uuidSchema,
		code: z.enum(["invalid_startup", "version", "spawn", "state", "internal"]),
	})
	.strict();

const supervisorEventSchema = z.discriminatedUnion("kind", [
	readySchema,
	terminalSchema,
	failureSchema,
]);

export type CodexProviderSupervisorEvent = z.infer<typeof supervisorEventSchema>;

export function parseCodexProviderSupervisorCommand(
	value: unknown,
): CodexProviderSupervisorCommand {
	return supervisorCommandSchema.parse(value);
}

export function parseCodexProviderSupervisorEvent(value: unknown): CodexProviderSupervisorEvent {
	return supervisorEventSchema.parse(value);
}

export function terminalSupervisorEvent(
	generationId: string,
	cause: CodexProviderStopCause,
	observation: CodexProviderObservation,
): CodexProviderSupervisorEvent {
	return terminalSchema.parse({
		version: 1,
		kind: "terminal",
		generation_id: generationId,
		cause,
		observation,
	});
}

export function terminateSupervisorCommand(
	generationId: string,
	cause: CodexProviderStopCause,
): CodexProviderSupervisorCommand {
	return terminateSchema.parse({
		version: 1,
		kind: "terminate",
		generation_id: generationId,
		cause,
	});
}

export function sanitizePreparedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
	return environmentSchema.parse(
		Object.fromEntries(
			Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
		),
	);
}
