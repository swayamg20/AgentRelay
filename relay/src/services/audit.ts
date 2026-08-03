import type { PgTransaction } from "drizzle-orm/pg-core";
import type { Database } from "../db/client.js";
import { auditLog } from "../db/schema.js";

// Either a Database or an active transaction. Type-erased via a structural
// shape so callers can pass `tx` from `db.transaction(async tx => ...)`.
export type AuditWritable = Pick<Database, "insert"> | PgTransaction<never, never, never>;

interface AuditEntryDetails {
	action: string;
	resourceType: string;
	resourceId: string;
	metadata?: Record<string, unknown>;
	requestId?: string;
}

export type AuditActor =
	| { actorKind: "agent"; actorId: string }
	| { actorKind: "admin" | "system"; actorId: null };

export type AuditEntry = AuditEntryDetails &
	(AuditActor | { actorKind?: undefined; actorId: string });

export async function writeAudit(
	// biome-ignore lint/suspicious/noExplicitAny: drizzle's Database/transaction share the structural insert API
	writer: any,
	entry: AuditEntry,
): Promise<void> {
	await writer.insert(auditLog).values({
		actorKind: entry.actorKind ?? "agent",
		actorId: entry.actorId ?? null,
		action: entry.action,
		resourceType: entry.resourceType,
		resourceId: entry.resourceId,
		metadata: entry.metadata ?? {},
		requestId: entry.requestId ?? null,
	});
}
