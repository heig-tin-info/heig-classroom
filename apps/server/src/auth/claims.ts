/**
 * IdP claim capture (GH-11).
 *
 * Switch edu-ID identifies a person by a self-chosen preferred address,
 * which may perfectly well be a private mailbox, while GAPS exports the
 * institutional one — so matching a roster line on `users.email` alone
 * fails for those students. The addresses we need (and the affiliations
 * that tell a student from a staff member) live behind the
 * `https://eduid.ch/scope/userinfo.read` scope, and edu-ID only releases
 * what its Resource Registry entry allows: what actually arrives can only
 * be observed on a real login.
 *
 * Hence this module: the whole claim set of every login is persisted, as
 * released. Deliberately NOT minimized — an authentication problem is
 * expensive to diagnose after the fact and this snapshot is the cheap
 * insurance. In exchange the data stays confined here: `user_idp_claims`
 * is never joined into a user-facing view, never displayed, never exposed
 * by the API.
 */
import { sql } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { userEmails, userIdpClaims } from "../db/schema.js";
import { normalizeEmail } from "../identity.js";

/** Claims whose value only means something inside the token exchange. */
const TOKEN_ONLY = new Set([
  "at_hash",
  "c_hash",
  "s_hash",
  "nonce",
  "iss",
  "aud",
  "azp",
  "exp",
  "iat",
  "nbf",
  "jti",
]);

/**
 * A multi-valued claim, normalized. edu-ID specifies JSON arrays, but the
 * SAML-era bridges also hand out a single comma (or semicolon) separated
 * string, so both are accepted.
 */
export function claimList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((v) => (typeof v === "string" ? v.split(/[,;]/) : typeof v === "number" ? [String(v)] : []))
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

/**
 * The affiliation claims, merged, lowercased, deduplicated. edu-ID releases
 * `eduPersonAffiliation` (unscoped) alongside the scoped ones and does NOT
 * release `eduPersonPrimaryAffiliation` — observed on production, not
 * guessed; the latter is read anyway in case that ever changes.
 */
export function affiliationsOf(claims: Record<string, unknown>): string[] {
  const all = [
    ...claimList(claims.eduPersonPrimaryAffiliation),
    ...claimList(claims.eduPersonAffiliation),
    ...claimList(claims.eduPersonScopedAffiliation),
    ...claimList(claims.swissEduIDLinkedAffiliation),
  ].map((v) => v.toLowerCase());
  return [...new Set(all)];
}

/**
 * Claims carrying e-mail addresses, most trustworthy first. Only
 * `swissEduIDLinkedAffiliationMail` is released to us today; the others cost
 * nothing to read and cover a change in the Resource Registry entry.
 */
const MAIL_CLAIMS = [
  "swissEduIDLinkedAffiliationMail",
  "swissEduPersonOrganizationalMail",
  "swissEduIDAssociatedMail",
  "swissEduPersonPrivateMail",
] as const;

export interface KnownAddress {
  email: string;
  /** `login`, or the claim the address came from. */
  source: string;
}

/**
 * Every address a login reveals: the `email` claim, then those asserted by
 * the institution. Deduplicated on the address, first source wins.
 */
export function addressesOf(claims: Record<string, unknown>): KnownAddress[] {
  const found = new Map<string, KnownAddress>();
  const add = (raw: string, source: string) => {
    const email = normalizeEmail(raw);
    if (email !== "" && !found.has(email)) found.set(email, { email, source });
  };
  if (typeof claims.email === "string") add(claims.email, "login");
  for (const claim of MAIL_CLAIMS) {
    for (const value of claimList(claims[claim])) add(value, claim);
  }
  return [...found.values()];
}

/**
 * Bare affiliation kinds (`student`, `staff`, …), the scope dropped:
 * `student@heig-vd.ch` and `student` both yield `student`.
 */
export function affiliationKinds(affiliations: readonly string[]): string[] {
  return [...new Set(affiliations.map((a) => a.split("@")[0]!).filter((a) => a !== ""))];
}

/** Everything worth keeping from a login, the token plumbing removed. */
export function persistableClaims(claims: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(claims).filter(([k]) => !TOKEN_ONLY.has(k)));
}

/**
 * One row per user, overwritten at each login: the point is to know what
 * the IdP says *now*, not to build a history nobody would read.
 */
export async function recordIdpClaims(
  db: Db,
  userId: string,
  claims: Record<string, unknown>,
): Promise<void> {
  const kept = persistableClaims(claims);
  const values = {
    userId,
    claims: kept,
    affiliations: affiliationsOf(kept),
    updatedAt: new Date(),
  };
  await db
    .insert(userIdpClaims)
    .values(values)
    .onConflictDoUpdate({
      target: userIdpClaims.userId,
      set: {
        claims: sql`excluded.claims`,
        affiliations: sql`excluded.affiliations`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

/**
 * Records the addresses a login revealed. Purely additive: an address seen
 * once is never removed, and `first_seen_at` keeps the date of the login
 * that revealed it.
 *
 * Only the login address carries the IdP's `email_verified`; an address
 * asserted by the home organization is verified by construction — that is
 * precisely why it is worth more than the preferred address the user chose.
 */
export async function syncUserEmails(
  db: Db,
  userId: string,
  claims: Record<string, unknown>,
  loginVerified: boolean,
): Promise<number> {
  const addresses = addressesOf(claims);
  if (addresses.length === 0) return 0;
  const inserted = await db
    .insert(userEmails)
    .values(
      addresses.map((a) => ({
        userId,
        email: a.email,
        source: a.source,
        verified: a.source === "login" ? loginVerified : true,
      })),
    )
    .onConflictDoNothing({ target: [userEmails.userId, userEmails.email] })
    .returning({ email: userEmails.email });
  return inserted.length;
}
