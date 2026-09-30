/**
 * Issue #46: who hears what. A student of classroom A, the owner of A, a
 * co-teacher of A and a teacher of classroom B each compute their SSE
 * audience from the database, then see the events that real publishers
 * (and the publishers' topic shapes) emit.
 */
import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { classroomStaff, classrooms, enrollments, organizations, userEmails, users } from "../db/schema.js";
import {
  type AppEvent,
  type Audience,
  classroomTopics,
  noticeFor,
  publish,
  reaches,
  staffTopic,
  subscribe,
} from "../events.js";
import { testDb, type TestDb } from "../test/db.js";
import { connectionAudience } from "./events.js";
import { claimEnrollments } from "./roster.js";
import { setStudentNotices, studentNotices } from "./staff.js";

async function seedUser(db: TestDb, role: "student" | "teacher") {
  const id = randomUUID();
  const email = `${role}-${id}@heig.test`;
  await db.insert(users).values({ id, oidcSub: `u-${id}`, email, emailVerified: true, role });
  await db.insert(userEmails).values({ userId: id, email, source: "login", verified: true });
  return { id, role, email };
}

async function seedClassroom(db: TestDb, teacherId: string, archived = false) {
  const orgId = randomUUID();
  const id = randomUUID();
  await db.insert(organizations).values({ id: orgId, login: `org-${orgId.slice(0, 8)}` });
  await db.insert(classrooms).values({
    id,
    orgId,
    teacherId,
    name: "PRG1",
    ...(archived ? { archivedAt: new Date() } : {}),
  });
  return id;
}

/** What one connection shows: the refresh hints and the toasts. */
function seenBy(events: AppEvent[], a: Audience) {
  const hints = events.filter((e) => reaches(e, a));
  return {
    hints: hints.map((e) => e.type),
    notices: hints.map((e) => noticeFor(e, a)?.kind).filter(Boolean),
  };
}

function capture(fn: () => Promise<unknown> | void) {
  const events: AppEvent[] = [];
  const off = subscribe((e) => events.push(e));
  return Promise.resolve(fn())
    .then(() => events)
    .finally(off);
}

