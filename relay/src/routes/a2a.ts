import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { bearerAuth } from '../auth/middleware.js';
import type { Database } from '../db/client.js';
import { agents, handoffs } from '../db/schema.js';
import { ERROR_MAP, RelayError, type ErrorSymbol } from '../errors.js';
import type { NotificationJob, NotificationKind } from '../notifications/types.js';
import {
  appendMessage,
  createHandoff,
  getHandoff,
  listHandoffs,
  transitionHandoff,
  type HandoffStatus,
  type Intent,
} from '../services/handoff.js';
import type { AppEnv } from '../types.js';

// ─── Method-specific zod schemas ────────────────────────────────────────────

const intentEnum = z.enum(['inform', 'ask_question', 'propose_action']);

const proposedActionSchema = z
  .object({
    description: z.string().min(1),
    target_files: z.array(z.string()),
    rationale: z.string().min(1),
    suggested_diff: z.string().optional(),
  })
  .strict();

const messageSendParams = z.object({
  task_id: z.string().uuid().nullable().optional(),
  recipient: z.string().min(1).optional(),
  intent: intentEnum.default('inform'),
  message: z.object({
    role: z.string().optional(),
    parts: z
      .array(
        z.object({
          type: z.literal('text'),
          text: z.string(),
        }),
      )
      .min(1),
  }),
  artifacts: z.array(z.record(z.unknown())).default([]),
  proposed_action: proposedActionSchema.nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
});

const tasksGetParams = z.object({ task_id: z.string().uuid() });

const tasksListParams = z.object({
  filter: z
    .object({
      role: z.enum(['recipient', 'sender']).default('recipient'),
      status: z.array(z.enum(['pending', 'accepted', 'completed', 'cancelled'])).optional(),
      since: z.string().datetime().optional(),
    })
    .default({ role: 'recipient' }),
  page: z
    .object({ limit: z.number().int().positive().max(200).default(50), cursor: z.any().nullable() })
    .default({ limit: 50, cursor: null }),
});

const tasksUpdateParams = z.object({
  task_id: z.string().uuid(),
  transition: z.enum(['accept', 'complete', 'cancel']),
  session_id: z.string().optional(),
  result_summary: z.string().optional(),
});

const tasksCancelParams = z.object({ task_id: z.string().uuid() });

// ─── JSON-RPC envelope ──────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: { code: ErrorSymbol; details?: Record<string, unknown>; request_id: string };
  };
}

function rpcError(
  id: string | number | null,
  symbol: ErrorSymbol,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): JsonRpcError {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: ERROR_MAP[symbol].rpc,
      message,
      data: { code: symbol, request_id: requestId, ...(details ? { details } : {}) },
    },
  };
}

function rpcSuccess(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

export interface A2aRoutesOptions {
  db: Database;
  pepper: string;
  publicUrl: string;
  notify?: (job: NotificationJob) => void;
}

export function createA2aRoutes(opts: A2aRoutesOptions): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.use('*', bearerAuth({ db: opts.db, pepper: opts.pepper }));

  router.post('/', async (c) => {
    const requestId = c.get('requestId');
    const agent = c.get('agent');
    if (!agent) {
      // bearerAuth should have thrown; defensive only
      return c.json(rpcError(null, 'unauthenticated', 'Auth required', requestId), 401);
    }

    const raw = await c.req.json().catch(() => null);
    if (!raw || typeof raw !== 'object') {
      return c.json(rpcError(null, 'parse_error', 'Malformed JSON', requestId), 400);
    }
    const env = raw as JsonRpcRequest;
    const id = env.id ?? null;

    if (env.jsonrpc !== '2.0' || typeof env.method !== 'string') {
      return c.json(rpcError(id, 'invalid_request', 'Not a valid JSON-RPC envelope', requestId), 400);
    }

    try {
      const result = await dispatch(env.method, env.params, {
        db: opts.db,
        agent,
        requestId,
        publicUrl: opts.publicUrl,
        notify: opts.notify,
      });
      return c.json(rpcSuccess(id, result));
    } catch (err) {
      if (err instanceof RelayError) {
        const status = err.httpStatus;
        return c.json(rpcError(id, err.code, err.message, requestId, err.details), status as never);
      }
      c.get('logger')?.error({ err }, 'unhandled error in /a2a');
      return c.json(rpcError(id, 'internal', 'Internal server error', requestId), 500);
    }
  });

  return router;
}

