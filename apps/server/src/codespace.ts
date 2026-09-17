/**
 * Online workspace (ADR-013): everything classroom needs to talk to the
 * codespace portal (`apps/codespace`).
 *
 * The two applications never share code beyond `packages/*` (root CLAUDE.md,
 * import rule): they exchange the messages of
 * `packages/contracts/src/codespace.ts`, signed HS256 with
 * `CODESPACE_LAUNCH_SECRET` (`packages/domain/src/hs256.ts`).
 *
 * Two directions:
 * - classroom → portal: the assignment definition (`PUT /api/assignments/:id`),
 *   pushed by a pg-boss job (ADR-004) so a portal that is down or restarting
 *   never fails a teacher's save, and the retry is free;
 * - student → portal: a short-lived launch token, minted by
 *   `modules/codespace.ts` and carried in a 303 redirect.
 */
import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";

import type {
  CodespaceAssignmentSync,
  ServiceTokenClaims,
  TeacherCodespaceGrant,
  WorkMode,
} from "@hgc/contracts";
import { signHs256 } from "@hgc/domain";

import { audit } from "./audit.js";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/client.js";
import { assignments, classrooms, teacherGrants, users } from "./db/schema.js";
import { knownEmails, normalizeEmail } from "./identity.js";
import { CODESPACE_SYNC_QUEUE } from "./jobs.js";

/** Default quota of a teacher whose grant row predates the feature. */
export const DEFAULT_MAX_ACTIVE_SESSIONS = 2;

/** Service tokens are server-to-server and short-lived: two minutes. */
const SERVICE_TOKEN_TTL_SECONDS = 120;

/** The portal is wired up at all (empty `CODESPACE_URL` = feature absent). */
export function codespaceConfigured(config: AppConfig): boolean {
  return config.CODESPACE_URL !== "";
}

/**
 * Host of the portal (`localhost:3100`, `codespace.example.ch`), for the
 * `sebs://` deep link a student clicks to hand the exam over to Safe Exam
 * Browser. Null when no portal is configured.
 */
export function codespaceHost(config: AppConfig): string | null {
  if (!codespaceConfigured(config)) return null;
  try {
    return new URL(config.CODESPACE_URL).host;
  } catch {
    return null;
  }
}

/** A mode that runs inside the portal. */
export function isOnlineMode(mode: WorkMode): mode is Exclude<WorkMode, "free"> {
  return mode !== "free";
}

/**
 * The grant of the account holding any of `emails` (the whole address set,
 * GH-11 — a grant issued on the institutional address must reach someone who
 * signs in under a private one).
 */
async function grantForEmails(
  db: Db,
  emails: readonly string[],
): Promise<TeacherCodespaceGrant | null> {
  const normalized = [...new Set(emails.map(normalizeEmail))].filter((e) => e !== "");
  if (normalized.length === 0) return null;
  const rows = await db
    .select({
      enabled: teacherGrants.codespaceEnabled,
      maxActiveSessions: teacherGrants.codespaceMaxActiveSessions,
    })
    .from(teacherGrants)
    .where(inArray(teacherGrants.email, normalized));
  if (rows.length === 0) return null;
  // Several grants (several addresses) — the most permissive wins, as the
  // role rule does.
  return {
    enabled: rows.some((r) => r.enabled),
    maxActiveSessions: Math.max(...rows.map((r) => r.maxActiveSessions)),
  };
}

/**
 * The grant that applies to `user`, or null when the feature is not
 * configured at all. This is THE authorization answer: the assignment form
 * reads it through `Me.codespace` and the write paths re-check it.
 *
 * The administrator is enabled by construction (they hand out the grants and
 * already pass every teacher guard); everyone else needs a `teacher_grants`
 * row with `codespace_enabled`.
 */
export async function codespaceGrantFor(
  db: Db,
  config: AppConfig,
  user: { id: string; role: string },
): Promise<TeacherCodespaceGrant | null> {
  if (!codespaceConfigured(config)) return null;
  const own = await grantForEmails(db, await knownEmails(db, user.id));
  if (user.role === "admin") {
    return { enabled: true, maxActiveSessions: own?.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS };
  }
  return own ?? { enabled: false, maxActiveSessions: DEFAULT_MAX_ACTIVE_SESSIONS };
}

/** The quota carried by the owner of a classroom (who bears it, not the staff). */
export async function quotaForClassroomOwner(db: Db, teacherId: string): Promise<number> {
  const grant = await grantForEmails(db, await knownEmails(db, teacherId));
  return grant?.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS;
}

