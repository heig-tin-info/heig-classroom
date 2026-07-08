import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>["db"];

export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    // The database is local (same VM): a slow connect is an outage, not
    // latency, so we fail fast and /healthz turns degraded.
    connectionTimeoutMillis: 2000,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
