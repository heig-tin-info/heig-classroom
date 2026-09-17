/**
 * Client Drizzle partagé (SQLite, better-sqlite3).
 *
 * Remplace `git/db.ts`, qui n'existait que le temps que P3 tourne seul : il y
 * a maintenant un seul endroit qui ouvre la base, et les migrations
 * drizzle-kit de `drizzle/` sont la seule source du schéma
 * physique.
 *
 * `:memory:` est accepté pour les tests ; le fichier est créé avec son
 * répertoire sinon.
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
  /** Ferme le fichier. Idempotent. */
  close(): void;
}

/**
 * `drizzle`, quel que soit le répertoire de lancement **et** que
 * l'on tourne depuis `src/` (tsx, vitest) ou depuis `dist/` (`pnpm start`) :
 * la profondeur n'est pas la même, donc le répertoire est cherché, pas compté.
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
  throw new Error("migrations drizzle introuvables");
}

export interface OpenDbOptions {
  /** Applique les migrations à l'ouverture. Vrai par défaut. */
  migrate?: boolean;
  migrationsFolder?: string;
}

export function openDb(path: string, options: OpenDbOptions = {}): DbHandle {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  // WAL : le relais, le ramasse-miettes et le chemin de requête écrivent en
  // parallèle et ne doivent pas se bloquer.
  if (path !== ":memory:") sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // Le ramasse-miettes et le proxy écrivent en même temps ; sans attente,
  // better-sqlite3 lève SQLITE_BUSY au lieu de patienter.
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
 * Compatibilité avec les tests de `git/` écrits avant V1 : même signature que
 * l'ancien `openGitDb`, mais la base est celle du portail, migrations
 * comprises.
 */
export function openGitDb(path: string): { db: Db; close: () => void } {
  const handle = openDb(path);
  return { db: handle.db, close: handle.close };
}
