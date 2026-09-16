/**
 * Life state of student repositories: one column, one predicate, one rule.
 *
 * A repository deleted out of band on GitHub (the teacher removes it before
 * the deadline) used to be indistinguishable from a transient outage: every
 * write answered 404, the 404 was pushed to `failures`, the job threw, and
 * the ticker (ADR-006) re-enqueued it every 20 s forever — one SSE notice
 * per attempt. `student_repos.deleted_at` is the single source of truth for
 * "this repository no longer exists": set by the `repository` webhook
 * (authoritative, action `deleted`) and by a 404 on a write path (deadline
 * apply, GR-16 review dispatch, milestone dispatch), and honoured by the
 * single `repoIsLive()` predicate every one of those flows selects with.
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { audit } from "./audit.js";
import type { Db } from "./db/client.js";
import { studentRepos } from "./db/schema.js";

/** A repository a flow may act on: provisioned, named, still alive. */
export function repoIsLive() {
  return and(
    eq(studentRepos.provisionStatus, "ok"),
    isNotNull(studentRepos.fullName),
    isNull(studentRepos.deletedAt),
  );
}

/** GitHub answers 404: the repository is gone (or no longer reachable). */
export function isRepoGone(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 404;
}

/**
 * Terminal and idempotent: the repository is gone. Never a retryable
 * failure — retrying a deleted repository is the loop described above.
 * Returns true only for the call that actually marked it (audit once).
 */
export async function markRepoDeleted(db: Db, repoId: string, reason: string): Promise<boolean> {
  const marked = await db
    .update(studentRepos)
    .set({ deletedAt: new Date() })
    .where(and(eq(studentRepos.id, repoId), isNull(studentRepos.deletedAt)))
    .returning({ id: studentRepos.id });
  if (marked.length === 0) return false;
  await audit(db, {
    actorType: "system",
    action: "repo.deleted",
    subjectType: "student_repo",
    subjectId: repoId,
    payload: { reason },
  });
  return true;
}