describe("notification audience (issue #46)", () => {
  let db: TestDb;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let coTeacher: Awaited<ReturnType<typeof seedUser>>;
  let teacherB: Awaited<ReturnType<typeof seedUser>>;
  let student: Awaited<ReturnType<typeof seedUser>>;
  let newcomer: Awaited<ReturnType<typeof seedUser>>;
  let roomA: string;
  let roomB: string;
  let archived: string;

  beforeAll(async () => {
    db = await testDb();
    owner = await seedUser(db, "teacher");
    coTeacher = await seedUser(db, "teacher");
    teacherB = await seedUser(db, "teacher");
    student = await seedUser(db, "student");
    newcomer = await seedUser(db, "student");
    roomA = await seedClassroom(db, owner.id);
    roomB = await seedClassroom(db, teacherB.id);
    archived = await seedClassroom(db, teacherB.id, true);
    await db.insert(classroomStaff).values({
      id: randomUUID(),
      classroomId: roomA,
      email: coTeacher.email,
      role: "teacher",
      userId: coTeacher.id,
      invitedBy: owner.id,
    });
    await db.insert(enrollments).values([
      {
        id: randomUUID(),
        classroomId: roomA,
        nom: "Doe",
        prenom: "Jane",
        email: student.email,
        status: "claimed",
        userId: student.id,
        claimedAt: new Date(),
      },
      // The owner's self-enrolled seat in their own classroom.
      {
        id: randomUUID(),
        classroomId: roomA,
        nom: "Owner",
        prenom: "The",
        email: owner.email,
        status: "claimed",
        userId: owner.id,
        claimedAt: new Date(),
        staff: true,
      },
      // A teacher of B enrolled as a student in A (the #39 assistant case).
      {
        id: randomUUID(),
        classroomId: roomA,
        nom: "B",
        prenom: "Teacher",
        email: teacherB.email,
        status: "claimed",
        userId: teacherB.id,
        claimedAt: new Date(),
      },
      { id: randomUUID(), classroomId: roomA, nom: "New", prenom: "Kid", email: newcomer.email },
    ]);
  });

  it("computes topics from the relationship, not the role", async () => {
    const s = await connectionAudience(db, student);
    expect([...s.topics].sort()).toEqual([`classroom:${roomA}`, `user:${student.id}`].sort());

    const o = await connectionAudience(db, owner);
    // Staff of A: never a student recipient there, despite the staff seat.
    expect(o.topics.has(staffTopic(roomA))).toBe(true);
    expect(o.topics.has(`classroom:${roomA}`)).toBe(false);
    expect([...o.studentActivity]).toEqual([roomA]);

    const co = await connectionAudience(db, coTeacher);
    expect(co.topics.has(staffTopic(roomA))).toBe(true);
    expect(co.studentActivity.size).toBe(0); // co-staff: off by default

    const b = await connectionAudience(db, teacherB);
    expect(b.topics.has(staffTopic(roomB))).toBe(true);
    expect(b.topics.has(staffTopic(archived))).toBe(false); // archived: left out
    expect(b.topics.has(staffTopic(roomA))).toBe(false);
    expect(b.topics.has(`classroom:${roomA}`)).toBe(true); // a student there
  });

  it("each one sees only their own notices, and the opt-in switch works", async () => {
    const events = await capture(async () => {
      // A student joins A (real publisher).
      await claimEnrollments(db, { id: newcomer.id });
      // Jane's grade in A (grading.ts shape).
      publish("grades", [staffTopic(roomA), `user:${student.id}`], {
        kind: "grade_captured",
        message: "Grade 8/10 captured on labo-02-jdoe",
      });
      // Deadline enforced in A (deadline.ts shape): notice to staff only,
      // silent refresh for the students.
      publish("assignments", [staffTopic(roomA)], {
        kind: "deadline_applied",
        message: "Deadline enforced",
      });
      publish("assignments", [`classroom:${roomA}`]);
      // A push in B (webhooks.ts shape).
      publish("repos", [staffTopic(roomB), `user:${randomUUID()}`], {
        kind: "commit_pushed",
        message: "New push",
      });
      // A push in the archived classroom.
      publish("repos", [staffTopic(archived)], { kind: "commit_pushed", message: "Old push" });
      // A new assignment published in A (shared data).
      publish("assignments", classroomTopics(roomA));
    });

    const s = seenBy(events, await connectionAudience(db, student));
    expect(s.notices).toEqual(["grade_captured"]); // their own grade only
    expect(s.hints).toContain("assignments");
    expect(s.hints).not.toContain("roster");

    const o = seenBy(events, await connectionAudience(db, owner));
    expect(o.notices).toEqual(["student_joined", "grade_captured", "deadline_applied"]);

    const co = seenBy(events, await connectionAudience(db, coTeacher));
    // Refreshes of A, but only the operation toast.
    expect(co.hints).toEqual(expect.arrayContaining(["roster", "grades", "assignments"]));
    expect(co.notices).toEqual(["deadline_applied"]);

    const b = seenBy(events, await connectionAudience(db, teacherB));
    // Their own classroom's push; nothing of A's staff notices although they
    // sit in A as a student; nothing of the archived classroom.
    expect(b.notices).toEqual(["commit_pushed"]);
    expect(b.hints.filter((h) => h === "repos")).toHaveLength(1);

    // The co-teacher turns "Notify me about students" on for A.
    await setStudentNotices(db, { classroomId: roomA, userId: coTeacher.id, on: true });
    expect(await studentNotices(db, { id: roomA, teacherId: owner.id }, coTeacher.id)).toBe(true);
    const coOn = seenBy(events, await connectionAudience(db, coTeacher));
    expect(coOn.notices).toEqual(["student_joined", "grade_captured", "deadline_applied"]);

    // The owner may turn it off.
    await setStudentNotices(db, { classroomId: roomA, userId: owner.id, on: false });
    const oOff = seenBy(events, await connectionAudience(db, owner));
    expect(oOff.notices).toEqual(["deadline_applied"]);
    expect(oOff.hints).toContain("grades"); // the refresh is never gated
  });

  it("a claim asks the newcomer's connections to reconnect", async () => {
    const late = await seedUser(db, "student");
    await db
      .insert(enrollments)
      .values({ id: randomUUID(), classroomId: roomB, nom: "Late", prenom: "Kid", email: late.email });
    const before = await connectionAudience(db, late);
    const events = await capture(() => claimEnrollments(db, { id: late.id }));
    expect(events.some((e) => e.type === "topics" && reaches(e, before))).toBe(true);
    const after = await connectionAudience(db, late);
    expect(after.topics.has(`classroom:${roomB}`)).toBe(true);
  });
});
