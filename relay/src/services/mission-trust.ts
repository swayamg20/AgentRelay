import { and, inArray } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { agentBlocks } from "../db/schema.js";
import { RelayError } from "../errors.js";
import { lockAgentBlockPair } from "./agent-block-lock.js";

type MissionTrustTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Missions require a bidirectional communication path between every principal.
 * Lock both directions before reading the block table so a successful block is a
 * hard fence against later Mission activation, execution, or peer content.
 */
export async function assertMissionTrustBoundary(
	tx: MissionTrustTransaction,
	principalIds: readonly string[],
): Promise<void> {
	const ids = [...new Set(principalIds)].sort();
	const directedPairs: Array<readonly [blockerId: string, blockedId: string]> = [];
	for (let left = 0; left < ids.length; left += 1) {
		for (let right = left + 1; right < ids.length; right += 1) {
			directedPairs.push([ids[left]!, ids[right]!], [ids[right]!, ids[left]!]);
		}
	}
	directedPairs.sort(([leftBlocker, leftBlocked], [rightBlocker, rightBlocked]) =>
		`${leftBlocker}:${leftBlocked}`.localeCompare(`${rightBlocker}:${rightBlocked}`),
	);
	for (const [blockerId, blockedId] of directedPairs) {
		await lockAgentBlockPair(tx, blockerId, blockedId);
	}

	if (ids.length < 2) return;
	const [blocked] = await tx
		.select({ blockerId: agentBlocks.blockerId })
		.from(agentBlocks)
		.where(and(inArray(agentBlocks.blockerId, ids), inArray(agentBlocks.blockedId, ids)))
		.limit(1);
	if (blocked) {
		throw new RelayError("teammate_blocked", "Mission participants must remain mutually unblocked");
	}
}
