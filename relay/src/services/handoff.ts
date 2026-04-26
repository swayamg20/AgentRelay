import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  agentBlocks,
  agents,
  handoffs,
  messages,
  type Handoff,
} from '../db/schema.js';
import { RelayError } from '../errors.js';
import { writeAudit } from './audit.js';

export type Intent = 'inform' | 'ask_question' | 'propose_action';
export type HandoffStatus = 'pending' | 'accepted' | 'completed' | 'cancelled';

export interface ProposedActionInput {
  description: string;
  target_files: string[];
  rationale: string;
  suggested_diff?: string;
}

export interface ArtifactInput {
  type: string;
  [k: string]: unknown;
}

export interface CreateHandoffInput {
  senderId: string;
  recipientHandle: string;
  summary: string;
  intent: Intent;
  artifacts: ArtifactInput[];
  proposedAction: ProposedActionInput | null;
  metadata: Record<string, unknown>;
  idempotencyKey: string | null;
  requestId: string;
}

export interface AppendMessageInput {
  senderId: string;
  taskId: string;
  body: string;
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
  requestId: string;
}

function validateIntentInvariant(
  intent: Intent,
  proposedAction: ProposedActionInput | null,
): void {
  if (intent === 'propose_action' && proposedAction === null) {
    throw new RelayError(
      'invalid_intent_payload',
      "intent='propose_action' requires proposed_action",
    );
  }
  if (intent !== 'propose_action' && proposedAction !== null) {
    throw new RelayError(
      'invalid_intent_payload',
      `proposed_action only allowed when intent='propose_action' (got ${intent})`,
    );
  }
  if (proposedAction) {
    if (
      typeof proposedAction.description !== 'string' ||
      typeof proposedAction.rationale !== 'string' ||
      !Array.isArray(proposedAction.target_files)
    ) {
      throw new RelayError(
        'invalid_intent_payload',
        'proposed_action must have {description, rationale, target_files}',
      );
    }
  }
}

