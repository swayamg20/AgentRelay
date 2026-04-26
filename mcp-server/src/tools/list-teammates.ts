import { z } from "zod";
import type { A2AClient } from "../a2a-client.js";
import { listTeammatesInput } from "./schemas.js";

const teammateSchema = z.object({
	handle: z.string(),
	name: z.string(),
	role: z.string(),
	skills: z.array(z.string()).default([]),
	repos_owned: z.array(z.string()).default([]),
});

const responseSchema = z.object({
	teammates: z.array(teammateSchema),
});

export type ListTeammatesResult = z.infer<typeof responseSchema>;

export async function listTeammates(
	client: A2AClient,
	rawInput: unknown,
): Promise<ListTeammatesResult> {
	const input = listTeammatesInput.parse(rawInput ?? {});
	// `agents/list` is our REST-side alias surfaced through the JSON-RPC
	// envelope per lld §4.6. The relay accepts optional role/skill/repo
	// filters.
	const result = await client.request<unknown>("agents/list", {
		role: input.role,
		skill: input.skill,
		repo: input.repo,
	});
	return responseSchema.parse(result);
}
