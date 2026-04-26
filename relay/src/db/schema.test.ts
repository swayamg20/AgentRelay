import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentCards,
  agents,
  apiKeys,
  auditLog,
  handoffs,
  messages,
} from './schema.js';
import { type TestDb, truncateAll, tryConnect } from './test-utils.js';

const conn = await tryConnect();

const d = conn.available ? describe : describe.skip;

if (!conn.available) {
  // biome-ignore lint/suspicious/noConsoleLog: integration tests self-skip without DB
  console.warn(`[schema.test] skipping integration tests: ${conn.reason}`);
}

d('db schema integration', () => {
  let handle: TestDb;

  beforeAll(() => {
    if (!conn.handle) throw new Error('expected db handle');
    handle = conn.handle;
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  async function makeAgent(suffix = ''): Promise<string> {
    await truncateAll(handle.sql);
    const handleStr = `bob${suffix}@acme`;
    const [row] = await handle.db
      .insert(agents)
      .values({
        handle: handleStr,
        email: `bob${suffix}@acme.com`,
        displayName: 'Bob',
        role: 'backend',
      })
      .returning();
    if (!row) throw new Error('insert failed');
    return row.id;
  }

  it('agents: round-trips and enforces status check', async () => {
    const id = await makeAgent('-1');
    const fetched = await handle.db
      .select()
      .from(agents)
      .where(eq(agents.id, id));
    expect(fetched[0]?.handle).toBe('bob-1@acme');

    await expect(
      handle.db.insert(agents).values({
        handle: 'bad@acme',
        email: 'bad@acme.com',
        displayName: 'X',
        role: 'r',
        status: 'sideways',
      }),
    ).rejects.toThrow(/agents_status_chk/);
  });

  it('agent_cards: round-trips with array + jsonb defaults', async () => {
    const agentId = await makeAgent('-2');
    await handle.db.insert(agentCards).values({
      agentId,
      card: { id: 'bob-2@acme', name: 'Bob' },
      reposOwned: ['apps/web/'],
      skills: ['react', 'tailwind'],
    });
    const [card] = await handle.db
      .select()
      .from(agentCards)
      .where(eq(agentCards.agentId, agentId));
    expect(card?.skills).toEqual(['react', 'tailwind']);
    expect(card?.reposOwned).toEqual(['apps/web/']);
  });

  it('api_keys: unique active hash, allows revoked-collision', async () => {
    const agentId = await makeAgent('-3');
    const hash = Buffer.from('a'.repeat(32));
    const salt = Buffer.from('s'.repeat(16));
    await handle.db.insert(apiKeys).values({ agentId, keyHash: hash, salt });

    // duplicate active hash blocked
    await expect(
      handle.db.insert(apiKeys).values({ agentId, keyHash: hash, salt }),
    ).rejects.toThrow(/idx_api_keys_active_hash/);

    // revoking the original allows reissuing
    await handle.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.agentId, agentId));
    await expect(
      handle.db.insert(apiKeys).values({ agentId, keyHash: hash, salt }),
    ).resolves.toBeDefined();
  });

  it('handoffs: enforces sender ≠ recipient', async () => {
    const agentId = await makeAgent('-4');
    await expect(
      handle.db.insert(handoffs).values({
        senderId: agentId,
        recipientId: agentId,
        summary: 'self-talk',
      }),
    ).rejects.toThrow(/handoffs_sender_not_recipient/);
  });

  it('handoffs: enforces intent enum', async () => {
    const senderId = await makeAgent('-5a');
    const [recipient] = await handle.db
      .insert(agents)
      .values({
        handle: 'frank-5b@acme',
        email: 'frank-5b@acme.com',
        displayName: 'Frank',
        role: 'frontend',
      })
      .returning();
    if (!recipient) throw new Error('recipient insert failed');

    await expect(
      handle.db.insert(handoffs).values({
        senderId,
        recipientId: recipient.id,
        summary: 'hi',
        intent: 'demand',
      }),
    ).rejects.toThrow(/handoffs_intent_valid/);
  });

  it('handoffs: enforces proposed_action invariant', async () => {
    const senderId = await makeAgent('-6a');
    const [recipient] = await handle.db
      .insert(agents)
      .values({
        handle: 'frank-6b@acme',
        email: 'frank-6b@acme.com',
        displayName: 'Frank',
        role: 'frontend',
      })
      .returning();
    if (!recipient) throw new Error('recipient insert failed');

    // intent='inform' with proposed_action set → fail
    await expect(
      handle.db.insert(handoffs).values({
        senderId,
        recipientId: recipient.id,
        summary: 'x',
        intent: 'inform',
        proposedAction: { description: 'no', target_files: [], rationale: 'no' },
      }),
    ).rejects.toThrow(/handoffs_proposed_action_invariant/);

    // intent='propose_action' without proposed_action → fail
    await expect(
      handle.db.insert(handoffs).values({
        senderId,
        recipientId: recipient.id,
        summary: 'x',
        intent: 'propose_action',
      }),
    ).rejects.toThrow(/handoffs_proposed_action_invariant/);

    // intent='propose_action' with proposed_action → ok
    const [ok] = await handle.db
      .insert(handoffs)
      .values({
        senderId,
        recipientId: recipient.id,
        summary: 'please update',
        intent: 'propose_action',
        proposedAction: {
          description: 'rename',
          target_files: ['x.ts'],
          rationale: 'why',
        },
      })
      .returning();
    expect(ok?.intent).toBe('propose_action');
    expect(ok?.status).toBe('pending');
  });

  it('messages: unique (handoff_id, sequence_no)', async () => {
    const senderId = await makeAgent('-7a');
    const [recipient] = await handle.db
      .insert(agents)
      .values({
        handle: 'frank-7b@acme',
        email: 'frank-7b@acme.com',
        displayName: 'Frank',
        role: 'frontend',
      })
      .returning();
    if (!recipient) throw new Error('recipient insert failed');
    const [h] = await handle.db
      .insert(handoffs)
      .values({ senderId, recipientId: recipient.id, summary: 's' })
      .returning();
    if (!h) throw new Error('handoff insert failed');

    await handle.db
      .insert(messages)
      .values({ handoffId: h.id, authorId: senderId, body: 'first', sequenceNo: 1 });
    await expect(
      handle.db
        .insert(messages)
        .values({ handoffId: h.id, authorId: senderId, body: 'dup', sequenceNo: 1 }),
    ).rejects.toThrow(/idx_messages_seq/);
  });

  it('audit_log: round-trips and bigserial id auto-increments', async () => {
    const agentId = await makeAgent('-8');
    const [a1] = await handle.db
      .insert(auditLog)
      .values({
        actorId: agentId,
        action: 'handoff.create',
        resourceType: 'handoff',
        resourceId: randomUUID(),
        requestId: 'req_test',
      })
      .returning();
    const [a2] = await handle.db
      .insert(auditLog)
      .values({
        actorId: agentId,
        action: 'handoff.accept',
        resourceType: 'handoff',
        resourceId: randomUUID(),
      })
      .returning();
    expect(a1?.id).toBeDefined();
    expect(a2?.id).toBeDefined();
    expect(BigInt(a2?.id ?? 0n)).toBeGreaterThan(BigInt(a1?.id ?? 0n));
  });

  it('updated_at trigger advances timestamp on UPDATE', async () => {
    const id = await makeAgent('-9');
    const [before] = await handle.db.select().from(agents).where(eq(agents.id, id));
    await new Promise((r) => setTimeout(r, 10));
    await handle.db.update(agents).set({ role: 'platform' }).where(eq(agents.id, id));
    const [after] = await handle.db.select().from(agents).where(eq(agents.id, id));
    expect(after?.updatedAt.getTime()).toBeGreaterThan(before?.updatedAt.getTime() ?? 0);
  });
});
