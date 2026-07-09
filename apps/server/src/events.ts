/**
 * In-process event bus (ADR-005): feeds the /app/events SSE stream.
 * Events are refresh HINTS (type + topics), never data; the client re-issues
 * its authorized requests. If WORKER_MODE ever splits the roles, this bus
 * will go through Postgres LISTEN/NOTIFY.
 */
import { EventEmitter } from "node:events";

/** Real-time notification attached to an event (toast in the UI). */
export interface AppNotice {
  kind:
    | "student_joined"
    | "assignment_accepted"
    | "commit_pushed"
    | "grade_captured"
    | "protected_reverted"
    | "deadline_applied"
    | "llm_review_dispatched"
    | "sync";
  message: string;
}

export interface AppEvent {
  type: string;
  /** e.g. `classroom:<id>`, `teacher:<userId>`, `user:<userId>` */
  topics: string[];
  notice?: AppNotice;
}

const bus = new EventEmitter();
bus.setMaxListeners(0); // one SSE connection per tab

export function publish(type: string, topics: string[], notice?: AppNotice) {
  if (topics.length === 0) return;
  const event: AppEvent = notice ? { type, topics, notice } : { type, topics };
  bus.emit("event", event);
}

export function subscribe(listener: (e: AppEvent) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
