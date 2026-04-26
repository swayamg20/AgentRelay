/**
 * Shared zod schemas for the v0.1 / v0.1.5 MCP tools. Schemas mirror
 * `docs/lld.md` §4 exactly — when they diverge, the doc wins.
 */

import { z } from "zod";

const handle = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/, "expected handle of the form name@team");

export const artifactSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("file_diff"),
		path: z.string().min(1),
		diff: z.string(),
	}),
	z.object({
		type: z.literal("file_ref"),
		path: z.string().min(1),
		git_sha: z.string().optional(),
		lines: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
	}),
	z.object({
		type: z.literal("test_command"),
		command: z.string().min(1),
		cwd: z.string().optional(),
	}),
	z.object({
		type: z.literal("api_contract"),
		schema_url: z.string().url().optional(),
		inline: z.unknown().optional(),
	}),
	z.object({
		type: z.literal("link"),
		url: z.string().url(),
		title: z.string().optional(),
	}),
]);

export type Artifact = z.infer<typeof artifactSchema>;

export const proposedActionSchema = z.object({
	description: z.string().min(1),
	target_files: z.array(z.string().min(1)),
	rationale: z.string().min(1),
	suggested_diff: z.string().optional(),
});

export type ProposedAction = z.infer<typeof proposedActionSchema>;

export const handoffToTeammateInput = z
	.object({
		to: handle,
		intent: z.enum(["inform", "ask_question", "propose_action"]),
		summary: z.string().min(1),
		artifacts: z.array(artifactSchema).optional(),
		question: z.string().optional(),
		proposed_action: proposedActionSchema.optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.superRefine((val, ctx) => {
		if (val.intent === "propose_action" && !val.proposed_action) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["proposed_action"],
				message: "proposed_action is required when intent is 'propose_action'",
			});
		}
		if (val.intent !== "propose_action" && val.proposed_action) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["proposed_action"],
				message: "proposed_action must only be set when intent is 'propose_action'",
			});
		}
	});

export const handoffStatusSchema = z.enum(["pending", "accepted", "completed", "cancelled"]);
export type HandoffStatus = z.infer<typeof handoffStatusSchema>;

export const checkInboxInput = z
	.object({
		status: z.array(handoffStatusSchema).optional(),
		since: z.string().datetime().optional(),
		limit: z.number().int().min(1).max(200).optional(),
	})
	.strict();

export const acceptHandoffInput = z
	.object({
		thread_id: z.string().min(1),
		session_id: z.string().min(1).optional(),
	})
	.strict();

export const sendMessageInput = z
	.object({
		thread_id: z.string().min(1),
		body: z.string().min(1),
		payload: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();

export const completeHandoffInput = z
	.object({
		thread_id: z.string().min(1),
		result_summary: z.string().min(1),
		artifacts: z.array(artifactSchema).optional(),
	})
	.strict();

export const listTeammatesInput = z
	.object({
		role: z.string().optional(),
		skill: z.string().optional(),
		repo: z.string().optional(),
	})
	.strict();
