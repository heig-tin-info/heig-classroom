/**
 * Database access to assignments and sessions. No hidden ORM: functions that
 * take the Drizzle handle, as everywhere else in the portal.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import type { Db } from "../db/client.js";
import {
  assignments,
  pushEvents,
  sessions,
  users,
  type AssignmentRow,
  type SessionRow,
  type UserRow,
} from "../db/schema.js";
import type { RepoRef } from "../git/index.js";

/**
 * States in which a session still counts as "the" session of the (student,
 * assignment) pair (analyse.md D5). `stopped` is one of them: the container is
 * dead but the volume and the session id survive, and a page reload must come
 * back to it rather than open a second one.
 */
export const LIVE_STATES = ["starting", "running", "stopped"] as const;
export type LiveState = (typeof LIVE_STATES)[number];

export function findAssignment(db: Db, id: string): AssignmentRow | undefined {
  return db.select().from(assignments).where(eq(assignments.id, id)).get();
}

export function listAssignments(db: Db): AssignmentRow[] {
  return db.select().from(assignments).all();
}

/** Assignments open at the given instant: the opening window, if it exists. */
export function listOpenAssignments(db: Db, now: Date = new Date()): AssignmentRow[] {
  return listAssignments(db).filter((a) => isOpen(a, now));
}

export function isOpen(assignment: AssignmentRow, now: Date = new Date()): boolean {
  if (assignment.opensAt && now < assignment.opensAt) return false;
  if (assignment.closesAt && now > assignment.closesAt) return false;
  return true;
}

export function findSession(db: Db, id: string): SessionRow | undefined {
  return db.select().from(sessions).where(eq(sessions.id, id)).get();
}

/**
 * The user of a session, by primary key. The session manager needs it at
 * `podman run` time: the git identity set on the container (`display_name`,
 * `email`) comes from this row, and `launch()` only receives the session.
 */
export function findUser(db: Db, id: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

/** The live session of the pair, if there is one. */
export function findLiveSession(
  db: Db,
  student: string,
  assignmentId: string,
): SessionRow | undefined {
  return db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.student, student),
        eq(sessions.assignmentId, assignmentId),
        inArray(sessions.state, [...LIVE_STATES]),
      ),
    )
    .orderBy(desc(sessions.createdAt))
    .get();
}

/**
 * The row of the (student, assignment) pair, whatever its state. There is only
 * one: `manager.ts` revives this one rather than creating a second one, so that
 * the session id — and hence the `origin` remote written into the workspace —
 * stays stable for the lifetime of the volume.
 */
export function findAnySession(
  db: Db,
  student: string,
  assignmentId: string,
): SessionRow | undefined {
  return db
    .select()
    .from(sessions)
    .where(and(eq(sessions.student, student), eq(sessions.assignmentId, assignmentId)))
    .orderBy(desc(sessions.createdAt))
    .get();
}

export function listLiveSessions(db: Db): SessionRow[] {
  return db
    .select()
    .from(sessions)
    .where(inArray(sessions.state, [...LIVE_STATES]))
    .all();
}

export function updateSession(db: Db, id: string, patch: Partial<SessionRow>): SessionRow {
  const [row] = db.update(sessions).set(patch).where(eq(sessions.id, id)).returning().all();
  if (!row) throw new Error(`session ${id} not found`);
  return row;
}

/** `<owner>/<name>` → `RepoRef`. Undefined if the shape is not there. */
export function splitRepoRef(full: string): RepoRef | undefined {
  const slash = full.indexOf("/");
  if (slash <= 0 || slash === full.length - 1) return undefined;
  return { owner: full.slice(0, slash), name: full.slice(slash + 1) };
}

/** Target repository of the relay: fixed value, or `{student}` convention. */
export function targetRepoFor(
  assignment: Pick<AssignmentRow, "targetRepo" | "targetRepoPattern">,
  student: string,
): RepoRef | undefined {
  const raw = assignment.targetRepo ?? assignment.targetRepoPattern;
  if (!raw) return undefined;
  return splitRepoRef(raw.replace(/\{student\}/g, student));
}

/**
 * Target repository **of the session**. Classroom's launch token brings the
 * student's repository, which is authoritative; the assignment's convention is
 * no more than a fallback for the standalone YAML seed, whose sessions have no
 * `targetRepo`.
 */
export function targetRepoOfSession(
  session: Pick<SessionRow, "targetRepo" | "student">,
  assignment: Pick<AssignmentRow, "targetRepo" | "targetRepoPattern"> | undefined,
): RepoRef | undefined {
  if (session.targetRepo) return splitRepoRef(session.targetRepo.fullName);
  return assignment ? targetRepoFor(assignment, session.student) : undefined;
}

/**
 * A teacher's live sessions, **across all assignments**: that is the unit of
 * the quota set by the administrator (docs/pistes.md, "quota of active
 * sessions per teacher"). `sessions.teacherId` is copied from the assignment
 * at creation time, so the count fits in a single query.
 */
export function countLiveSessionsForTeacher(db: Db, teacherId: string): number {
  const rows = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.teacherId, teacherId), inArray(sessions.state, [...LIVE_STATES])))
    .all();
  return rows.length;
}

/** Sessions of an assignment, with their user: classroom's teacher table. */
export function assignmentSessionRows(
  db: Db,
  assignmentId: string,
): Array<{ session: SessionRow; user: UserRow; lastPushAt: Date | null }> {
  const rows = db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.assignmentId, assignmentId))
    .orderBy(desc(sessions.createdAt))
    .all();
  const lastPush = new Map<string, Date>();
  for (const p of db
    .select({ sessionId: pushEvents.sessionId, receivedAt: pushEvents.receivedAt })
    .from(pushEvents)
    .all()) {
    const current = lastPush.get(p.sessionId);
    if (!current || p.receivedAt > current) lastPush.set(p.sessionId, p.receivedAt);
  }
  return rows.map((r) => ({
    session: r.session,
    user: r.user,
    lastPushAt: lastPush.get(r.session.id) ?? null,
  }));
}

export interface TeacherSessionRow {
  session: SessionRow;
  assignmentTitle: string;
  displayName: string;
  lastPushAt: Date | null;
}

/** The table of `/teacher/sessions`: one query, not N+1. */
export function teacherSessionRows(db: Db): TeacherSessionRow[] {
  const rows = db
    .select({ session: sessions, assignment: assignments, user: users })
    .from(sessions)
    .innerJoin(assignments, eq(sessions.assignmentId, assignments.id))
    .innerJoin(users, eq(sessions.userId, users.id))
    .orderBy(desc(sessions.lastSeen))
    .all();
  const pushes = db
    .select({ sessionId: pushEvents.sessionId, receivedAt: pushEvents.receivedAt })
    .from(pushEvents)
    .all();
  const lastPush = new Map<string, Date>();
  for (const p of pushes) {
    const current = lastPush.get(p.sessionId);
    if (!current || p.receivedAt > current) lastPush.set(p.sessionId, p.receivedAt);
  }
  return rows.map((r) => ({
    session: r.session,
    assignmentTitle: r.assignment.title,
    displayName: r.user.displayName || r.user.login,
    lastPushAt: lastPush.get(r.session.id) ?? null,
  }));
}
