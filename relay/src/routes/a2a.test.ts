import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearLastUsedDebounce } from '../auth/middleware.js';
import { loadConfig } from '../config.js';
import { agentBlocks, agents } from '../db/schema.js';
import { type TestDb, truncateAll, tryConnect } from '../db/test-utils.js';
import { createLogger } from '../logger.js';
import { createServer } from '../server.js';
import { eq } from 'drizzle-orm';

const conn = await tryConnect();
const d = conn.available ? describe : describe.skip;
if (!conn.available) {
  // biome-ignore lint/suspicious/noConsoleLog: integration tests self-skip without DB
  console.warn(`[a2a.test] skipping: ${conn.reason}`);
}

const TEST_ENV = {
  RELAY_DATABASE_URL: process.env.RELAY_TEST_DATABASE_URL ?? 'postgres://x:y@localhost/x',
  RELAY_PEPPER: 'p'.repeat(32),
  RELAY_ENCRYPTION_KEY: 'e'.repeat(16),
  RELAY_ADMIN_TOKEN: 'admin-token-secret',
  RELAY_METRICS_TOKEN: 'metrics-token',
  RELAY_PUBLIC_URL: 'http://localhost:8080',
  RELAY_ENV: 'dev' as const,
  RELAY_LOG_LEVEL: 'fatal' as const,
};

