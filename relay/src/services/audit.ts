import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { Database } from '../db/client.js';
import { auditLog } from '../db/schema.js';

// Either a Database or an active transaction. Type-erased via a structural
// shape so callers can pass `tx` from `db.transaction(async tx => ...)`.
export type AuditWritable = Pick<Database, 'insert'> | PgTransaction<never, never, never>;

export interface AuditEntry {
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

export async function writeAudit(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle's Database/transaction share the structural insert API
  writer: any,
  entry: AuditEntry,
): Promise<void> {
  await writer.insert(auditLog).values({
    actorId: entry.actorId,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    metadata: entry.metadata ?? {},
    requestId: entry.requestId ?? null,
  });
}
