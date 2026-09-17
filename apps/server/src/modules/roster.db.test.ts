import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { classrooms, enrollments, organizations, userEmails, users } from "../db/schema.js";
import { testDb, type TestDb } from "../test/db.js";
import { claimEnrollments, claimForExistingUsers } from "./roster.js";

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

/** An account and its address set, as a login writes them (GH-11). */
async function seedUser(db: TestDb, login: string, ...institutional: string[]) {
  const id = randomUUID();
  await db
    .insert(users)
    .values({ id, oidcSub: `s-${id}`, email: login, emailVerified: true });
  await db.insert(userEmails).values([
    { userId: id, email: login, source: "login", verified: true },
    ...institutional.map((email) => ({
      userId: id,
      email,
      source: "swissEduIDLinkedAffiliationMail",
      verified: true,
    })),
  ]);
  return id;
}

async function seedEntry(db: TestDb, classroomId: string, email: string, nom = "Lovelace") {
  const id = randomUUID();
  await db.insert(enrollments).values({ id, classroomId, nom, prenom: "Ada", email });
  return id;
}

async function entry(db: TestDb, id: string) {
  const [row] = await db.select().from(enrollments).where(eq(enrollments.id, id));
  return row!;
}

describe("claimEnrollments (AU-18/AU-21)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await testDb();
  });

  it("claims a pending entry whose email matches, case-insensitively", async () => {
    const classroomId = await seedClassroom(db);
    const userId = await seedUser(db, "ada.lovelace@heig.test");
    const enrollmentId = await seedEntry(db, classroomId, "Ada.Lovelace@HEIG.test");

    expect(await claimEnrollments(db, { id: userId })).toBe(1);
    const row = await entry(db, enrollmentId);
    expect(row.status).toBe("claimed");
    expect(row.userId).toBe(userId);
    expect(row.conflictFlag).toBe(false);
  });

  it("claims on the institutional address when the login address is private (GH-11)", async () => {
    // The exact production case: edu-ID hands over a Gmail address while the
    // GAPS roster only holds the @heig-vd.ch one.
    const classroomId = await seedClassroom(db);
    const userId = await seedUser(db, "willy.tk89@gmail.test", "william.ammann@heig.test");
    const enrollmentId = await seedEntry(db, classroomId, "william.ammann@heig.test", "Ammann");

    expect(await claimEnrollments(db, { id: userId })).toBe(1);
    expect((await entry(db, enrollmentId)).userId).toBe(userId);
  });

  it("claims nothing for an account with no known address", async () => {
    const classroomId = await seedClassroom(db);
    const id = randomUUID();
    await db
      .insert(users)
      .values({ id, oidcSub: `s-${id}`, email: "ghost@heig.test", emailVerified: true });
    const enrollmentId = await seedEntry(db, classroomId, "ghost@heig.test");

    expect(await claimEnrollments(db, { id })).toBe(0);
    expect((await entry(db, enrollmentId)).status).toBe("pending");
  });

  it("flags a conflict instead of double-claiming in the same classroom (AU-21)", async () => {
    const classroomId = await seedClassroom(db);
    const userId = await seedUser(db, "new.email@heig.test");
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
    const duplicateId = await seedEntry(db, classroomId, "new.email@heig.test");

    expect(await claimEnrollments(db, { id: userId })).toBe(0);
    const dup = await entry(db, duplicateId);
    expect(dup.status).toBe("pending");
    expect(dup.userId).toBeNull();
    expect(dup.conflictFlag).toBe(true);
  });

  it("refuses to choose when two entries of one classroom match the same account", async () => {
    // A private address AND an institutional one, each on its own roster
    // line: attaching either would be a guess.
    const classroomId = await seedClassroom(db);
    const userId = await seedUser(db, "thomas.colau@ik.test", "thomas.colau@heig.test");
    const a = await seedEntry(db, classroomId, "thomas.colau@ik.test", "Colau");
    const b = await seedEntry(db, classroomId, "thomas.colau@heig.test", "Colau");

    expect(await claimEnrollments(db, { id: userId })).toBe(0);
    for (const id of [a, b]) {
      const row = await entry(db, id);
      expect(row.status).toBe("pending");
      expect(row.conflictFlag).toBe(true);
    }
  });

  it("refuses to attach an address two accounts claim to hold", async () => {
    const classroomId = await seedClassroom(db);
    const shared = "shared.address@heig.test";
    await seedUser(db, "first@gmail.test", shared);
    const second = await seedUser(db, "second@gmail.test", shared);
    const enrollmentId = await seedEntry(db, classroomId, shared, "Shared");

    expect(await claimEnrollments(db, { id: second })).toBe(0);
    const row = await entry(db, enrollmentId);
    expect(row.status).toBe("pending");
    expect(row.userId).toBeNull();
    expect(row.conflictFlag).toBe(true);
  });
});

describe("claimForExistingUsers (reverse claim)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await testDb();
  });

  it("attaches an existing account through its institutional address", async () => {
    const classroomId = await seedClassroom(db);
    const userId = await seedUser(db, "leoverdelaw@gmail.test", "leo.verdelaw@heig.test");
    const enrollmentId = await seedEntry(db, classroomId, "leo.verdelaw@heig.test", "Verdelaw");

    expect(await claimForExistingUsers(db, classroomId)).toBe(1);
    expect((await entry(db, enrollmentId)).userId).toBe(userId);
  });

  it("flags rather than picking when two accounts hold the entry's address", async () => {
    const classroomId = await seedClassroom(db);
    const shared = "twins@heig.test";
    await seedUser(db, "twin-a@gmail.test", shared);
    await seedUser(db, "twin-b@gmail.test", shared);
    const enrollmentId = await seedEntry(db, classroomId, shared, "Twin");

    expect(await claimForExistingUsers(db, classroomId)).toBe(0);
    const row = await entry(db, enrollmentId);
    expect(row.status).toBe("pending");
    expect(row.conflictFlag).toBe(true);
  });
});
