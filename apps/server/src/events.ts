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

/** Refresh-hint families the client knows how to react to. */
export type EventType =
  | "assignments"
  | "roster"
  | "repos"
  | "grades"
  | "tasks"
  | "github"
  | "orgs"
  | "mutation";

/** Topic grammar: which audience a hint is addressed to. */
export type Topic = "admin" | `classroom:${string}` | `teacher:${string}` | `user:${string}`;

export interface AppEvent {
  type: EventType;
  topics: Topic[];
  notice?: AppNotice;
}

/**
 * Per-repository families. A student hears about them only through their
 * own `user:` topic, never through `classroom:`: on 2026-09-24 every push,
 * CI run and grade of a 60-student lab reached every student, each of whom
 * refetched their dashboard (N² requests, the database pool timed out), and
 * the `grade_captured` notice showed classmates' grades.
 */
const PER_STUDENT_TYPES = new Set<EventType>(["repos", "grades", "roster", "orgs"]);

/** Does this SSE connection receive the event? `staff`: teacher or admin. */
export function reaches(e: AppEvent, topics: ReadonlySet<string>, staff: boolean): boolean {
  return e.topics.some(
    (t) =>
      topics.has(t) && (staff || !t.startsWith("classroom:") || !PER_STUDENT_TYPES.has(e.type)),
  );
}

const bus = new EventEmitter();
bus.setMaxListeners(0); // one SSE connection per tab

export function publish(type: EventType, topics: Topic[], notice?: AppNotice) {
  if (topics.length === 0) return;
  const event: AppEvent = notice ? { type, topics, notice } : { type, topics };
  bus.emit("event", event);
}

export function subscribe(listener: (e: AppEvent) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
