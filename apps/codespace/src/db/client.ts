/**
 * Shared Drizzle client (SQLite, better-sqlite3).
 *
 * Replaces `git/db.ts`, which only existed for as long as P3 ran on its own:
 * there is now a single place that opens the database, and the drizzle-kit
 * migrations of `drizzle/` are the only source of the physical schema.
 *
 * `:memory:` is accepted for the tests; the file is created together with its
 * directory otherwise.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  /** Closes the file. Idempotent. */
  close(): void;
}

/**
 * `drizzle`, whatever the working directory at launch **and** whether we run
 * from `src/` (tsx, vitest) or from `dist/` (`pnpm start`): the depth is not
 * the same, so the directory is searched for, not counted.
 */
export function migrationsFolder(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, "drizzle");
    if (existsSync(resolve(candidate, "meta", "_journal.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("drizzle migrations not found");
}

export interface OpenDbOptions {
  /** Applies the migrations when opening. True by default. */
  migrate?: boolean;
  migrationsFolder?: string;
}

export function openDb(path: string, options: OpenDbOptions = {}): DbHandle {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  // WAL: the relay, the garbage collector and the request path write in
  // parallel and must not block each other.
  if (path !== ":memory:") sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // The garbage collector and the proxy write at the same time; without a
  // wait, better-sqlite3 raises SQLITE_BUSY instead of being patient.
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  if (options.migrate !== false) {
    migrate(db, { migrationsFolder: options.migrationsFolder ?? migrationsFolder() });
  }
  let closed = false;
  return {
    db,
    close() {
      if (closed) return;
      closed = true;
      sqlite.close();
    },
  };
}

/**
 * Compatibility with the `git/` tests written before V1: same signature as the
 * old `openGitDb`, but the database is the portal's, migrations included.
 */
export function openGitDb(path: string): { db: Db; close: () => void } {
  const handle = openDb(path);
  return { db: handle.db, close: handle.close };
}
