/**
 * Global role, computed from the database in ONE place (SSOT).
 *
 * admin (SUPER_ADMIN_EMAIL) > teacher > student, where "teacher" means
 * either an admin-managed `teacher_grants` row OR membership in the staff of
 * at least one classroom (GH-9): a co-teacher or an assistant must reach the
 * teacher UI, and they were invited by email before they ever logged in.
 *
 * The rule is keyed on the e-mail, never on the current `users.role`, so
 * recomputing is idempotent and can never demote an admin, nor a teacher who
 * still holds a grant or another staff seat.
 */
import { eq, sql } from "drizzle-orm";

import type { AppConfig } from "./config.js";
import type { Db } from "./db/client.js";
import { classroomStaff, teacherGrants, users } from "./db/schema.js";

export type UserRole = (typeof users.$inferSelect)["role"];

export async function roleForEmail(
  db: Db,
  config: AppConfig,
  email: string,
): Promise<UserRole> {
  const normalized = email.trim().toLowerCase();
  if (config.SUPER_ADMIN_EMAIL && normalized === config.SUPER_ADMIN_EMAIL) return "admin";
  const [grant] = await db
    .select({ id: teacherGrants.id })
    .from(teacherGrants)
    .where(eq(teacherGrants.email, normalized))
    .limit(1);
  if (grant) return "teacher";
  const [staff] = await db
    .select({ id: classroomStaff.id })
    .from(classroomStaff)
    .where(eq(classroomStaff.email, normalized))
    .limit(1);
  return staff ? "teacher" : "student";
}

/**
 * Applies the rule to an existing account, so a grant/revoke or a staff
 * add/remove takes effect immediately instead of at the next login.
 * No-op when nobody signed up under that e-mail yet (the role is computed
 * again at their first login anyway).
 */
export async function syncUserRole(db: Db, config: AppConfig, email: string): Promise<UserRole> {
  const normalized = email.trim().toLowerCase();
  const role = await roleForEmail(db, config, normalized);
  await db.update(users).set({ role }).where(sql`lower(${users.email}) = ${normalized}`);
  return role;
}
