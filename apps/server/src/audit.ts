import type { Db } from "./db/client.js";
import { auditLog } from "./db/schema.js";

/**
 * Journal d'audit append-only (NFR-05, AU-42). En production le rôle SQL
 * applicatif n'a ni UPDATE ni DELETE sur cette table.
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
