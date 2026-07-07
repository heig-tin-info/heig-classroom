/**
 * Bus d'événements in-process (ADR-005) : alimente le flux SSE /app/events.
 * Les événements sont des INDICES de rafraîchissement (type + topics), jamais
 * des données — le client refait ses requêtes autorisées. Si WORKER_MODE
 * scinde un jour les rôles, ce bus passera par LISTEN/NOTIFY Postgres.
 */
import { EventEmitter } from "node:events";

export interface AppEvent {
  type: string;
  /** ex. `classroom:<id>`, `teacher:<userId>`, `user:<userId>` */
  topics: string[];
}

const bus = new EventEmitter();
bus.setMaxListeners(0); // une connexion SSE par onglet

export function publish(type: string, topics: string[]) {
  if (topics.length > 0) bus.emit("event", { type, topics } satisfies AppEvent);
}

export function subscribe(listener: (e: AppEvent) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
