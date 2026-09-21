/**
 * Group formation (issue #2, lot 1) end to end over the real routes: PGlite
 * plays the migrations, a bare Fastify carries the module with a signed-in
 * teacher. The interesting cases are the refusals — a group that already owns
 * a repository is frozen (lot 2 territory), and publishing a group assignment
 * with students left over is refused by name.
 */
import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import type { AssignmentGroupsPayload } from "@hgc/contracts";

import type { AppConfig } from "../../config.js";
import {
  assignmentGroupMembers,
  assignmentGroups,
  assignments,
  classrooms,
  enrollments,
  organizations,
  studentRepos,
  users,
} from "../../db/schema.js";
import { testDb, type TestDb } from "../../test/db.js";
import { claimScheduledPublications } from "../../ticker.js";
import { assignmentGroupRoutes } from "./groups.js";
import { assignmentLifecycleRoutes } from "./lifecycle.js";

type Seed = Awaited<ReturnType<typeof seed>>;

/** The routes under a signed-in teacher; no session machinery, no GitHub. */
async function serve(
  db: TestDb,
  teacherId: string,
  register: (app: FastifyInstance, opts: { config: AppConfig }) => Promise<void> = (a, o) =>
    assignmentGroupRoutes(a, o),
) {
  const app = Fastify();
  app.decorate("db", db as unknown as FastifyInstance["db"]);
  app.decorate("requireSession", async () => undefined);
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    req.user = { id: teacherId, role: "teacher" } as never;
  });
  await register(app as unknown as FastifyInstance, { config: {} as AppConfig });
  await app.ready();
  return app;
}

/** One classroom, one draft group assignment, and `names` students. */
async function seed(db: TestDb, opts: { groupMode?: boolean; names?: string[] } = {}) {
  const teacherId = randomUUID();
  const orgId = randomUUID();
  const classroomId = randomUUID();
  const assignmentId = randomUUID();
  await db.insert(users).values({
    id: teacherId,
    oidcSub: `t-${teacherId}`,
    email: `t-${teacherId}@heig.test`,
    role: "teacher",
  });
  await db.insert(organizations).values({ id: orgId, login: `org-${orgId.slice(0, 8)}` });
  await db.insert(classrooms).values({ id: classroomId, orgId, teacherId, name: "PRG1" });
  await db.insert(assignments).values({
    id: assignmentId,
    classroomId,
    name: "Labo 1",
    slug: "labo-1",
    startAt: new Date("2026-09-01T08:00:00Z"),
    deadlineAt: new Date("2126-09-08T08:00:00Z"),
    sourceRepoId: 1,
    sourceFullName: "org/labo-1",
    branches: ["main"],
    protectedFiles: [],
    groupMode: opts.groupMode ?? true,
    groupMaxSize: 3,
  });
  const students: Record<string, string> = {};
  const names = opts.names ?? ["Ammann", "Bovet", "Curie", "Dubois", "Euler"];
  for (const [i, nom] of names.entries()) {
    const id = randomUUID();
    await db.insert(enrollments).values({
      id,
      classroomId,
      nom,
      prenom: "Alex",
      // Homonyms are two roster lines, hence two addresses.
      email: `${nom.toLowerCase()}-${i}@heig.test`,
    });
    students[nom] = id;
  }
  // A staff seat is not part of the headcount, so not of the groups either.
  await db.insert(enrollments).values({
    id: randomUUID(),
    classroomId,
    nom: "Assistant",
    prenom: "Sam",
    email: `sam-${randomUUID()}@heig.test`,
    staff: true,
  });
  return { teacherId, orgId, classroomId, assignmentId, students };
}

const url = (s: Seed, suffix = "") =>
  `/app/api/classrooms/${s.classroomId}/assignments/${s.assignmentId}/groups${suffix}`;

/** Creates a group and returns it. */
async function addGroup(app: FastifyInstance, s: Seed, name?: string) {
  const res = await app.inject({ method: "POST", url: url(s), payload: name ? { name } : {} });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; name: string; slug: string };
}