interface DispatchCtx {
  db: Database;
  agent: { id: string; handle: string };
  requestId: string;
  publicUrl: string;
  notify?: (job: NotificationJob) => void;
}

async function emitNotification(
  ctx: DispatchCtx,
  kind: NotificationKind,
  threadId: string,
  recipientAgentId: string,
  summary: string,
): Promise<void> {
  if (!ctx.notify) return;
  // resolve sender's display name on the fly; failure here must not affect the result
  let senderName = ctx.agent.handle;
  try {
    const [row] = await ctx.db
      .select({ name: agents.displayName })
      .from(agents)
      .where(eq(agents.id, ctx.agent.id));
    if (row) senderName = row.name;
  } catch {
    // swallow
  }
  ctx.notify({
    kind,
    recipientAgentId,
    threadId,
    senderHandle: ctx.agent.handle,
    senderName,
    summary,
    publicUrl: ctx.publicUrl,
    enqueuedAt: Date.now(),
  });
}

async function loadHandoffParticipants(
  ctx: DispatchCtx,
  threadId: string,
): Promise<{ senderId: string; recipientId: string; summary: string; status: string } | null> {
  const [row] = await ctx.db
    .select({
      senderId: handoffs.senderId,
      recipientId: handoffs.recipientId,
      summary: handoffs.summary,
      status: handoffs.status,
    })
    .from(handoffs)
    .where(eq(handoffs.id, threadId));
  return row ?? null;
}

