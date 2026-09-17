/**
 * Classroom staff (GH-9): a course can be run by several teachers, with or
 * without assistants. `classrooms.teacher_id` remains the owner — the person
 * who created the classroom — and these rows are the additional members.
 *
 * Rights: every member, teacher or assistant, does everything inside the
 * classroom (roster, assignments, grading, validation). Only the owner (or
 * an admin) manages the staff list and archives/deletes the classroom. The
 * `role` column is a label, not a permission level: no matrix until a real
 * need appears (YAGNI). Note that a staff member holds the global `teacher`
 * role, so they can also create classrooms of their own — accepted, the
 * alternative would be a second global role for no practical gain.
 *
 * Granting is by e-mail, like `teacher_grants`: a colleague can be added
 * before they ever signed in, and `user_id` is resolved either right away
 * (the account exists) or at their next login.
 */
import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { classroomStaff, users } from "../db/schema.js";
import { emailIn, knownEmails, ownersOf } from "../identity.js";
import { syncUserRole } from "../roles.js";

export type StaffRole = (typeof classroomStaff.$inferSelect)["role"];

/** Staff list of a classroom, shipped inside ClassroomDetail. */
export async function staffView(db: Db, classroomId: string) {
  const rows = await db
    .select({
      id: classroomStaff.id,
      email: classroomStaff.email,
      role: classroomStaff.role,
      userId: classroomStaff.userId,
      givenName: users.givenName,
      familyName: users.familyName,
      createdAt: classroomStaff.createdAt,
    })
    .from(classroomStaff)
    .leftJoin(users, eq(classroomStaff.userId, users.id))
    .where(eq(classroomStaff.classroomId, classroomId))
    .orderBy(classroomStaff.email);
  return rows.map(({ userId, ...r }) => ({ ...r, claimed: userId !== null }));
}

/**
 * Attaches the staff seats invited by e-mail to a user who just signed in
 * (mirror of roster.ts `claimEnrollments`). Gated on the verified e-mail by
 * the caller: an unverified address must never inherit someone's seat.
 */
export async function claimStaffSeats(db: Db, user: { id: string }) {
  // GH-11: a colleague invited on their @heig-vd.ch address but signing in
  // under a private one is the same bug as for the students — the seat is
  // matched against every address known for the account.
  const emails = await knownEmails(db, user.id);
  if (emails.length === 0) return 0;
  const claimed = await db
    .update(classroomStaff)
    .set({ userId: user.id })
    .where(and(isNull(classroomStaff.userId), emailIn(classroomStaff.email, emails)))
    .returning({ id: classroomStaff.id });
  return claimed.length;
}

/**
 * Existing verified account holding that address, if any (same rule as the
 * roster claim). Two accounts holding it is a collision: the seat stays
 * unclaimed rather than landing on the wrong person (GH-11).
 */
async function resolveUserId(db: Db, email: string): Promise<string | null> {
  const owners = await ownersOf(db, email);
  return owners.length === 1 ? owners[0]! : null;
}

export type AddStaffResult =
  | { ok: true; member: typeof classroomStaff.$inferSelect }
  | { ok: false; error: "is_owner" | "already_staff" };

/**
 * Adds a member to a classroom's staff. The owner is refused (409): they
 * already have every right, a duplicate row would only confuse the list.
 */
export async function addStaffMember(
  db: Db,
  config: AppConfig,
  input: { classroomId: string; ownerId: string; email: string; role: StaffRole; invitedBy: string },
): Promise<AddStaffResult> {
  const email = input.email.trim().toLowerCase();
  const [owner] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, input.ownerId))
    .limit(1);
  if (owner && owner.email.trim().toLowerCase() === email) return { ok: false, error: "is_owner" };
  const [created] = await db
    .insert(classroomStaff)
    .values({
      id: randomUUID(),
      classroomId: input.classroomId,
      email,
      role: input.role,
      userId: await resolveUserId(db, email),
      invitedBy: input.invitedBy,
    })
    .onConflictDoNothing({ target: [classroomStaff.classroomId, classroomStaff.email] })
    .returning();
  if (!created) return { ok: false, error: "already_staff" };
  // Immediate effect on an existing account: the co-teacher reaches the
  // teacher UI without waiting for their next login.
  await syncUserRole(db, config, email);
  return { ok: true, member: created };
}

/** Removes a staff row; returns it, or null when it is not in that classroom. */
export async function removeStaffMember(
  db: Db,
  config: AppConfig,
  input: { classroomId: string; id: string },
) {
  const [removed] = await db
    .delete(classroomStaff)
    .where(
      and(eq(classroomStaff.id, input.id), eq(classroomStaff.classroomId, input.classroomId)),
    )
    .returning();
  if (!removed) return null;
  // Recomputed, never blindly demoted: a teacher grant or another staff seat
  // keeps the teacher role.
  await syncUserRole(db, config, removed.email);
  return removed;
}
