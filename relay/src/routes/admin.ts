import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { generateKey } from '../auth/keys.js';
import { adminAuth } from '../auth/middleware.js';
import type { Database } from '../db/client.js';
import { agents, apiKeys } from '../db/schema.js';
import { RelayError } from '../errors.js';
import type { AppEnv } from '../types.js';

const handleRegex = /^[a-z0-9._-]+@[a-z0-9.-]+$/;

const createAgentSchema = z.object({
  handle: z.string().min(1).max(120).regex(handleRegex, 'handle must look like name@team'),
  email: z.string().email().max(254),
  display_name: z.string().min(1).max(120),
  role: z.string().min(1).max(60),
});

const handleParamSchema = z.object({ id: z.string().uuid() });

export interface AdminRoutesOptions {
  db: Database;
  adminToken: string;
  pepper: string;
  keyEnvironment: 'live' | 'test';
}

export function createAdminRoutes(opts: AdminRoutesOptions): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.use('*', adminAuth({ adminToken: opts.adminToken }));

  // POST /admin/agents — register a new agent + return one-time API key.
  router.post('/agents', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createAgentSchema.safeParse(body);
    if (!parsed.success) {
      throw new RelayError('invalid_params', 'Invalid agent payload', {
        issues: parsed.error.issues,
      });
    }
    const input = parsed.data;
    const generated = generateKey(opts.keyEnvironment, opts.pepper);

    const result = await opts.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.handle, input.handle));
      if (existing) {
        throw new RelayError('invalid_params', `Handle '${input.handle}' is already registered`);
      }
      const [agent] = await tx
        .insert(agents)
        .values({
          handle: input.handle,
          email: input.email,
          displayName: input.display_name,
          role: input.role,
        })
        .returning();
      if (!agent) throw new RelayError('internal', 'Failed to create agent');
      await tx.insert(apiKeys).values({
        agentId: agent.id,
        keyHash: generated.hash,
        salt: generated.salt,
        label: 'initial',
      });
      return agent;
    });

    return c.json(
      {
        agent_id: result.id,
        handle: result.handle,
        api_key: generated.raw,
      },
      201,
    );
  });

  // POST /admin/agents/:id/keys/rotate
  router.post('/agents/:id/keys/rotate', async (c) => {
    const params = handleParamSchema.safeParse(c.req.param());
    if (!params.success) {
      throw new RelayError('invalid_params', 'Invalid agent id');
    }
    const agentId = params.data.id;
    const generated = generateKey(opts.keyEnvironment, opts.pepper);

    const newKey = await opts.db.transaction(async (tx) => {
      const [agent] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, agentId));
      if (!agent) throw new RelayError('recipient_not_found', 'Agent not found');

      // revoke all currently-active keys atomically
      await tx
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(apiKeys.agentId, agentId));

      const [created] = await tx
        .insert(apiKeys)
        .values({
          agentId,
          keyHash: generated.hash,
          salt: generated.salt,
          label: 'rotated',
        })
        .returning();
      if (!created) throw new RelayError('internal', 'Failed to issue rotated key');
      return created;
    });

    return c.json({
      agent_id: agentId,
      api_key: generated.raw,
      key_id: newKey.id,
    });
  });

  // DELETE /admin/agents/:id — soft delete
  router.delete('/agents/:id', async (c) => {
    const params = handleParamSchema.safeParse(c.req.param());
    if (!params.success) {
      throw new RelayError('invalid_params', 'Invalid agent id');
    }
    const [updated] = await opts.db
      .update(agents)
      .set({ status: 'disabled' })
      .where(eq(agents.id, params.data.id))
      .returning({ id: agents.id });
    if (!updated) throw new RelayError('recipient_not_found', 'Agent not found');
    // Revoke all keys belonging to the disabled agent — defence in depth.
    await opts.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.agentId, params.data.id));
    return c.body(null, 204);
  });

  return router;
}
