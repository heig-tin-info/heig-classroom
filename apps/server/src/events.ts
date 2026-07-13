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