async function dispatch(method: string, params: unknown, ctx: DispatchCtx): Promise<unknown> {
  switch (method) {
    case 'message/send':
      return handleMessageSend(params, ctx);
    case 'tasks/get':
      return handleTasksGet(params, ctx);
    case 'tasks/list':
      return handleTasksList(params, ctx);
    case 'tasks/update':
      return handleTasksUpdate(params, ctx);
    case 'tasks/cancel':
      return handleTasksCancel(params, ctx);
    default:
      throw new RelayError('method_not_found', `Unknown method: ${method}`);
  }
}

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new RelayError('invalid_params', 'Invalid params', {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

async function handleMessageSend(params: unknown, ctx: DispatchCtx): Promise<unknown> {
  const p = parseParams(messageSendParams, params);
  const text = p.message.parts.map((part) => part.text).join('\n');
  const metadata = p.metadata ?? {};
  const artifacts = (p.artifacts ?? []).map((a) => ({
    type: typeof a['type'] === 'string' ? (a['type'] as string) : 'unknown',
    ...a,
  }));
  const idempotencyKey =
    typeof metadata['client_idempotency_key'] === 'string'
      ? (metadata['client_idempotency_key'] as string)
      : null;

  if (p.task_id) {
    const result = await appendMessage(ctx.db, {
      senderId: ctx.agent.id,
      taskId: p.task_id,
      body: text,
      payload: { artifacts },
      idempotencyKey,
      requestId: ctx.requestId,
    });
    if (!result.replayed) {
      const parts = await loadHandoffParticipants(ctx, p.task_id);
      if (parts) {
        const otherParticipant =
          parts.senderId === ctx.agent.id ? parts.recipientId : parts.senderId;
        await emitNotification(
          ctx,
          'notify.message.appended',
          p.task_id,
          otherParticipant,
          text,
        );
      }
    }
    return {
      task_id: p.task_id,
      message_id: result.messageId,
      sequence_no: result.sequenceNo,
      created_at: result.createdAt.toISOString(),
    };
  }

  if (!p.recipient) {
    throw new RelayError('invalid_params', 'recipient required when creating a new handoff');
  }

  const { handoff, replayed } = await createHandoff(ctx.db, {
    senderId: ctx.agent.id,
    recipientHandle: p.recipient,
    summary: text,
    intent: (p.intent ?? 'inform') as Intent,
    artifacts,
    proposedAction: p.proposed_action ?? null,
    metadata,
    idempotencyKey,
    requestId: ctx.requestId,
  });

  if (!replayed) {
    await emitNotification(
      ctx,
      'notify.handoff.created',
      handoff.id,
      handoff.recipientId,
      handoff.summary,
    );
  }

  return {
    task_id: handoff.id,
    status: { state: handoff.status },
    created_at: handoff.createdAt.toISOString(),
  };
}

async function handleTasksGet(params: unknown, ctx: DispatchCtx): Promise<unknown> {
  const p = parseParams(tasksGetParams, params);
  const { handoff, messages: msgs } = await getHandoff(ctx.db, {
    taskId: p.task_id,
    callerId: ctx.agent.id,
  });
  return {
    task_id: handoff.id,
    status: { state: handoff.status },
    sender_id: handoff.senderId,
    recipient_id: handoff.recipientId,
    summary: handoff.summary,
    intent: handoff.intent,
    artifacts: handoff.artifacts,
    proposed_action: handoff.proposedAction,
    metadata: handoff.metadata,
    accepted_at: handoff.acceptedAt?.toISOString() ?? null,
    completed_at: handoff.completedAt?.toISOString() ?? null,
    completed_summary: handoff.completedSummary,
    cancelled_at: handoff.cancelledAt?.toISOString() ?? null,
    created_at: handoff.createdAt.toISOString(),
    history: msgs.map((m) => ({
      id: m.id,
      author_id: m.author_id,
      body: m.body,
      payload: m.payload,
      sequence_no: m.sequence_no,
      created_at: m.created_at.toISOString(),
    })),
  };
}

async function handleTasksList(params: unknown, ctx: DispatchCtx): Promise<unknown> {
  const p = parseParams(tasksListParams, params);
  const filter = p.filter ?? { role: 'recipient' as const };
  const page = p.page ?? { limit: 50, cursor: null };
  const items = await listHandoffs(ctx.db, {
    callerId: ctx.agent.id,
    role: filter.role ?? 'recipient',
    statuses: (filter.status ?? []) as HandoffStatus[],
    since: filter.since ? new Date(filter.since) : undefined,
    limit: page.limit ?? 50,
  });
  return {
    items: items.map((h) => ({
      task_id: h.id,
      status: { state: h.status },
      sender_id: h.senderId,
      recipient_id: h.recipientId,
      summary_preview: h.summary.slice(0, 240),
      intent: h.intent,
      created_at: h.createdAt.toISOString(),
      updated_at: h.updatedAt.toISOString(),
    })),
    next_cursor: null,
  };
}

async function handleTasksUpdate(params: unknown, ctx: DispatchCtx): Promise<unknown> {
  const p = parseParams(tasksUpdateParams, params);
  const handoff = await transitionHandoff(ctx.db, {
    taskId: p.task_id,
    callerId: ctx.agent.id,
    transition: p.transition,
    sessionId: p.session_id,
    resultSummary: p.result_summary,
    requestId: ctx.requestId,
  });
  await fireTransitionNotification(ctx, handoff, p.transition);
  return {
    task_id: handoff.id,
    status: { state: handoff.status },
    updated_at: handoff.updatedAt.toISOString(),
  };
}

async function handleTasksCancel(params: unknown, ctx: DispatchCtx): Promise<unknown> {
  const p = parseParams(tasksCancelParams, params);
  const handoff = await transitionHandoff(ctx.db, {
    taskId: p.task_id,
    callerId: ctx.agent.id,
    transition: 'cancel',
    requestId: ctx.requestId,
  });
  await fireTransitionNotification(ctx, handoff, 'cancel');
  return {
    task_id: handoff.id,
    status: { state: handoff.status },
    updated_at: handoff.updatedAt.toISOString(),
  };
}

async function fireTransitionNotification(
  ctx: DispatchCtx,
  handoff: {
    id: string;
    senderId: string;
    recipientId: string;
    summary: string;
    status: string;
    acceptedAt: Date | null;
  },
  transition: 'accept' | 'complete' | 'cancel',
): Promise<void> {
  switch (transition) {
    case 'complete':
      // notify sender (lld §9.1)
      await emitNotification(
        ctx,
        'notify.handoff.completed',
        handoff.id,
        handoff.senderId,
        handoff.summary,
      );
      return;
    case 'cancel':
      // notify recipient only if they had accepted (lld §9.1)
      if (handoff.acceptedAt) {
        await emitNotification(
          ctx,
          'notify.handoff.cancelled',
          handoff.id,
          handoff.recipientId,
          handoff.summary,
        );
      }
      return;
    case 'accept':
      // accept is silent — already on the recipient's screen
      return;
  }
}