async function addMember(app: FastifyInstance, s: Seed, groupId: string, enrollmentId: string) {
  return app.inject({
    method: "POST",
    url: url(s, `/${groupId}/members`),
    payload: { enrollmentId },
  });
}

/** Lot 2, simulated: the group's repository exists, so the group is locked. */
async function giveRepo(db: TestDb, s: Seed, groupId: string, enrollmentId: string) {
  const userId = randomUUID();
  await db
    .insert(users)
    .values({ id: userId, oidcSub: `s-${userId}`, email: `u-${userId}@heig.test` });
  await db
    .update(enrollments)
    .set({ userId, status: "claimed" })
    .where(eq(enrollments.id, enrollmentId));
  await db.insert(studentRepos).values({
    id: randomUUID(),
    assignmentId: s.assignmentId,
    userId,
    groupId,
    fullName: "org/labo-1-group-1",
    provisionStatus: "ok",
  });
}

describe("group formation (issue #2, lot 1)", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await testDb();
  });

  it("lists the groups, their members and the students left over", async () => {
    const s = await seed(db);
    const app = await serve(db, s.teacherId);
    const g1 = await addGroup(app, s);
    const g2 = await addGroup(app, s);
    await addMember(app, s, g1.id, s.students.Curie!);
    await addMember(app, s, g1.id, s.students.Ammann!);

    const payload = (await app.inject({ method: "GET", url: url(s) })).json<AssignmentGroupsPayload>();
    expect(payload.assignment).toMatchObject({ groupMode: true, groupMaxSize: 3, state: "draft" });
    expect(payload.groups.map((g) => g.name)).toEqual(["Group 1", "Group 2"]);
    expect(payload.groups[0]!.slug).toBe("group-1");
    // Roster order inside the group, not insertion order.
    expect(payload.groups[0]!.members.map((m) => m.nom)).toEqual(["Ammann", "Curie"]);
    expect(payload.groups[0]!.repo).toBeNull();
    expect(payload.groups[1]!.members).toEqual([]);
    // The staff seat never shows up, the four others do, in roster order.
    expect(payload.unassigned.map((m) => m.nom)).toEqual(["Bovet", "Dubois", "Euler"]);
    expect(payload.copySources).toEqual([]);
    await app.close();
  });

  it("names a new group after the first free number and refuses a duplicate", async () => {
    const s = await seed(db);
    const app = await serve(db, s.teacherId);
    const g1 = await addGroup(app, s);
    await addGroup(app, s);
    // Freeing “Group 1” hands the name back to the next creation.
    expect((await app.inject({ method: "DELETE", url: url(s, `/${g1.id}`) })).statusCode).toBe(204);
    expect((await addGroup(app, s)).name).toBe("Group 1");

    const clash = await app.inject({ method: "POST", url: url(s), payload: { name: "Group 2" } });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toBe("duplicate_name");
    await app.close();
  });

  it("the default name steps over a slug another name already owns", async () => {
    const s = await seed(db);
    const app = await serve(db, s.teacherId);
    await addGroup(app, s); // Group 1 / group-1
    // “Group 2!” is a free NAME that owns the slug group-2: proposing
    // “Group 2” would hand the primary button a name that can only 409.
    expect((await addGroup(app, s, "Group 2!")).slug).toBe("group-2");
    const next = await addGroup(app, s);
    expect(next.name).toBe("Group 3");
    expect(next.slug).toBe("group-3");

    // And a free name whose slug is taken is suffixed, never refused.
    const twin = await addGroup(app, s, "group 3");
    expect(twin).toMatchObject({ name: "group 3", slug: "group-3-2" });
    await app.close();
  });

  it("renames a group, slug included, and refuses a colliding name", async () => {
    const s = await seed(db);
    const app = await serve(db, s.teacherId);
    const g1 = await addGroup(app, s);
    const g2 = await addGroup(app, s);

    const ok = await app.inject({
      method: "PATCH",
      url: url(s, `/${g1.id}`),
      payload: { name: "Les Castors" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ name: "Les Castors", slug: "les-castors" });

    const clash = await app.inject({
      method: "PATCH",
      url: url(s, `/${g2.id}`),
      payload: { name: "Les Castors" },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toBe("duplicate_name");
    await app.close();
  });

  it("deleting a group puts its members back in the unassigned pane", async () => {
    const s = await seed(db);
    const app = await serve(db, s.teacherId);
    const g1 = await addGroup(app, s);
    await addMember(app, s, g1.id, s.students.Bovet!);

    expect((await app.inject({ method: "DELETE", url: url(s, `/${g1.id}`) })).statusCode).toBe(204);
    const payload = (await app.inject({ method: "GET", url: url(s) })).json<AssignmentGroupsPayload>();
    expect(payload.groups).toEqual([]);
    expect(payload.unassigned.map((m) => m.nom)).toContain("Bovet");
    // No orphan membership left behind (cascade).
    const rows = await db
      .select()
      .from(assignmentGroupMembers)
      .where(eq(assignmentGroupMembers.assignmentId, s.assignmentId));
    expect(rows).toEqual([]);
    await app.close();
  });

  it("adding a student to another group moves them, it never duplicates", async () => {
    const s = await seed(db);
    const app = await serve(db, s.teacherId);
    const g1 = await addGroup(app, s);
    const g2 = await addGroup(app, s);
    await addMember(app, s, g1.id, s.students.Euler!);

    const moved = await addMember(app, s, g2.id, s.students.Euler!);
    expect(moved.statusCode).toBe(200);
    const payload = moved.json<AssignmentGroupsPayload>();
    expect(payload.groups[0]!.members).toEqual([]);
    expect(payload.groups[1]!.members.map((m) => m.nom)).toEqual(["Euler"]);
    expect(payload.unassigned.map((m) => m.nom)).not.toContain("Euler");
    // UNIQUE(assignment, enrollment): exactly one membership, whatever happens.
    const rows = await db
      .select()
      .from(assignmentGroupMembers)
      .where(eq(assignmentGroupMembers.enrollmentId, s.students.Euler!));
    expect(rows).toHaveLength(1);
    await app.close();
  });

  it("adding the same student twice is idempotent, not a unique-index 500", async () => {
    const s = await seed(db);
    const app = await serve(db, s.teacherId);
    const g1 = await addGroup(app, s);

    // Two clicks (or two racing tabs) on the same row.
    const [first, second] = await Promise.all([
      addMember(app, s, g1.id, s.students.Dubois!),
      addMember(app, s, g1.id, s.students.Dubois!),
    ]);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    const rows = await db
      .select()
      .from(assignmentGroupMembers)
      .where(eq(assignmentGroupMembers.enrollmentId, s.students.Dubois!));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.groupId).toBe(g1.id);
    await app.close();
  });

  it("refuses a student who is not a non-staff member of this classroom", async () => {
    const s = await seed(db);
    const other = await seed(db);
    const app = await serve(db, s.teacherId);
    const g1 = await addGroup(app, s);

    expect((await addMember(app, s, g1.id, other.students.Bovet!)).statusCode).toBe(404);
    const [staffSeat] = await db
      .select()
      .from(enrollments)
      .where(and(eq(enrollments.classroomId, s.classroomId), eq(enrollments.staff, true)));
    expect((await addMember(app, s, g1.id, staffSeat!.id)).statusCode).toBe(404);
    await app.close();
  });

  it("removes a member and hands them back to the unassigned pane", async () => {
    const s = await seed(db);
    const app = await serve(db, s.teacherId);
    const g1 = await addGroup(app, s);
    await addMember(app, s, g1.id, s.students.Curie!);

    const res = await app.inject({
      method: "DELETE",
      url: url(s, `/${g1.id}/members/${s.students.Curie}`),
    });
    expect(res.statusCode).toBe(200);
    const payload = res.json<AssignmentGroupsPayload>();
    expect(payload.groups[0]!.members).toEqual([]);
    expect(payload.unassigned.map((m) => m.nom)).toContain("Curie");
    await app.close();
  });

  it("a group that owns a repository is locked: no rename, no delete, no removal", async () => {
    const s = await seed(db);
    const app = await serve(db, s.teacherId);
    const g1 = await addGroup(app, s);
    const g2 = await addGroup(app, s);
    await addMember(app, s, g1.id, s.students.Ammann!);
    await addMember(app, s, g1.id, s.students.Bovet!);
    await giveRepo(db, s, g1.id, s.students.Ammann!);

    const rename = await app.inject({
      method: "PATCH",
      url: url(s, `/${g1.id}`),
      payload: { name: "Renamed" },
    });
    expect(rename.statusCode).toBe(409);
    expect(rename.json().error).toBe("has_repo");
    expect((await app.inject({ method: "DELETE", url: url(s, `/${g1.id}`) })).statusCode).toBe(409);
    const removal = await app.inject({
      method: "DELETE",
      url: url(s, `/${g1.id}/members/${s.students.Bovet}`),
    });
    expect(removal.statusCode).toBe(409);
    expect(removal.json().error).toBe("has_repo");
    // Moving someone OUT of it is a removal in disguise: refused too…
    expect((await addMember(app, s, g2.id, s.students.Bovet!)).statusCode).toBe(409);
    // …while joining it stays possible (lot 2 will invite the newcomer).
    expect((await addMember(app, s, g1.id, s.students.Curie!)).statusCode).toBe(200);

    const payload = (await app.inject({ method: "GET", url: url(s) })).json<AssignmentGroupsPayload>();
    expect(payload.groups[0]!.repo).toEqual({
      fullName: "org/labo-1-group-1",
      provisionStatus: "ok",
    });
    await app.close();
  });

  it("copies the groups of another assignment of the same classroom", async () => {
    const s = await seed(db);
    const app = await serve(db, s.teacherId);
    // The source: two groups, filled on its own screen.
    const source = { ...s, assignmentId: randomUUID() };
    await db.insert(assignments).values({
      id: source.assignmentId,
      classroomId: s.classroomId,
      name: "Labo 0",
      slug: "labo-0",
      startAt: new Date("2026-08-01T08:00:00Z"),
      deadlineAt: new Date("2026-08-08T08:00:00Z"),
      sourceRepoId: 2,
      sourceFullName: "org/labo-0",
      branches: ["main"],
      protectedFiles: [],
      groupMode: true,
    });
    const sg1 = await addGroup(app, source, "Les Castors");
    const sg2 = await addGroup(app, source);
    await addMember(app, source, sg1.id, s.students.Ammann!);
    await addMember(app, source, sg2.id, s.students.Euler!);

    // The target already has a group of its own: the copy replaces everything.
    const stale = await addGroup(app, s, "Stale");
    await addMember(app, s, stale.id, s.students.Curie!);

    const res = await app.inject({
      method: "POST",
      url: url(s, "/copy"),
      payload: { fromAssignmentId: source.assignmentId },
    });
    expect(res.statusCode).toBe(200);
    const payload = res.json<AssignmentGroupsPayload>();
    expect(payload.groups.map((g) => g.name)).toEqual(["Les Castors", "Group 1"]);
    expect(payload.groups[0]!.members.map((m) => m.nom)).toEqual(["Ammann"]);
    expect(payload.groups[1]!.members.map((m) => m.nom)).toEqual(["Euler"]);
    expect(payload.unassigned.map((m) => m.nom)).toContain("Curie");
    // The source is offered as a copy source, with its group count.
    expect(payload.copySources).toEqual([
      { id: source.assignmentId, name: "Labo 0", groups: 2 },
    ]);
    await app.close();
  });

  it("refuses to copy from another classroom, or over a group that has a repository", async () => {
    const s = await seed(db);
    const elsewhere = await seed(db);
    const app = await serve(db, s.teacherId);
    const foreign = await app.inject({
      method: "POST",
      url: url(s, "/copy"),
      payload: { fromAssignmentId: elsewhere.assignmentId },
    });
    expect(foreign.statusCode).toBe(404);

    // A real source in the same classroom, and a target group with a
    // repository: replacing the groups would delete it, so the copy refuses.
    const sourceId = randomUUID();
    await db.insert(assignments).values({
      id: sourceId,
      classroomId: s.classroomId,
      name: "Labo 0",
      slug: "labo-0",
      startAt: new Date("2026-08-01T08:00:00Z"),
      deadlineAt: new Date("2026-08-08T08:00:00Z"),
      sourceRepoId: 2,
      sourceFullName: "org/labo-0",
      branches: ["main"],
      protectedFiles: [],
      groupMode: true,
    });
    await addGroup(app, { ...s, assignmentId: sourceId });
    const g1 = await addGroup(app, s);
    await addMember(app, s, g1.id, s.students.Ammann!);
    await giveRepo(db, s, g1.id, s.students.Ammann!);
    const locked = await app.inject({
      method: "POST",
      url: url(s, "/copy"),
      payload: { fromAssignmentId: sourceId },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error).toBe("has_repo");
    await app.close();
  });

  it("refuses to copy from a source that has no group, instead of wiping the target", async () => {
    const s = await seed(db);
    const app = await serve(db, s.teacherId);
    const emptyId = randomUUID();
    await db.insert(assignments).values({
      id: emptyId,
      classroomId: s.classroomId,
      name: "Labo 0",
      slug: "labo-0",
      startAt: new Date("2026-08-01T08:00:00Z"),
      deadlineAt: new Date("2026-08-08T08:00:00Z"),
      sourceRepoId: 2,
      sourceFullName: "org/labo-0",
      branches: ["main"],
      protectedFiles: [],
      groupMode: true,
    });
    const mine = await addGroup(app, s, "Les Castors");
    await addMember(app, s, mine.id, s.students.Ammann!);

    const res = await app.inject({
      method: "POST",
      url: url(s, "/copy"),
      payload: { fromAssignmentId: emptyId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("empty_source");
    // The teacher's own work is still there, untouched.
    const payload = (await app.inject({ method: "GET", url: url(s) })).json<AssignmentGroupsPayload>();
    expect(payload.groups.map((g) => g.name)).toEqual(["Les Castors"]);
    expect(payload.groups[0]!.members.map((m) => m.nom)).toEqual(["Ammann"]);
    await app.close();
  });

  it("a repository deleted on GitHub stops locking its group", async () => {
    const s = await seed(db);
    const app = await serve(db, s.teacherId);
    const g1 = await addGroup(app, s);
    await addMember(app, s, g1.id, s.students.Ammann!);
    await giveRepo(db, s, g1.id, s.students.Ammann!);
    expect(
      (await app.inject({ method: "PATCH", url: url(s, `/${g1.id}`), payload: { name: "X" } }))
        .statusCode,
    ).toBe(409);

    // Issue #10: the deletion is terminal, nothing is left to revoke.
    await db
      .update(studentRepos)
      .set({ deletedAt: new Date() })
      .where(eq(studentRepos.assignmentId, s.assignmentId));
    const rename = await app.inject({
      method: "PATCH",
      url: url(s, `/${g1.id}`),
      payload: { name: "Les Castors" },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json()).toMatchObject({ name: "Les Castors", repo: null });
    await app.close();
  });

  it("splits the remaining students into groups of N, leaving the existing ones alone", async () => {
    const s = await seed(db);
    const app = await serve(db, s.teacherId);
    const kept = await addGroup(app, s, "Les Castors");
    await addMember(app, s, kept.id, s.students.Ammann!);

    const res = await app.inject({ method: "POST", url: url(s, "/split"), payload: { size: 2 } });
    expect(res.statusCode).toBe(200);
    const payload = res.json<AssignmentGroupsPayload>();
    // Bovet, Curie, Dubois, Euler in roster order; the last group is smaller.
    expect(payload.groups.map((g) => g.name)).toEqual([
      "Les Castors",
      "Group 1",
      "Group 2",
    ]);
    expect(payload.groups[0]!.members.map((m) => m.nom)).toEqual(["Ammann"]);
    expect(payload.groups[1]!.members.map((m) => m.nom)).toEqual(["Bovet", "Curie"]);
    expect(payload.groups[2]!.members.map((m) => m.nom)).toEqual(["Dubois", "Euler"]);
    expect(payload.unassigned).toEqual([]);

    const odd = await app.inject({ method: "POST", url: url(s, "/split"), payload: { size: 1 } });
    expect(odd.statusCode).toBe(400);
    await app.close();
  });

  it("puts everyone else in a group of one named after them", async () => {
    const s = await seed(db, { names: ["Ammann", "Bovet"] });
    const app = await serve(db, s.teacherId);
    const kept = await addGroup(app, s, "Les Castors");
    await addMember(app, s, kept.id, s.students.Ammann!);

    const res = await app.inject({ method: "POST", url: url(s, "/singles") });
    expect(res.statusCode).toBe(200);
    const payload = res.json<AssignmentGroupsPayload>();
    expect(payload.groups.map((g) => g.name)).toEqual(["Les Castors", "Alex Bovet"]);
    expect(payload.groups[1]!.slug).toBe("alex-bovet");
    expect(payload.groups[1]!.members.map((m) => m.nom)).toEqual(["Bovet"]);
    expect(payload.unassigned).toEqual([]);
    await app.close();
  });

  it("de-duplicates the name and the slug of two homonyms", async () => {
    const s = await seed(db, { names: ["Bovet", "Bovet"] });
    const app = await serve(db, s.teacherId);
    const res = await app.inject({ method: "POST", url: url(s, "/singles") });
    const payload = res.json<AssignmentGroupsPayload>();
    expect(payload.groups.map((g) => g.name)).toEqual(["Alex Bovet", "Alex Bovet 2"]);
    expect(payload.groups.map((g) => g.slug)).toEqual(["alex-bovet", "alex-bovet-2"]);
    await app.close();
  });

  it("answers 409 group_mode_off on an individual assignment, reads included", async () => {
    const s = await seed(db, { groupMode: false });
    const app = await serve(db, s.teacherId);
    for (const res of [
      await app.inject({ method: "GET", url: url(s) }),
      await app.inject({ method: "POST", url: url(s), payload: {} }),
      await app.inject({ method: "POST", url: url(s, "/singles") }),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("group_mode_off");
    }
    await app.close();
  });
});

describe("group assignment lifecycle (issue #2, lot 1)", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await testDb();
  });

  const publishUrl = (s: Seed) =>
    `/app/api/classrooms/${s.classroomId}/assignments/${s.assignmentId}/publish`;
  const patchUrl = (s: Seed) =>
    `/app/api/classrooms/${s.classroomId}/assignments/${s.assignmentId}`;

  it("refuses to publish while students have no group, and names them", async () => {
    const s = await seed(db, { names: ["Ammann", "Bovet"] });
    const groups = await serve(db, s.teacherId);
    const lifecycle = await serve(db, s.teacherId, assignmentLifecycleRoutes);

    // No group at all: the refusal is the same door.
    const empty = await lifecycle.inject({ method: "POST", url: publishUrl(s) });
    expect(empty.statusCode).toBe(409);
    expect(empty.json().error).toBe("unassigned_students");

    const g1 = await addGroup(groups, s);
    await addMember(groups, s, g1.id, s.students.Ammann!);
    const res = await lifecycle.inject({ method: "POST", url: publishUrl(s) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: "unassigned_students",
      students: [{ enrollmentId: s.students.Bovet, nom: "Bovet", prenom: "Alex" }],
    });
    // Nothing moved: the draft is exactly as it was (no state change, no email).
    const [row] = await db.select().from(assignments).where(eq(assignments.id, s.assignmentId));
    expect(row!.state).toBe("draft");

    // "Put them in individual groups", then the guard lets go.
    expect((await groups.inject({ method: "POST", url: url(s, "/singles") })).statusCode).toBe(200);
    const after = await db
      .select()
      .from(assignmentGroups)
      .where(eq(assignmentGroups.assignmentId, s.assignmentId));
    expect(after).toHaveLength(2);
    await groups.close();
    await lifecycle.close();
  });

  it("the scheduled auto-publication applies the very same guard", async () => {
    const s = await seed(db, { names: ["Ammann", "Bovet"] });
    const app = await serve(db, s.teacherId);
    // Due to go live: scheduled, start date passed, deadline far ahead.
    await db
      .update(assignments)
      .set({ publishMode: "scheduled" })
      .where(eq(assignments.id, s.assignmentId));

    // No group at all, then one student still outside: the claim skips it,
    // so the ticker writes no audit entry and sends no e-mail either.
    expect(await claimScheduledPublications(db)).toEqual([]);
    const g1 = await addGroup(app, s);
    await addMember(app, s, g1.id, s.students.Ammann!);
    expect(await claimScheduledPublications(db)).toEqual([]);
    const [stillDraft] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, s.assignmentId));
    expect(stillDraft!.state).toBe("draft");

    // Everyone grouped: the same claim publishes it on the next tick.
    await addMember(app, s, g1.id, s.students.Bovet!);
    const live = await claimScheduledPublications(db);
    expect(live.map((a) => a.id)).toEqual([s.assignmentId]);
    await app.close();
  });

  it("an individual assignment is still auto-published, guard or no guard", async () => {
    const s = await seed(db, { groupMode: false });
    await db
      .update(assignments)
      .set({ publishMode: "scheduled" })
      .where(eq(assignments.id, s.assignmentId));
    const live = await claimScheduledPublications(db);
    expect(live.map((a) => a.id)).toEqual([s.assignmentId]);
  });

  it("group mode needs the free work mode and only moves while the assignment is a draft", async () => {
    const s = await seed(db, { groupMode: false });
    const app = await serve(db, s.teacherId, assignmentLifecycleRoutes);

    const online = await app.inject({
      method: "PATCH",
      url: patchUrl(s),
      payload: { groupMode: true, workMode: "online" },
    });
    expect(online.statusCode).toBe(400);
    expect(online.json().error).toBe("group_mode_requires_free");

    expect(
      (await app.inject({ method: "PATCH", url: patchUrl(s), payload: { groupMode: true } }))
        .statusCode,
    ).toBe(200);
    // …and the same refusal the other way round: a group assignment cannot
    // move to an online mode, which is per student by construction.
    const away = await app.inject({
      method: "PATCH",
      url: patchUrl(s),
      payload: { workMode: "online" },
    });
    expect(away.statusCode).toBe(400);
    expect(away.json().error).toBe("group_mode_requires_free");

    // The advisory size stays editable, group mode itself does not.
    await db
      .update(assignments)
      .set({ state: "published" })
      .where(eq(assignments.id, s.assignmentId));
    expect(
      (await app.inject({ method: "PATCH", url: patchUrl(s), payload: { groupMaxSize: 4 } }))
        .statusCode,
    ).toBe(200);
    const frozen = await app.inject({
      method: "PATCH",
      url: patchUrl(s),
      payload: { groupMode: false },
    });
    expect(frozen.statusCode).toBe(409);
    expect(frozen.json().error).toBe("not_draft");
    await app.close();
  });
});