async function nextSequenceNo(
  // biome-ignore lint/suspicious/noExplicitAny: tx and db share the SQL execution surface
  tx: any,
  handoffId: string,
): Promise<number> {
  // Advisory lock keyed on handoff id (lld §2.5).
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${handoffId}::text))`);
  const rows = await tx
    .select({ max: sql<number>`COALESCE(MAX(${messages.sequenceNo}), 0)` })
    .from(messages)
    .where(eq(messages.handoffId, handoffId));
  return (rows[0]?.max ?? 0) + 1;
}

async function isSenderBlocked(
  db: Database,
  senderId: string,
  recipientId: string,
): Promise<boolean> {
  const rows = await db
    .select({ blocker: agentBlocks.blockerId })
    .from(agentBlocks)
    .where(and(eq(agentBlocks.blockerId, recipientId), eq(agentBlocks.blockedId, senderId)))
    .limit(1);
  return rows.length > 0;
}

export async function createHandoff(
  db: Database,
  input: CreateHandoffInput,
): Promise<{ handoff: Handoff; replayed: boolean }> {
  validateIntentInvariant(input.intent, input.proposedAction);

  // Resolve recipient handle → id.
  const [recipient] = await db
    .select({ id: agents.id, status: agents.status })
    .from(agents)
    .where(eq(agents.handle, input.recipientHandle));
  if (!recipient || recipient.status !== 'active') {
    throw new RelayError(
      'recipient_not_found',
      `No active agent with handle '${input.recipientHandle}'`,
    );
  }
  if (recipient.id === input.senderId) {
    throw new RelayError('invalid_params', 'Cannot send a handoff to yourself');
  }
  if (await isSenderBlocked(db, input.senderId, recipient.id)) {
    throw new RelayError('teammate_blocked', 'Sender is blocked by recipient');
  }

  // Idempotency replay (lld §10).
  if (input.idempotencyKey) {
    const [existing] = await db
      .select()
      .from(handoffs)
      .where(eq(handoffs.idempotencyKey, input.idempotencyKey));
    if (existing) {
      const samePayload =
        existing.senderId === input.senderId &&
        existing.recipientId === recipient.id &&
        existing.summary === input.summary &&
        existing.intent === input.intent;
      if (!samePayload) {
        throw new RelayError(
          'duplicate_idempotency_key',
          'idempotency_key reused with a different payload',
        );
      }
      return { handoff: existing, replayed: true };
    }
  }

  return await db.transaction(async (tx) => {
    const [handoff] = await tx
      .insert(handoffs)
      .values({
        senderId: input.senderId,
        recipientId: recipient.id,
        summary: input.summary,
        intent: input.intent,
        artifacts: input.artifacts,
        proposedAction: input.proposedAction,
        metadata: input.metadata,
        idempotencyKey: input.idempotencyKey,
      })
      .returning();
    if (!handoff) throw new RelayError('internal', 'Failed to insert handoff');

    // Initial summary message at sequence_no = 1 (lld §2.5 denormalisation).
    await tx.insert(messages).values({
      handoffId: handoff.id,
      authorId: input.senderId,
      body: input.summary,
      payload: {},
      sequenceNo: 1,
    });

    await writeAudit(tx, {
      actorId: input.senderId,
      action: 'handoff.create',
      resourceType: 'handoff',
      resourceId: handoff.id,
      metadata: { intent: input.intent, recipient: input.recipientHandle },
      requestId: input.requestId,
    });

    return { handoff, replayed: false };
  });
}

export async function appendMessage(
  db: Database,
  input: AppendMessageInput,
): Promise<{ messageId: string; sequenceNo: number; createdAt: Date; replayed: boolean }> {
  return await db.transaction(async (tx) => {
    const [handoff] = await tx
      .select()
      .from(handoffs)
      .where(eq(handoffs.id, input.taskId));
    if (!handoff) throw new RelayError('thread_not_found', 'Thread not found');
    if (handoff.senderId !== input.senderId && handoff.recipientId !== input.senderId) {
      throw new RelayError('not_a_participant', 'Caller is not a participant of this thread');
    }
    if (handoff.status === 'completed' || handoff.status === 'cancelled') {
      throw new RelayError('thread_terminal', `Thread is ${handoff.status}`);
    }

    if (input.idempotencyKey) {
      const [existing] = await tx
        .select()
        .from(messages)
        .where(eq(messages.idempotencyKey, input.idempotencyKey));
      if (existing) {
        if (existing.handoffId !== handoff.id || existing.body !== input.body) {
          throw new RelayError(
            'duplicate_idempotency_key',
            'idempotency_key reused with a different payload',
          );
        }
        return {
          messageId: existing.id,
          sequenceNo: existing.sequenceNo,
          createdAt: existing.createdAt,
          replayed: true,
        };
      }
    }

    const seq = await nextSequenceNo(tx, handoff.id);
    const [created] = await tx
      .insert(messages)
      .values({
        handoffId: handoff.id,
        authorId: input.senderId,
        body: input.body,
        payload: input.payload,
        sequenceNo: seq,
        idempotencyKey: input.idempotencyKey,
      })
      .returning();
    if (!created) throw new RelayError('internal', 'Failed to append message');

    await writeAudit(tx, {
      actorId: input.senderId,
      action: 'message.append',
      resourceType: 'message',
      resourceId: created.id,
      metadata: { handoff_id: handoff.id, sequence_no: seq },
      requestId: input.requestId,
    });

    return {
      messageId: created.id,
      sequenceNo: created.sequenceNo,
      createdAt: created.createdAt,
      replayed: false,
    };
  });
}

export interface TransitionInput {
  taskId: string;
  callerId: string;
  transition: 'accept' | 'complete' | 'cancel';
  sessionId?: string;
  resultSummary?: string;
  requestId: string;
}

export async function transitionHandoff(
  db: Database,
  input: TransitionInput,
): Promise<Handoff> {
  return await db.transaction(async (tx) => {
    // Lock the row to prevent racing transitions (-32010 state_changed).
    const [handoff] = await tx
      .select()
      .from(handoffs)
      .where(eq(handoffs.id, input.taskId))
      .for('update');
    if (!handoff) throw new RelayError('thread_not_found', 'Thread not found');
    if (handoff.senderId !== input.callerId && handoff.recipientId !== input.callerId) {
      throw new RelayError('not_a_participant', 'Caller is not a participant');
    }

    const now = new Date();

    switch (input.transition) {
      case 'accept': {
        if (handoff.recipientId !== input.callerId) {
          throw new RelayError(
            'not_authorized_transition',
            'Only the recipient can accept a handoff',
          );
        }
        if (handoff.status !== 'pending') {
          if (handoff.status === 'accepted') {
            // Idempotent re-accept (HLD F4).
            return handoff;
          }
          throw new RelayError(
            'invalid_transition',
            `Cannot accept handoff in status '${handoff.status}'`,
          );
        }
        const [updated] = await tx
          .update(handoffs)
          .set({
            status: 'accepted',
            acceptedAt: now,
            acceptedBySession: input.sessionId ?? null,
          })
          .where(and(eq(handoffs.id, handoff.id), eq(handoffs.status, 'pending')))
          .returning();
        if (!updated) {
          throw new RelayError('state_changed', 'Handoff state changed concurrently');
        }
        await writeAudit(tx, {
          actorId: input.callerId,
          action: 'handoff.accept',
          resourceType: 'handoff',
          resourceId: handoff.id,
          metadata: { session_id: input.sessionId ?? null },
          requestId: input.requestId,
        });
        return updated;
      }

      case 'complete': {
        if (handoff.recipientId !== input.callerId) {
          throw new RelayError(
            'not_authorized_transition',
            'Only the recipient can complete a handoff',
          );
        }
        if (handoff.status !== 'accepted') {
          throw new RelayError(
            'invalid_transition',
            `Cannot complete handoff in status '${handoff.status}'`,
          );
        }
        const [updated] = await tx
          .update(handoffs)
          .set({
            status: 'completed',
            completedAt: now,
            completedSummary: input.resultSummary ?? null,
          })
          .where(and(eq(handoffs.id, handoff.id), eq(handoffs.status, 'accepted')))
          .returning();
        if (!updated) {
          throw new RelayError('state_changed', 'Handoff state changed concurrently');
        }
        await writeAudit(tx, {
          actorId: input.callerId,
          action: 'handoff.complete',
          resourceType: 'handoff',
          resourceId: handoff.id,
          requestId: input.requestId,
        });
        return updated;
      }

      case 'cancel': {
        if (handoff.senderId !== input.callerId) {
          throw new RelayError(
            'not_authorized_transition',
            'Only the sender can cancel a handoff',
          );
        }
        if (handoff.status !== 'pending') {
          throw new RelayError(
            'invalid_transition',
            `Cannot cancel handoff in status '${handoff.status}'`,
          );
        }
        const [updated] = await tx
          .update(handoffs)
          .set({ status: 'cancelled', cancelledAt: now })
          .where(and(eq(handoffs.id, handoff.id), eq(handoffs.status, 'pending')))
          .returning();
        if (!updated) {
          throw new RelayError('state_changed', 'Handoff state changed concurrently');
        }
        await writeAudit(tx, {
          actorId: input.callerId,
          action: 'handoff.cancel',
          resourceType: 'handoff',
          resourceId: handoff.id,
          requestId: input.requestId,
        });
        return updated;
      }

      default: {
        const _exhaustive: never = input.transition;
        throw new RelayError('invalid_request', `Unknown transition: ${String(_exhaustive)}`);
      }
    }
  });
}

export interface GetHandoffOptions {
  taskId: string;
  callerId: string;
}

export async function getHandoff(
  db: Database,
  opts: GetHandoffOptions,
): Promise<{
  handoff: Handoff;
  messages: Array<{
    id: string;
    author_id: string;
    body: string;
    payload: unknown;
    sequence_no: number;
    created_at: Date;
  }>;
}> {
  const [handoff] = await db
    .select()
    .from(handoffs)
    .where(eq(handoffs.id, opts.taskId));
  if (!handoff) throw new RelayError('thread_not_found', 'Thread not found');
  if (handoff.senderId !== opts.callerId && handoff.recipientId !== opts.callerId) {
    throw new RelayError('not_a_participant', 'Caller is not a participant');
  }
  const msgs = await db
    .select({
      id: messages.id,
      author_id: messages.authorId,
      body: messages.body,
      payload: messages.payload,
      sequence_no: messages.sequenceNo,
      created_at: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.handoffId, handoff.id))
    .orderBy(asc(messages.sequenceNo));
  return { handoff, messages: msgs };
}

export interface ListHandoffsFilter {
  callerId: string;
  role: 'recipient' | 'sender';
  statuses: HandoffStatus[];
  since?: Date;
  limit: number;
}

export async function listHandoffs(
  db: Database,
  f: ListHandoffsFilter,
): Promise<Handoff[]> {
  const roleClause =
    f.role === 'recipient'
      ? eq(handoffs.recipientId, f.callerId)
      : eq(handoffs.senderId, f.callerId);
  const conds = [roleClause];
  if (f.statuses.length > 0) conds.push(inArray(handoffs.status, f.statuses));
  if (f.since) conds.push(gte(handoffs.createdAt, f.since));
  return await db
    .select()
    .from(handoffs)
    .where(and(...conds))
    .orderBy(desc(handoffs.createdAt))
    .limit(f.limit);
}
