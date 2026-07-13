/**
 * In-memory Postgres for DB-dependent tests: PGlite + the real drizzle
 * migrations (the exact SQL production runs at start, MIGRATE_ON_START).
 * `testApp()` returns a minimal FastifyInstance stub carrying `db` and a
 * silent logger — enough for the grading/roster modules under test.
 */
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";

import * as schema from "../db/schema.js";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export async function testDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });
  return db;
}

const silent = () => {};

/** Minimal app stub for functions that take a FastifyInstance. */
export async function testApp(): Promise<FastifyInstance & { db: TestDb }> {
  const db = await testDb();
  return {
    db,
    boss: null,
    log: { info: silent, warn: silent, error: silent, debug: silent },
  } as unknown as FastifyInstance & { db: TestDb };
}
