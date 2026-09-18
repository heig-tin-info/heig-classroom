/**
 * `PushEvent`: the timestamped proof of submission, and the relay's work
 * queue (analyse.md 3.1).
 *
 * Invariant 7 lives in `recordPush` below: the rows are inserted and the
 * insert has resolved *before* the relay is so much as told they exist. A
 * forge outage, a crash between the two, a slow GitHub — none of them can
 * turn a successful student push into a lost submission.
 */
import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";

import { pushEvents, type NewPushEventRow, type PushEventRow } from "../db/schema.js";
import type { RefChange, StagingSession } from "./types.js";

export type { PushEventRow };

/** Git's null object id: a ref that was created (before) or deleted (after). */
export const NULL_OID = "0".repeat(40);

/** Storage the Git channel needs. Implemented on Drizzle in `db.ts`. */
export interface PushEventStore {
  insert(rows: NewPushEventRow[]): Promise<PushEventRow[]>;
  /** Pending rows whose backoff has elapsed, oldest first. */
  dueForRelay(now: Date, limit: number): Promise<PushEventRow[]>;
  markRelayed(ids: string[], at: Date): Promise<void>;
  /** Stays `pending`: a forge outage must not lose the submission. */
  markRetry(ids: string[], nextAttemptAt: Date, error: string): Promise<void>;
  markFailed(ids: string[], error: string): Promise<void>;
  bySession(sessionId: string): Promise<PushEventRow[]>;
}

/** Told about new events once they are durably stored, never before. */
export interface RelayScheduler {
  schedule(events: PushEventRow[]): void | Promise<void>;
}

/**
 * Refs whose value changed between two `for-each-ref` snapshots. A ref that
 * disappeared is reported with `sha = NULL_OID` so the relay can propagate
 * the deletion instead of silently diverging.
 */
export function diffRefs(before: Map<string, string>, after: Map<string, string>): RefChange[] {
  const changes: RefChange[] = [];
  for (const [ref, sha] of after) {
    const old = before.get(ref);
    if (old !== sha) changes.push({ ref, oldSha: old ?? null, sha });
  }
  for (const [ref, old] of before) {
    if (!after.has(ref)) changes.push({ ref, oldSha: old, sha: NULL_OID });
  }
  return changes.sort((a, b) => a.ref.localeCompare(b.ref));
}

export interface RecordPushDeps {
  store: PushEventStore;
  /** Optional: an assignment with no target repository keeps pushes local. */
  relay?: RelayScheduler;
  now?: () => Date;
}

/**
 * Writes one `PushEvent` per changed ref, then — and only then — hands them
 * to the relay. Returns the stored rows.
 */
export async function recordPush(
  deps: RecordPushDeps,
  session: StagingSession,
  changes: RefChange[],
): Promise<PushEventRow[]> {
  if (changes.length === 0) return [];
  const receivedAt = (deps.now ?? (() => new Date()))();
  const rows = await deps.store.insert(
    changes.map((c) => ({
      id: randomUUID(),
      sessionId: session.sessionId,
      student: session.student,
      assignment: session.assignment,
      ref: c.ref,
      sha: c.sha,
      oldSha: c.oldSha,
      receivedAt,
      state: "pending" as const,
      attempts: 0,
      nextAttemptAt: receivedAt,
    })),
  );
  // Invariant 7. `await` above is the whole point: the relay is only ever
  // told about rows that are already in the database.
  if (deps.relay) await deps.relay.schedule(rows);
  return rows;
}

/** Drizzle/SQLite implementation of `PushEventStore`. */
export function createPushEventStore(db: PushEventDb): PushEventStore {
  return {
    async insert(rows) {
      if (rows.length === 0) return [];
      return db.insert(pushEvents).values(rows).returning().all();
    },
    async dueForRelay(now, limit) {
      return db
        .select()
        .from(pushEvents)
        .where(
          and(
            eq(pushEvents.state, "pending"),
            or(isNull(pushEvents.nextAttemptAt), lte(pushEvents.nextAttemptAt, now)),
          ),
        )
        .orderBy(asc(pushEvents.receivedAt))
        .limit(limit)
        .all();
    },
    async markRelayed(ids, at) {
      if (ids.length === 0) return;
      db.update(pushEvents)
        .set({ state: "relayed", relayedAt: at, lastError: null, nextAttemptAt: null })
        .where(inArray(pushEvents.id, ids))
        .run();
    },
    async markRetry(ids, nextAttemptAt, error) {
      if (ids.length === 0) return;
      for (const id of ids) {
        const current = db.select().from(pushEvents).where(eq(pushEvents.id, id)).get();
        db.update(pushEvents)
          .set({
            attempts: (current?.attempts ?? 0) + 1,
            nextAttemptAt,
            lastError: error.slice(0, 2000),
          })
          .where(eq(pushEvents.id, id))
          .run();
      }
    },
    async markFailed(ids, error) {
      if (ids.length === 0) return;
      db.update(pushEvents)
        .set({ state: "failed", lastError: error.slice(0, 2000), nextAttemptAt: null })
        .where(inArray(pushEvents.id, ids))
        .run();
    },
    async bySession(sessionId) {
      return db
        .select()
        .from(pushEvents)
        .where(eq(pushEvents.sessionId, sessionId))
        .orderBy(asc(pushEvents.receivedAt))
        .all();
    },
  };
}

/**
 * Structural type of the Drizzle handle. V1 plugs the portal's database in
 * here (`db/client.ts`), whose schema carries the four tables: the parameter
 * therefore stays open rather than pinned to `Record<string, never>`.
 */
export type PushEventDb = import("drizzle-orm/better-sqlite3").BetterSQLite3Database<
  Record<string, unknown>
>;
