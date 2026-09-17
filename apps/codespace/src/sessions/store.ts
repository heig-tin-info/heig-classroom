/**
 * Accès en base aux devoirs et aux sessions. Pas d'ORM caché : des fonctions
 * qui prennent le handle Drizzle, comme partout ailleurs dans le portail.
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
 * États dans lesquels une session compte encore comme « la » session du
 * couple (étudiant, devoir) (analyse.md D5). `stopped` en fait partie : le
 * conteneur est mort mais le volume et l'identifiant de session survivent, et
 * un rechargement de page doit y revenir plutôt que d'en ouvrir une seconde.
 */
export const LIVE_STATES = ["starting", "running", "stopped"] as const;
export type LiveState = (typeof LIVE_STATES)[number];

export function findAssignment(db: Db, id: string): AssignmentRow | undefined {
  return db.select().from(assignments).where(eq(assignments.id, id)).get();
}

export function listAssignments(db: Db): AssignmentRow[] {
  return db.select().from(assignments).all();
}

/** Devoirs ouverts à l'instant donné : la fenêtre d'ouverture, si elle existe. */
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

/** La session vivante du couple, s'il y en a une. */
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
 * La ligne du couple (étudiant, devoir), quel que soit son état. Il n'y en a
 * qu'une : `manager.ts` réanime celle-ci plutôt que d'en créer une seconde,
 * pour que l'identifiant de session — et donc le remote `origin` écrit dans
 * l'espace de travail — reste stable pour la vie du volume.
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
  if (!row) throw new Error(`session ${id} introuvable`);
  return row;
}

/** `<owner>/<name>` → `RepoRef`. Undefined si la forme n'y est pas. */
export function splitRepoRef(full: string): RepoRef | undefined {
  const slash = full.indexOf("/");
  if (slash <= 0 || slash === full.length - 1) return undefined;
  return { owner: full.slice(0, slash), name: full.slice(slash + 1) };
}

/** Dépôt cible du relais : valeur fixe, ou convention `{student}`. */
export function targetRepoFor(
  assignment: Pick<AssignmentRow, "targetRepo" | "targetRepoPattern">,
  student: string,
): RepoRef | undefined {
  const raw = assignment.targetRepo ?? assignment.targetRepoPattern;
  if (!raw) return undefined;
  return splitRepoRef(raw.replace(/\{student\}/g, student));
}

/**
 * Dépôt cible **de la session**. Le jeton de lancement de classroom apporte
 * le dépôt de l'étudiant, qui fait foi ; la convention du devoir n'est plus
 * qu'un repli pour la graine YAML autonome, dont les sessions n'ont pas de
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
 * Sessions vivantes d'un enseignant, **tous devoirs confondus** : c'est
 * l'unité du quota posé par l'administrateur (docs/pistes.md, « quota de
 * sessions actives par enseignant »). `sessions.teacherId` est recopié du
 * devoir à la création, donc le comptage tient en une requête.
 */
export function countLiveSessionsForTeacher(db: Db, teacherId: string): number {
  const rows = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.teacherId, teacherId), inArray(sessions.state, [...LIVE_STATES])))
    .all();
  return rows.length;
}

/** Sessions d'un devoir, avec leur utilisateur : tableau enseignant de classroom. */
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

/** Le tableau de `/teacher/sessions` : une requête, pas N+1. */
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