d('a2a JSON-RPC + state machine', () => {
  let handle: TestDb;
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    if (!conn.handle) throw new Error('expected db handle');
    handle = conn.handle;
    const config = loadConfig({ ...TEST_ENV } as NodeJS.ProcessEnv);
    const logger = createLogger(config);
    app = createServer({ config, logger, db: handle.db });
  });

  beforeEach(async () => {
    await truncateAll(handle.sql);
    clearLastUsedDebounce();
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  function adminHeaders(): HeadersInit {
    return {
      authorization: `Bearer ${TEST_ENV.RELAY_ADMIN_TOKEN}`,
      'content-type': 'application/json',
    };
  }
  function bearer(token: string): HeadersInit {
    return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  }

  async function register(handleStr: string): Promise<{ id: string; key: string }> {
    const res = await app.request('/admin/agents', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        handle: handleStr,
        email: `${handleStr.split('@')[0]}@acme.com`,
        display_name: handleStr,
        role: 'engineer',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent_id: string; api_key: string };
    return { id: body.agent_id, key: body.api_key };
  }

  async function rpc(
    key: string,
    method: string,
    params: unknown,
    rpcId: string | number = 'r1',
  ): Promise<{ status: number; body: { id?: unknown; result?: any; error?: any } }> {
    const res = await app.request('/a2a', {
      method: 'POST',
      headers: bearer(key),
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  it('rejects unauthenticated POST /a2a', async () => {
    const res = await app.request('/a2a', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('full lifecycle: create → accept → message → complete', async () => {
    const bob = await register('bob@acme');
    const frank = await register('frank@acme');

    const create = await rpc(bob.key, 'message/send', {
      recipient: 'frank@acme',
      intent: 'inform',
      message: { parts: [{ type: 'text', text: 'Refactored /users API.' }] },
    });
    expect(create.status).toBe(200);
    expect(create.body.result.status.state).toBe('pending');
    const taskId = create.body.result.task_id as string;

    // Bob can list as sender
    const sentList = await rpc(bob.key, 'tasks/list', { filter: { role: 'sender' } });
    expect(sentList.body.result.items.length).toBe(1);

    // Frank's inbox shows it
    const inbox = await rpc(frank.key, 'tasks/list', { filter: { role: 'recipient' } });
    expect(inbox.body.result.items[0].task_id).toBe(taskId);

    // Frank accepts
    const accept = await rpc(frank.key, 'tasks/update', {
      task_id: taskId,
      transition: 'accept',
      session_id: 'frank-session-1',
    });
    expect(accept.body.result.status.state).toBe('accepted');

    // Re-accept is idempotent
    const reaccept = await rpc(frank.key, 'tasks/update', {
      task_id: taskId,
      transition: 'accept',
    });
    expect(reaccept.body.result.status.state).toBe('accepted');

    // Bob appends a clarification message
    const msg = await rpc(bob.key, 'message/send', {
      task_id: taskId,
      message: { parts: [{ type: 'text', text: 'Also note: cursor-based pagination.' }] },
    });
    expect(msg.body.result.sequence_no).toBe(2);

    // Frank gets thread
    const got = await rpc(frank.key, 'tasks/get', { task_id: taskId });
    expect(got.body.result.history.length).toBe(2);
    expect(got.body.result.history[1].body).toContain('cursor-based');

    // Frank completes
    const complete = await rpc(frank.key, 'tasks/update', {
      task_id: taskId,
      transition: 'complete',
      result_summary: 'updated client',
    });
    expect(complete.body.result.status.state).toBe('completed');

    // Further messages denied
    const after = await rpc(bob.key, 'message/send', {
      task_id: taskId,
      message: { parts: [{ type: 'text', text: 'late' }] },
    });
    expect(after.body.error.data.code).toBe('thread_terminal');
  });

  it('idempotency replay returns same handoff for same payload', async () => {
    const bob = await register('bob@acme');
    await register('frank@acme');
    const params = {
      recipient: 'frank@acme',
      intent: 'inform',
      message: { parts: [{ type: 'text', text: 'hello' }] },
      metadata: { client_idempotency_key: 'idem-1' },
    };
    const a = await rpc(bob.key, 'message/send', params);
    const b = await rpc(bob.key, 'message/send', params);
    expect(a.body.result.task_id).toBe(b.body.result.task_id);
  });

  it('idempotency: same key + different payload returns -32011', async () => {
    const bob = await register('bob@acme');
    await register('frank@acme');
    await rpc(bob.key, 'message/send', {
      recipient: 'frank@acme',
      intent: 'inform',
      message: { parts: [{ type: 'text', text: 'one' }] },
      metadata: { client_idempotency_key: 'idem-x' },
    });
    const second = await rpc(bob.key, 'message/send', {
      recipient: 'frank@acme',
      intent: 'inform',
      message: { parts: [{ type: 'text', text: 'TWO' }] },
      metadata: { client_idempotency_key: 'idem-x' },
    });
    expect(second.body.error.data.code).toBe('duplicate_idempotency_key');
    expect(second.body.error.code).toBe(-32011);
  });

  it('sender cannot accept own thread (-32009)', async () => {
    const bob = await register('bob@acme');
    await register('frank@acme');
    const create = await rpc(bob.key, 'message/send', {
      recipient: 'frank@acme',
      intent: 'inform',
      message: { parts: [{ type: 'text', text: 'hi' }] },
    });
    const taskId = create.body.result.task_id;
    const accept = await rpc(bob.key, 'tasks/update', {
      task_id: taskId,
      transition: 'accept',
    });
    expect(accept.body.error.data.code).toBe('not_authorized_transition');
  });

  it('sender can cancel a pending thread; recipient cannot', async () => {
    const bob = await register('bob@acme');
    const frank = await register('frank@acme');
    const create = await rpc(bob.key, 'message/send', {
      recipient: 'frank@acme',
      intent: 'inform',
      message: { parts: [{ type: 'text', text: 'hi' }] },
    });
    const taskId = create.body.result.task_id;

    // recipient tries to cancel
    const denied = await rpc(frank.key, 'tasks/cancel', { task_id: taskId });
    expect(denied.body.error.data.code).toBe('not_authorized_transition');

    // sender cancels
    const ok = await rpc(bob.key, 'tasks/cancel', { task_id: taskId });
    expect(ok.body.result.status.state).toBe('cancelled');

    // cannot cancel twice
    const again = await rpc(bob.key, 'tasks/cancel', { task_id: taskId });
    expect(again.body.error.data.code).toBe('invalid_transition');
  });

  it('cannot complete a pending (not yet accepted) thread', async () => {
    const bob = await register('bob@acme');
    const frank = await register('frank@acme');
    const create = await rpc(bob.key, 'message/send', {
      recipient: 'frank@acme',
      intent: 'inform',
      message: { parts: [{ type: 'text', text: 'hi' }] },
    });
    const taskId = create.body.result.task_id;
    const tooEarly = await rpc(frank.key, 'tasks/update', {
      task_id: taskId,
      transition: 'complete',
    });
    expect(tooEarly.body.error.data.code).toBe('invalid_transition');
  });

  it('non-participant cannot read/append', async () => {
    const bob = await register('bob@acme');
    await register('frank@acme');
    const eve = await register('eve@acme');
    const create = await rpc(bob.key, 'message/send', {
      recipient: 'frank@acme',
      intent: 'inform',
      message: { parts: [{ type: 'text', text: 'private' }] },
    });
    const taskId = create.body.result.task_id;
    const peek = await rpc(eve.key, 'tasks/get', { task_id: taskId });
    expect(peek.body.error.data.code).toBe('not_a_participant');
  });

  it('intent=propose_action requires proposed_action; mismatch → -32012', async () => {
    const bob = await register('bob@acme');
    await register('frank@acme');

    const noPa = await rpc(bob.key, 'message/send', {
      recipient: 'frank@acme',
      intent: 'propose_action',
      message: { parts: [{ type: 'text', text: 'please update' }] },
    });
    expect(noPa.body.error.data.code).toBe('invalid_intent_payload');
    expect(noPa.body.error.code).toBe(-32012);

    const inverted = await rpc(bob.key, 'message/send', {
      recipient: 'frank@acme',
      intent: 'inform',
      message: { parts: [{ type: 'text', text: 'msg' }] },
      proposed_action: { description: 'x', target_files: [], rationale: 'y' },
    });
    expect(inverted.body.error.data.code).toBe('invalid_intent_payload');

    const ok = await rpc(bob.key, 'message/send', {
      recipient: 'frank@acme',
      intent: 'propose_action',
      message: { parts: [{ type: 'text', text: 'please do it' }] },
      proposed_action: {
        description: 'rename',
        target_files: ['src/x.ts'],
        rationale: 'because',
      },
    });
    expect(ok.body.result.status.state).toBe('pending');
  });

  it('blocked sender → -32013', async () => {
    const bob = await register('bob@acme');
    const frank = await register('frank@acme');
    await handle.db
      .insert(agentBlocks)
      .values({ blockerId: frank.id, blockedId: bob.id });
    const res = await rpc(bob.key, 'message/send', {
      recipient: 'frank@acme',
      intent: 'inform',
      message: { parts: [{ type: 'text', text: 'hi' }] },
    });
    expect(res.body.error.data.code).toBe('teammate_blocked');
    expect(res.body.error.code).toBe(-32013);
  });

  it('recipient_not_found for unknown handle (-32004)', async () => {
    const bob = await register('bob@acme');
    const res = await rpc(bob.key, 'message/send', {
      recipient: 'ghost@acme',
      intent: 'inform',
      message: { parts: [{ type: 'text', text: 'hi' }] },
    });
    expect(res.body.error.data.code).toBe('recipient_not_found');
    expect(res.body.error.code).toBe(-32004);
  });

  it('disabled agent cannot use API key (-32001)', async () => {
    const bob = await register('bob@acme');
    // disable bob via direct update
    await handle.db.update(agents).set({ status: 'disabled' }).where(eq(agents.id, bob.id));
    const res = await app.request('/a2a', {
      method: 'POST',
      headers: bearer(bob.key),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/list', params: {} }),
    });
    // Either forbidden (agent disabled) or unauthenticated (key revoked) — both 401/403 acceptable.
    expect([401, 403]).toContain(res.status);
  });

  it('audit log captures every state mutation', async () => {
    const bob = await register('bob@acme');
    const frank = await register('frank@acme');
    const created = await rpc(bob.key, 'message/send', {
      recipient: 'frank@acme',
      intent: 'inform',
      message: { parts: [{ type: 'text', text: 'hi' }] },
    });
    const taskId = created.body.result.task_id;
    await rpc(frank.key, 'tasks/update', { task_id: taskId, transition: 'accept' });
    await rpc(bob.key, 'message/send', {
      task_id: taskId,
      message: { parts: [{ type: 'text', text: 'follow-up' }] },
    });
    await rpc(frank.key, 'tasks/update', { task_id: taskId, transition: 'complete' });

    const rows = await handle.sql`
      SELECT action FROM audit_log ORDER BY id ASC
    `;
    const actions = rows.map((r: { action: string }) => r.action);
    expect(actions).toContain('handoff.create');
    expect(actions).toContain('handoff.accept');
    expect(actions).toContain('message.append');
    expect(actions).toContain('handoff.complete');
  });

  it('method_not_found for unknown JSON-RPC method', async () => {
    const bob = await register('bob@acme');
    const res = await rpc(bob.key, 'tasks/explode', {});
    expect(res.body.error.code).toBe(-32601);
    expect(res.body.error.data.code).toBe('method_not_found');
  });

  it('parse_error on malformed JSON', async () => {
    const bob = await register('bob@acme');
    const res = await app.request('/a2a', {
      method: 'POST',
      headers: bearer(bob.key),
      body: '{not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { data: { code: string } } };
    expect(body.error.data.code).toBe('parse_error');
  });
});