/** Bearer token of a server-to-server call to the portal API. */
export async function serviceToken(config: AppConfig, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  const claims: ServiceTokenClaims = {
    iss: "heig-classroom",
    aud: "heig-codespace-api",
    iat,
    exp: iat + SERVICE_TOKEN_TTL_SECONDS,
  };
  // The contract types are plain interfaces (no index signature); the JWT
  // helper takes a bare claim bag.
  return signHs256({ ...claims } as Record<string, unknown>, config.CODESPACE_LAUNCH_SECRET);
}

export interface CodespaceSyncJob {
  assignmentId: string;
  [key: string]: unknown;
}

/**
 * Queues a push of the assignment to the portal. Idempotent by singleton key:
 * ten saves in a row collapse into one pending job per assignment.
 */
export async function queueCodespaceSync(app: FastifyInstance, assignmentId: string) {
  if (!app.boss) return;
  await app.boss.send(
    CODESPACE_SYNC_QUEUE,
    { assignmentId },
    { singletonKey: `codespace:${assignmentId}` },
  );
}

/** The body the portal expects, built from the assignment's own row. */
export async function buildSyncPayload(
  db: Db,
  assignmentId: string,
): Promise<CodespaceAssignmentSync | null> {
  const [row] = await db
    .select({
      assignment: assignments,
      classroomName: classrooms.name,
      teacherId: classrooms.teacherId,
      teacherEmail: users.email,
    })
    .from(assignments)
    .innerJoin(classrooms, eq(assignments.classroomId, classrooms.id))
    .innerJoin(users, eq(classrooms.teacherId, users.id))
    .where(eq(assignments.id, assignmentId))
    .limit(1);
  if (!row) return null;
  const a = row.assignment;
  if (!isOnlineMode(a.workMode)) return null;
  // What the workspace is seeded from: the squashed repository when the
  // teacher chose that strategy (their history stays private), the source
  // itself otherwise. Invariant 6 of the portal: in exam mode the transit
  // repository is seeded from the teacher's template, never from the
  // student's own repository — this field is that template.
  const fullName =
    a.sourceStrategy === "squash" && a.squashedFullName ? a.squashedFullName : a.sourceFullName;
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    classroomId: a.classroomId,
    classroomName: row.classroomName,
    mode: a.workMode,
    image: a.codespaceImage,
    sourceRepo: { fullName, defaultBranch: a.branches[0] ?? "main" },
    browserExamKeys: a.browserExamKeys,
    teacher: { id: row.teacherId, email: row.teacherEmail },
    quota: { maxActiveSessions: await quotaForClassroomOwner(db, row.teacherId) },
    startAt: a.startAt.toISOString(),
    deadlineAt: a.deadlineAt?.toISOString() ?? null,
  };
}

/**
 * `codespace.sync` handler: PUT the assignment to the portal, record the
 * outcome on the row, and rethrow on failure so pg-boss retries with
 * backoff (ADR-004). Replaying is safe — the portal's PUT is idempotent.
 */
export function makeCodespaceSyncHandler(app: FastifyInstance, config: AppConfig) {
  return async ({ assignmentId }: CodespaceSyncJob) => {
    if (!codespaceConfigured(config)) return;
    const payload = await buildSyncPayload(app.db, assignmentId);
    // Mode went back to `free`, or the assignment is gone: nothing to push.
    if (!payload) return;

    let response: Response;
    try {
      response = await fetch(`${config.CODESPACE_URL}/api/assignments/${assignmentId}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await serviceToken(config)}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      const message = `portal unreachable: ${String(err).slice(0, 300)}`;
      await app.db
        .update(assignments)
        .set({ codespaceSyncError: message })
        .where(eq(assignments.id, assignmentId));
      throw new Error(message);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const message = `portal answered ${response.status}: ${body.slice(0, 300)}`;
      await app.db
        .update(assignments)
        .set({ codespaceSyncError: message })
        .where(eq(assignments.id, assignmentId));
      throw new Error(message);
    }
    await app.db
      .update(assignments)
      .set({ codespaceSyncedAt: new Date(), codespaceSyncError: null })
      .where(eq(assignments.id, assignmentId));
    await audit(app.db, {
      actorType: "system",
      action: "codespace.assignment_synced",
      subjectType: "assignment",
      subjectId: assignmentId,
      payload: { mode: payload.mode, sourceRepo: payload.sourceRepo.fullName },
    });
  };
}
