/**
 * Opaque server-side sessions (AU-06): a random 256-bit token is handed to
 * the browser, only its SHA-256 is persisted; a leak of the table does not
 * allow replaying a session. Invalidation = DELETE.
 */
import { createHash, randomBytes } from "node:crypto";

import { eq, lt } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";

export const SESSION_COOKIE = "hgc_session";
export const CSRF_COOKIE = "hgc_csrf";
export const CSRF_HEADER = "x-csrf-token";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function createSession(db: Db, userId: string, ttlHours: number) {
  const token = newToken();
  const csrf = newToken();
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  await db.insert(sessions).values({ sidHash: hashToken(token), userId, expiresAt });
  return { token, csrf, expiresAt };
}

export async function findSessionUser(db: Db, token: string) {
  const rows = await db
    .select({ user: users, expiresAt: sessions.expiresAt, sidHash: sessions.sidHash })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.sidHash, hashToken(token)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(sessions).where(eq(sessions.sidHash, row.sidHash));
    return null;
  }
  return row.user;
}

export async function deleteSession(db: Db, token: string) {
  await db.delete(sessions).where(eq(sessions.sidHash, hashToken(token)));
}

/** Purge of expired sessions (wired to `purge.housekeeping` in M3). */
export async function purgeExpiredSessions(db: Db) {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
