/**
 * In-process event bus (ADR-005): feeds the /app/events SSE stream.
 * Events are refresh HINTS (type + topics), never data; the client re-issues
 * its authorized requests. If WORKER_MODE ever splits the roles, this bus
 * will go through Postgres LISTEN/NOTIFY.
 */
import { EventEmitter } from "node:events";

import type { NoticeKind } from "@hgc/contracts";

/** Real-time notification attached to an event (toast in the UI). */
export interface AppNotice {
  kind: NoticeKind;
  message: string;
}

/**
 * Refresh-hint families the client knows how to react to. `journal` is
 * classroom-wide on purpose: the pages of a journal are the same for every
 * reader, so one hint on `classroom:<id>` is right, and it is NOT in
 * `PER_STUDENT_TYPES` below — a student SHOULD hear that the course material
 * changed.
 *
 * `topics` is a control hint (issue #46): the recipient's subscription set
 * changed (staff added or removed, enrollment claimed or removed, classroom
 * archived, notification preference). The server closes the SSE connections
 * that receive it and the client reconnects with its topics recomputed.
 */
export type EventType =
  | "assignments"
  | "roster"
  | "repos"
  | "grades"
  | "journal"
  | "tasks"
  | "github"
  | "orgs"
  | "mutation"
  | "topics";

/**
 * Topic grammar: which audience a hint is addressed to (issue #46).
 * - `user:<id>`: that account, whatever its role (their own repository,
 *   grade, enrollment, operation they started);
 * - `teacher:<id>`: that teacher's classroom list;
 * - `classroom-staff:<id>`: the current staff of a non-archived classroom
 *   (owner or `classroom_staff` row);
 * - `classroom:<id>`: the students holding a claimed enrollment there. It
 *   only carries SILENT hints of shared data (assignment list, publication,
 *   journal): never a notice, never a per-repository family;
 * - `admin`: administrators.
 */
export type Topic =
  | "admin"
  | `classroom:${string}`
  | `classroom-staff:${string}`
  | `teacher:${string}`
  | `user:${string}`;

export interface AppEvent {
  type: EventType;
  topics: Topic[];
  notice?: AppNotice;
}

/** The staff of a classroom. */
export const staffTopic = (classroomId: string): Topic => `classroom-staff:${classroomId}`;

/** Everyone in a classroom: its staff, and its students for shared data. */
export const classroomTopics = (classroomId: string): Topic[] => [
  `classroom:${classroomId}`,
  `classroom-staff:${classroomId}`,
];

/**
 * Per-repository families. A student hears about them only through their
 * own `user:` topic, never through `classroom:`: on 2026-09-24 every push,
 * CI run and grade of a 60-student lab reached every student, each of whom
 * refetched their dashboard (N² requests, the database pool timed out), and
 * the `grade_captured` notice showed classmates' grades.
 */
const PER_STUDENT_TYPES = new Set<EventType>(["repos", "grades", "roster", "orgs"]);

/**
 * Notices about what students do. Through `classroom-staff:<id>` they reach
 * only the staff members who want them for that classroom (co-staff policy
 * (b), issue #46: owner on by default, co-teachers and assistants opt in).
 * The other kinds are operations run on the classroom (deadline, sync, LLM
 * review): every staff member hears about them.
 */
export const STUDENT_ACTIVITY_KINDS = new Set<NoticeKind>([
  "student_joined",
  "assignment_accepted",
  "commit_pushed",
  "grade_captured",
  "protected_reverted",
]);

/** What one SSE connection listens to, computed when it opens. */
export interface Audience {
  topics: ReadonlySet<string>;
  /** Staff classrooms whose student-activity notices this user wants. */
  studentActivity: ReadonlySet<string>;
}

const STAFF_PREFIX = "classroom-staff:";
const STUDENT_PREFIX = "classroom:";

/** Does this connection receive the event (as a refresh hint)? */
export function reaches(e: AppEvent, a: Audience): boolean {
  return e.topics.some(
    (t) => a.topics.has(t) && (!t.startsWith(STUDENT_PREFIX) || !PER_STUDENT_TYPES.has(e.type)),
  );
}

/**
 * The notice this connection shows with the event, if any. A notice needs a
 * topic that may carry it: never `classroom:` (students only hear about their
 * own things, on `user:`), and `classroom-staff:` only for operations or when
 * the user opted in to that classroom's student activity. A `user:` topic
 * always carries it — what concerns you, or what you started, always notifies.
 */
export function noticeFor(e: AppEvent, a: Audience): AppNotice | null {
  const notice = e.notice;
  if (!notice) return null;
  const carried = e.topics.some((t) => {
    if (!a.topics.has(t)) return false;
    if (t.startsWith(STUDENT_PREFIX)) return false;
    if (t.startsWith(STAFF_PREFIX)) {
      return (
        !STUDENT_ACTIVITY_KINDS.has(notice.kind) ||
        a.studentActivity.has(t.slice(STAFF_PREFIX.length))
      );
    }
    return true;
  });
  return carried ? notice : null;
}

const bus = new EventEmitter();
bus.setMaxListeners(0); // one SSE connection per tab

export function publish(type: EventType, topics: Topic[], notice?: AppNotice) {
  if (topics.length === 0) return;
  const event: AppEvent = notice ? { type, topics, notice } : { type, topics };
  bus.emit("event", event);
}

/** Tells these users' open connections to reconnect with fresh topics. */
export function publishTopicsChanged(userIds: Iterable<string | null | undefined>) {
  const topics = [...new Set(userIds)]
    .filter((id): id is string => Boolean(id))
    .map((id) => `user:${id}` as const);
  publish("topics", topics);
}

export function subscribe(listener: (e: AppEvent) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
