import type { Db } from "./db/client.js";
import { auditLog } from "./db/schema.js";

/**
 * Append-only audit log (NFR-05, AU-42). In production the application SQL
 * role has neither UPDATE nor DELETE on this table.
 */
export async function audit(
  db: Db,
  entry: {
    actorUserId?: string | null;
    actorType: "user" | "system" | "api_key";
    action: string;
    subjectType: string;
    subjectId: string;
    payload?: unknown;
  },
) {
  await db.insert(auditLog).values({
    actorUserId: entry.actorUserId ?? null,
    actorType: entry.actorType,
    action: entry.action,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    payload: entry.payload ?? null,
  });
}
