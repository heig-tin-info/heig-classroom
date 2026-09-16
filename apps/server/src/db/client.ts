import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>["db"];

/** Just enough of `app.log` to report a pool failure; `console` also fits,
 *  for the pools built before the app exists (migrations in server.ts). */
type PoolLogger = { error: (obj: object, msg: string) => void };

export function createDb(databaseUrl: string, log: PoolLogger = console) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    // The database is local (same VM): a slow connect is an outage, not
    // latency, so we fail fast and /healthz turns degraded.
    connectionTimeoutMillis: 2000,
  });
  // pg.Pool is an EventEmitter, and an *idle* client that dies (Postgres
  // restart, OOM kill, network reset) has no pending query to reject: pg-pool
  // drops the client and emits `error` on the pool. Node turns an unhandled
  // `error` event into an uncaught exception, so this listener is what keeps
  // the process alive, not just diagnostics. The client is already gone; the
  // next query opens a fresh one. `cause` sits next to `err` for the same
  // reason as in app.ts: pino keeps the cause text but drops its pg fields.
  pool.on("error", (err) => {
    log.error({ err, cause: err.cause }, "idle database client error");
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
