import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { classrooms, enrollments, organizations, users } from "../db/schema.js";
import { testDb, type TestDb } from "../test/db.js";
import { claimEnrollments } from "./roster.js";

async function seedClassroom(db: TestDb) {
  const teacherId = randomUUID();
  const orgId = randomUUID();
  const classroomId = randomUUID();
  await db.insert(users).values({
    id: teacherId,
    oidcSub: `t-${teacherId}`,
    email: `t-${teacherId}@heig.test`,
    role: "teacher",
  });
  await db.insert(organizations).values({ id: orgId, login: `org-${orgId.slice(0, 8)}` });
  await db.insert(classrooms).values({ id: classroomId, orgId, teacherId, name: "PRG1" });
  return classroomId;
}

describe("claimEnrollments (AU-18/AU-21)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await testDb();
  });

  it("claims a pending entry whose email matches, case-insensitively", async () => {
    const classroomId = await seedClassroom(db);
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      oidcSub: `s-${userId}`,
      email: "ada.lovelace@heig.test",
      emailVerified: true,
    });
    const enrollmentId = randomUUID();
    await db.insert(enrollments).values({
      id: enrollmentId,
      classroomId,
      nom: "Lovelace",
      prenom: "Ada",
      email: "ada.lovelace@heig.test",
    });

    const claimed = await claimEnrollments(db, { id: userId, email: "Ada.Lovelace@HEIG.test" });

    expect(claimed).toBe(1);
    const [row] = await db.select().from(enrollments).where(eq(enrollments.id, enrollmentId));
    expect(row!.status).toBe("claimed");
    expect(row!.userId).toBe(userId);
    expect(row!.conflictFlag).toBe(false);
  });

  it("flags a conflict instead of double-claiming in the same classroom (AU-21)", async () => {
    // The user already holds a seat under another email in this classroom;
    // a second matching entry must NOT attach (UNIQUE classroom/user) but
    // surface as a conflict for the teacher.
    const classroomId = await seedClassroom(db);
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      oidcSub: `s-${userId}`,
      email: "new.email@heig.test",
      emailVerified: true,
    });
    await db.insert(enrollments).values({
      id: randomUUID(),
      classroomId,
      nom: "Lovelace",
      prenom: "Ada",
      email: "old.email@heig.test",
      status: "claimed",
      userId,
      claimedAt: new Date(),
    });
    const duplicateId = randomUUID();
    await db.insert(enrollments).values({
      id: duplicateId,
      classroomId,
      nom: "Lovelace",
      prenom: "Ada",
      email: "new.email@heig.test",
    });

    const claimed = await claimEnrollments(db, { id: userId, email: "new.email@heig.test" });

    expect(claimed).toBe(0);
    const [dup] = await db.select().from(enrollments).where(eq(enrollments.id, duplicateId));
    expect(dup!.status).toBe("pending");
    expect(dup!.userId).toBeNull();
    expect(dup!.conflictFlag).toBe(true);
  });
});
