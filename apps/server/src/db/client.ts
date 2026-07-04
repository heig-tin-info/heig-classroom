import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>["db"];

export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    // La base est locale (même VM) : un connect qui traîne est une panne, pas
    // une latence — on échoue vite et /healthz passe en degraded.
    connectionTimeoutMillis: 2000,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
