import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import type { AppConfig } from "../config.js";
import {
  classroomStaff,
  classrooms,
  organizations,
  teacherGrants,
  userEmails,
  users,
} from "../db/schema.js";
import { testDb, type TestDb } from "../test/db.js";
import { staffAccess } from "./guards.js";
import { addStaffMember, claimStaffSeats, removeStaffMember } from "./staff.js";

const config = { SUPER_ADMIN_EMAIL: "boss@heig.test" } as AppConfig;

/** An account with its address set, as a login writes it (GH-11). */
async function seedUser(db: TestDb, email: string, role: "student" | "teacher" = "student") {
  const id = randomUUID();
  await db
    .insert(users)
    .values({ id, oidcSub: `u-${id}`, email, emailVerified: true, role });
  await db
    .insert(userEmails)
    .values({ userId: id, email: email.toLowerCase(), source: "login", verified: true });
  return id;
}

async function seedClassroom(db: TestDb, teacherId: string) {
  const orgId = randomUUID();
  const classroomId = randomUUID();
  await db.insert(organizations).values({ id: orgId, login: `org-${orgId.slice(0, 8)}` });
  await db.insert(classrooms).values({ id: classroomId, orgId, teacherId, name: "PRG1" });
  return classroomId;
}

/** The loaders' condition, isolated: `select … from classrooms where …`. */
async function reachable(db: TestDb, userId: string, classroomId: string) {
  const rows = await db
    .select({ id: classrooms.id })
    .from(classrooms)
    .where(and(eq(classrooms.id, classroomId), staffAccess(userId)));
  return rows.length === 1;
}

async function roleOf(db: TestDb, userId: string) {
  const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  return row!.role;
}

describe("classroom staff (GH-9)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await testDb();
  });

  it("the access predicate covers the owner and the staff, nobody else", async () => {
    const ownerId = await seedUser(db, `owner-${randomUUID()}@heig.test`, "teacher");
    const mateId = await seedUser(db, `mate-${randomUUID()}@heig.test`, "teacher");
    const strangerId = await seedUser(db, `other-${randomUUID()}@heig.test`, "teacher");
    const classroomId = await seedClassroom(db, ownerId);
    await db.insert(classroomStaff).values({
      id: randomUUID(),
      classroomId,
      email: "mate@heig.test",
      role: "assistant",
      userId: mateId,
      invitedBy: ownerId,
    });

    expect(await reachable(db, ownerId, classroomId)).toBe(true);
    expect(await reachable(db, mateId, classroomId)).toBe(true);
    expect(await reachable(db, strangerId, classroomId)).toBe(false);
  });

  it("adding by e-mail resolves an existing account and promotes it to teacher", async () => {
    const ownerId = await seedUser(db, `owner-${randomUUID()}@heig.test`, "teacher");
    const classroomId = await seedClassroom(db, ownerId);
    const email = `assistant-${randomUUID()}@heig.test`;
    const assistantId = await seedUser(db, email);

    const res = await addStaffMember(db, config, {
      classroomId,
      ownerId,
      email: email.toUpperCase(),
      role: "assistant",
      invitedBy: ownerId,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.member.email).toBe(email.toLowerCase());
    expect(res.member.userId).toBe(assistantId);
    expect(await roleOf(db, assistantId)).toBe("teacher");
    expect(await reachable(db, assistantId, classroomId)).toBe(true);
  });

  it("refuses the owner and a duplicate e-mail", async () => {
    const ownerEmail = `owner-${randomUUID()}@heig.test`;
    const ownerId = await seedUser(db, ownerEmail, "teacher");
    const classroomId = await seedClassroom(db, ownerId);
    const email = `mate-${randomUUID()}@heig.test`;

    const asOwner = await addStaffMember(db, config, {
      classroomId,
      ownerId,
      email: ownerEmail,
      role: "teacher",
      invitedBy: ownerId,
    });
    expect(asOwner).toEqual({ ok: false, error: "is_owner" });

    const add = { classroomId, ownerId, email, role: "teacher" as const, invitedBy: ownerId };
    expect((await addStaffMember(db, config, add)).ok).toBe(true);
    expect(await addStaffMember(db, config, add)).toEqual({ ok: false, error: "already_staff" });
  });

  it("removing the last seat demotes a plain user, but never a granted teacher", async () => {
    const ownerId = await seedUser(db, `owner-${randomUUID()}@heig.test`, "teacher");
    const roomA = await seedClassroom(db, ownerId);
    const roomB = await seedClassroom(db, ownerId);
    const email = `mate-${randomUUID()}@heig.test`;
    const mateId = await seedUser(db, email);

    const inA = await addStaffMember(db, config, {
      classroomId: roomA,
      ownerId,
      email,
      role: "teacher",
      invitedBy: ownerId,
    });
    const inB = await addStaffMember(db, config, {
      classroomId: roomB,
      ownerId,
      email,
      role: "assistant",
      invitedBy: ownerId,
    });
    expect(inA.ok && inB.ok).toBe(true);
    if (!inA.ok || !inB.ok) return;

    // One seat left: still a teacher.
    await removeStaffMember(db, config, { classroomId: roomA, id: inA.member.id });
    expect(await roleOf(db, mateId)).toBe("teacher");

    // Last seat gone: back to student.
    await removeStaffMember(db, config, { classroomId: roomB, id: inB.member.id });
    expect(await roleOf(db, mateId)).toBe("student");
    expect(await reachable(db, mateId, roomB)).toBe(false);

    // Same scenario for someone who also holds an admin grant: kept.
    const grantedEmail = `granted-${randomUUID()}@heig.test`;
    const grantedId = await seedUser(db, grantedEmail);
    await db
      .insert(teacherGrants)
      .values({ id: randomUUID(), email: grantedEmail, createdBy: ownerId });
    const seat = await addStaffMember(db, config, {
      classroomId: roomA,
      ownerId,
      email: grantedEmail,
      role: "assistant",
      invitedBy: ownerId,
    });
    expect(seat.ok).toBe(true);
    if (!seat.ok) return;
    await removeStaffMember(db, config, { classroomId: roomA, id: seat.member.id });
    expect(await roleOf(db, grantedId)).toBe("teacher");
  });

  it("a seat invited before signup is claimed at login (case-insensitive)", async () => {
    const ownerId = await seedUser(db, `owner-${randomUUID()}@heig.test`, "teacher");
    const classroomId = await seedClassroom(db, ownerId);
    const email = `late-${randomUUID()}@heig.test`;

    const res = await addStaffMember(db, config, {
      classroomId,
      ownerId,
      email,
      role: "teacher",
      invitedBy: ownerId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.member.userId).toBeNull();

    // The colleague signs in for the first time.
    const lateId = await seedUser(db, email.toUpperCase());
    expect(await claimStaffSeats(db, { id: lateId })).toBe(1);
    expect(await reachable(db, lateId, classroomId)).toBe(true);
  });
});
