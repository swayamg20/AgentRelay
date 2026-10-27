import { z } from "zod";
import type { A2AClient } from "../a2a-client.js";
import { markTeammateValue } from "../provenance.js";
import { listTeammatesInput, rosterCursorSchema } from "./schemas.js";

const teammateSchema = z.object({
	handle: z.string(),
	name: z.string(),
	role: z.string(),
	skills: z.array(z.string()).default([]),
	repos_owned: z.array(z.string()).default([]),
});

const responseSchema = z.object({
	teammates: z.array(teammateSchema),
	next_cursor: rosterCursorSchema.nullable().optional(),
});

export type ListTeammatesResult = z.infer<typeof responseSchema>;

export async function listTeammates(
	client: A2AClient,
	rawInput: unknown,
): Promise<ListTeammatesResult> {
	const input = listTeammatesInput.parse(rawInput ?? {});
	const result = await client.request<unknown>("agents/list", input);
	const parsed = responseSchema.parse(result);
	return {
		teammates: parsed.teammates.map((teammate) => markTeammateValue(teammate.handle, teammate)),
		...(parsed.next_cursor !== undefined ? { next_cursor: parsed.next_cursor } : {}),
	};
}
