/**
 * The set of e-mail addresses that identify an account (GH-11), and the
 * collisions that set can create.
 *
 * Before this, a person was their login address. Switch edu-ID broke that
 * assumption: the address it hands over is the one the user picked, which
 * for five of our students is a Gmail or Infomaniak mailbox, while the GAPS
 * roster only ever holds `@heig-vd.ch`. Identity is therefore a set — the
 * login address plus whatever the institution asserts — and every match in
 * the application runs against that set.
 *
 * A set brings ambiguity that a single column could not have: two accounts
 * may end up sharing an address. Nothing is ever attached on an ambiguous
 * match; it is flagged for a teacher to resolve (AU-21).
 */
import { and, eq, inArray, ne, sql, type AnyColumn, type SQL } from "drizzle-orm";

import type { Db } from "./db/client.js";
import { userEmails } from "./db/schema.js";

/** Trim + lowercase, the normalization the roster import already applies. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Verified addresses of an account, normalized. Empty means "matches nothing". */
export async function knownEmails(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ email: userEmails.email })
    .from(userEmails)
    .where(and(eq(userEmails.userId, userId), eq(userEmails.verified, true)));
  return rows.map((r) => r.email);
}

/** Accounts holding this address, verified only. More than one is a collision. */
export async function ownersOf(db: Db, email: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: userEmails.userId })
    .from(userEmails)
    .where(and(eq(userEmails.email, normalizeEmail(email)), eq(userEmails.verified, true)));
  return rows.map((r) => r.userId);
}

/**
 * Among `emails`, those also held by an account other than `userId` — the
 * addresses a claim must not act on.
 */
export async function sharedWithOthers(
  db: Db,
  userId: string,
  emails: readonly string[],
): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ email: userEmails.email })
    .from(userEmails)
    .where(
      and(
        inArray(userEmails.email, emails.map(normalizeEmail)),
        ne(userEmails.userId, userId),
        eq(userEmails.verified, true),
      ),
    );
  return new Set(rows.map((r) => r.email));
}

/**
 * `column` (an e-mail column) matches any of `emails`, case-insensitively.
 * An empty set matches nothing — never everything.
 */
export function emailIn(column: AnyColumn, emails: readonly string[]): SQL {
  if (emails.length === 0) return sql`false`;
  return inArray(sql`lower(${column})`, emails.map(normalizeEmail));
}
