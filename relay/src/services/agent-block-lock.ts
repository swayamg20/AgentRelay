import { sql } from "drizzle-orm";

/**
 * Serialize a directed trust boundary: `blockerId` deciding whether content
 * authored by `blockedId` may cross into the blocker's mailbox.
 *
 * Both trust-list mutations and content-bearing mailbox mutations must take
 * this transaction-scoped lock before reading or changing the boundary. That
 * makes a successful block response a hard commit fence: an older send cannot
 * commit after the block has committed.
 */
export async function lockAgentBlockPair(
	// biome-ignore lint/suspicious/noExplicitAny: Drizzle transactions share this SQL execution surface
	tx: any,
	blockerId: string,
	blockedId: string,
): Promise<void> {
	const key = `agentrelay:block:${blockerId}:${blockedId}`;
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`);
}
