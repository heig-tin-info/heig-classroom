/**
 * Global role, computed from the database in ONE place (SSOT).
 *
 * admin (SUPER_ADMIN_EMAIL) > teacher > student, where "teacher" means an
 * admin-managed `teacher_grants` row, membership in the staff of at least
 * one classroom (GH-9), or a `staff` affiliation at the IdP (GH-11).
 *
 * The rule is keyed on the account's e-mail ADDRESSES, never on the current
 * `users.role`, so recomputing is idempotent and can never demote an admin,
 * nor a teacher who still holds a grant or another staff seat. Since GH-11
 * it reads the whole address set: a grant issued on an institutional address
 * must apply to someone who signs in under a private one.
 */
import { eq, inArray } from "drizzle-orm";

import { affiliationKinds } from "./auth/claims.js";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/client.js";
import { classroomStaff, teacherGrants, userIdpClaims, users } from "./db/schema.js";
import { knownEmails, normalizeEmail, ownersOf } from "./identity.js";

export type UserRole = (typeof users.$inferSelect)["role"];

/** What the rule needs: the addresses of the account, and its affiliations. */
export interface Identity {
  emails: readonly string[];
  /** edu-ID affiliations, scoped or not (`student@hes-so.ch`, `staff`). */
  affiliations?: readonly string[];
}

export async function roleForIdentity(
  db: Db,
  config: AppConfig,
  identity: Identity,
): Promise<UserRole> {
  const emails = [...new Set(identity.emails.map(normalizeEmail))].filter((e) => e !== "");
  if (config.SUPER_ADMIN_EMAIL && emails.includes(normalizeEmail(config.SUPER_ADMIN_EMAIL))) {
    return "admin";
  }
  if (emails.length > 0) {
    const [grant] = await db
      .select({ id: teacherGrants.id })
      .from(teacherGrants)
      .where(inArray(teacherGrants.email, emails))
      .limit(1);
    if (grant) return "teacher";
    const [staff] = await db
      .select({ id: classroomStaff.id })
      .from(classroomStaff)
      .where(inArray(classroomStaff.email, emails))
      .limit(1);
    if (staff) return "teacher";
  }
  // GH-11: edu-ID tells us who is staff. A `staff` affiliation WITHOUT a
  // `student` one is an employee, and reaches the teacher UI without an
  // invitation. Their own classrooms only: the classroom guards are
  // unchanged, so this grants no access to anyone else's.
  const kinds = affiliationKinds(identity.affiliations ?? []);
  if (kinds.includes("staff") && !kinds.includes("student")) return "teacher";
  return "student";
}

/** The stored identity of an existing account. */
export async function roleForUser(
  db: Db,
  config: AppConfig,
  userId: string,
): Promise<UserRole> {
  const [stored] = await db
    .select({ affiliations: userIdpClaims.affiliations })
    .from(userIdpClaims)
    .where(eq(userIdpClaims.userId, userId))
    .limit(1);
  return roleForIdentity(db, config, {
    emails: await knownEmails(db, userId),
    affiliations: stored?.affiliations ?? [],
  });
}

/**
 * Applies the rule to the accounts holding `email`, so a grant/revoke or a
 * staff add/remove takes effect immediately instead of at the next login.
 * No-op when nobody signed up under that address yet (the role is computed
 * again at their first login anyway).
 */
export async function syncUserRole(db: Db, config: AppConfig, email: string): Promise<number> {
  const normalized = normalizeEmail(email);
  // An account that has not signed in since the GH-11 backfill may still be
  // known only by its login address.
  const owners = await ownersOf(db, normalized);
  if (owners.length === 0) {
    const legacy = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalized));
    owners.push(...legacy.map((u) => u.id));
  }
  for (const userId of owners) {
    const role = await roleForUser(db, config, userId);
    await db.update(users).set({ role }).where(eq(users.id, userId));
  }
  return owners.length;
}
