import type { Db } from "./db/client.js";
import { auditLog } from "./db/schema.js";

/**
 * Closed catalogue of audit actions: a typo in a trigger site is a compile
 * error, and this union is the reference for querying the log.
 */
export type AuditAction =
  | "assignment.accept"
  | "assignment.accept_failed"
  | "assignment.archive"
  | "assignment.auto_publish"
  | "assignment.create"
  | "assignment.deadline_applied"
  | "assignment.deadline_reopened"
  | "assignment.delete"
  | "assignment.frozen"
  | "assignment.llm_review_dispatched"
  | "assignment.milestone_dispatched"
  | "assignment.publish"
  | "assignment.sync_requested"
  | "assignment.synced"
  | "assignment.unarchive"
  | "assignment.update"
  | "auth.login"
  | "auth.logout"
  | "avatar.delete"
  | "avatar.update"
  | "classroom.archive"
  | "classroom.create"
  | "classroom.delete"
  | "classroom.rename"
  | "classroom.unarchive"
  | "email.sent"
  | "email.unsubscribe"
  | "github.link"
  | "github.unlink"
  | "milestone.create"
  | "milestone.delete"
  | "org.deleted"
  | "org.installation_deleted"
  | "org.installation_resolved"
  | "org.renamed"
  | "repo.deadline_archived"
  | "repo.grade_now"
  | "repo.lock"
  | "repo.unlock"
  | "repo.protected_files_reverted"
  | "repo.revert_cap"
  | "roster.claim"
  | "roster.claim_conflict"
  | "roster.import"
  | "roster.remove"
  | "roster.self_enroll"
  | "roster.unclaim"
  | "roster.update"
  | "task.configure"
  | "task.run_now"
  | "teacher.grant"
  | "teacher.revoke";

/**
 * Append-only audit log (NFR-05, AU-42). In production the application SQL
 * role has neither UPDATE nor DELETE on this table.
 */
export async function audit(
  db: Db,
  entry: {
    actorUserId?: string | null;
    actorType: "user" | "system" | "api_key";
    action: AuditAction;
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
