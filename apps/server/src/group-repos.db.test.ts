/**
 * Group repositories (issue #2, lot 2) end to end over the real routes:
 * PGlite plays the migrations, GitHub is a recorded fake. Acceptance creates
 * ONE repository per group and invites the whole group; membership changes
 * invite and revoke; the read views give every member the group's line; a
 * lot-1 individual repository keeps working for its student.
 */
import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

import type {
  AssignmentDetailPayload,
  ClassroomGradesPayload,
  StudentClassroom,
} from "@hgc/contracts";

import type { AppConfig } from "./config.js";
import {
  assignmentGroupMembers,
  assignmentGroups,
  assignments,
  auditLog,
  classrooms,
  enrollments,
  organizations,
  studentRepos,
  users,
} from "./db/schema.js";
import {
  inviteMembers,
  inviteOnGithubLink,
  markProvisionFailed,
  repoUserIds,
} from "./group-repos.js";
import { assignmentDetailRoutes } from "./modules/assignments/detail.js";
import { assignmentGroupRoutes } from "./modules/assignments/groups.js";
import { classroomsPlugin } from "./modules/classrooms.js";
import { classroomGrades } from "./modules/grades.js";
import { studentPlugin } from "./modules/student.js";
import { testDb, type TestDb } from "./test/db.js";

// --- GitHub, recorded -------------------------------------------------------

type Call = { route: string; params: Record<string, unknown> };
const { calls, request, provision, failing, existing } = vi.hoisted(() => {
  const calls: { route: string; params: Record<string, unknown> }[] = [];
  /** Routes that answer 500 in the current test. */
  const failing = new Set<string>();
  const request = async (route: string, params: Record<string, unknown> = {}) => {
    calls.push({ route, params });
    if (failing.has(route)) throw Object.assign(new Error("GitHub is down"), { status: 500 });
    if (route === "PUT /repos/{owner}/{repo}/collaborators/{username}") return { status: 201 };
    if (route === "DELETE /repos/{owner}/{repo}/collaborators/{username}") return { status: 204 };
    if (route === "GET /repos/{owner}/{repo}/invitations") {
      return { data: [{ id: 77, invitee: { login: String(params.repo).includes("group") ? "bovet" : "x" } }] };
    }
    if (route === "DELETE /repos/{owner}/{repo}/invitations/{invitation_id}") return { status: 204 };
    // Live metrics of the read views: unreachable, the views fall back.
    throw Object.assign(new Error(`unexpected ${route}`), { status: 404 });
  };
  /** Repositories that already exist on GitHub (name → id): the 422 path. */
  const existing = new Map<string, number>();
  /**
   * Replay-safe like the real one: the same name always yields the same
   * repository. An existing name is adopted only past `canAdopt`, and the
   * acceptor's invitation (`provision-invite`) comes after that guard.
   */
  const provision = async (opts: {
    org: string;
    targetRepo: string;
    studentLogin: string;
    canAdopt?: (id: number) => Promise<boolean>;
  }) => {
    const { canAdopt: _guard, ...params } = opts;
    calls.push({ route: "provision", params });
    await new Promise((r) => setTimeout(r, 5));
    let id = 0;
    for (const c of opts.targetRepo) id = (id * 31 + c.charCodeAt(0)) % 1_000_000_007;
    const adopted = existing.get(opts.targetRepo);
    if (adopted !== undefined) {
      id = adopted;
      if (opts.canAdopt && !(await opts.canAdopt(id))) {
        throw new Error(`${opts.targetRepo} belongs to another tracked repository`);
      }
    }
    calls.push({
      route: "provision-invite",
      params: { repo: opts.targetRepo, username: opts.studentLogin },
    });
    return {
      repoId: id,
      fullName: `${opts.org}/${opts.targetRepo}`,
      defaultBranch: "main",
      rulesetId: 1,
      invitationStatus: "pending" as const,
    };
  };
  return { calls, request, provision, failing, existing };
});
vi.mock("./github/app.js", () => ({
  installationClient: async () => ({ octokit: { request }, token: "t" }),
}));
vi.mock("./github/provision.js", () => ({ provisionStudentRepo: provision }));

const of = (route: string): Call[] => calls.filter((c) => c.route === route);
const invitedLogins = () =>
  of("PUT /repos/{owner}/{repo}/collaborators/{username}").map((c) => c.params.username);

// --- Fixture ----------------------------------------------------------------

/**
 * One classroom of a published group assignment: Ammann and Bovet in
 * "Group 1", Curie and Dubois in "Group 2" (Dubois never linked GitHub),
 * Euler in no group. Every student has an account except Euler's is linked
 * too, so the only reason not to invite someone is Dubois's missing login.
 */
async function seed(db: TestDb) {
  const teacherId = randomUUID();
  const orgId = randomUUID();
  const classroomId = randomUUID();
  const assignmentId = randomUUID();
  await db.insert(users).values({
    id: teacherId,
    oidcSub: `t-${teacherId}`,
    email: "t@heig.test",
    role: "teacher",
  });
  await db.insert(organizations).values({ id: orgId, login: "heig-org", installationId: 99 });
  await db.insert(classrooms).values({ id: classroomId, orgId, teacherId, name: "PRG1" });
  await db.insert(assignments).values({
    id: assignmentId,
    classroomId,
    name: "Labo 1",
    slug: "labo-1",
    state: "published",
    startAt: new Date("2026-09-01T08:00:00Z"),
    deadlineAt: new Date("2126-09-08T08:00:00Z"),
    sourceRepoId: 1,
    sourceFullName: "heig-org/labo-1",
    squashedFullName: "heig-org/labo-1-squashed",
    branches: ["main"],
    protectedFiles: [],
    groupMode: true,
  });
  const student: Record<string, { enrollmentId: string; userId: string }> = {};
  for (const nom of ["Ammann", "Bovet", "Curie", "Dubois", "Euler"]) {
    const userId = randomUUID();
    const enrollmentId = randomUUID();
    await db.insert(users).values({
      id: userId,
      oidcSub: `s-${userId}`,
      email: `${nom.toLowerCase()}@heig.test`,
      givenName: "Alex",
      familyName: nom,
      githubLogin: nom === "Dubois" ? null : nom.toLowerCase(),
    });
    await db.insert(enrollments).values({
      id: enrollmentId,
      classroomId,
      nom,
      prenom: "Alex",
      email: `${nom.toLowerCase()}@heig.test`,
      status: "claimed",
      userId,
    });
    student[nom] = { enrollmentId, userId };
  }
  const group: Record<string, string> = {};
  for (const [position, [name, members]] of (
    [
      ["Group 1", ["Ammann", "Bovet"]],
      ["Group 2", ["Curie", "Dubois"]],
    ] as const
  ).entries()) {
    const id = randomUUID();
    await db.insert(assignmentGroups).values({
      id,
      assignmentId,
      name,
      slug: name.toLowerCase().replace(" ", "-"),
      position,
    });
    for (const nom of members) {
      await db.insert(assignmentGroupMembers).values({
        id: randomUUID(),
        assignmentId,
        groupId: id,
        enrollmentId: student[nom]!.enrollmentId,
      });
    }
    group[name] = id;
  }
  return { teacherId, orgId, classroomId, assignmentId, student, group };
}
type Seed = Awaited<ReturnType<typeof seed>>;

/** The student, group and roster routes; `x-as` picks the signed-in user. */
async function serve(db: TestDb) {
  const app = Fastify();
  app.decorate("db", db as unknown as FastifyInstance["db"]);
  app.decorate("boss", null);
  app.decorate("requireSession", async () => undefined);
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    const [u] = await db
      .select()
      .from(users)
      .where(eq(users.id, String(req.headers["x-as"])))
      .limit(1);
    req.user = u as never;
  });
  const config = { PUBLIC_URL: "http://localhost" } as AppConfig;
  await studentPlugin(app as unknown as FastifyInstance, { config });
  await assignmentGroupRoutes(app as unknown as FastifyInstance, { config });
  await assignmentDetailRoutes(app as unknown as FastifyInstance, { config });
  await classroomsPlugin(app as unknown as FastifyInstance, { config });
  await app.ready();
  return app;
}

const accept = (app: FastifyInstance, s: Seed, nom: string) =>
  app.inject({
    method: "POST",
    url: `/app/api/student/assignments/${s.assignmentId}/accept`,
    headers: { "x-as": s.student[nom]!.userId },
  });

const groupsUrl = (s: Seed, suffix = "") =>
  `/app/api/classrooms/${s.classroomId}/assignments/${s.assignmentId}/groups${suffix}`;

async function groupRepos(db: TestDb, s: Seed) {
  return db.select().from(studentRepos).where(eq(studentRepos.assignmentId, s.assignmentId));
}

async function memberOf(db: TestDb, s: Seed, nom: string) {
  const [m] = await db
    .select()
    .from(assignmentGroupMembers)
    .where(
      and(
        eq(assignmentGroupMembers.assignmentId, s.assignmentId),
        eq(assignmentGroupMembers.enrollmentId, s.student[nom]!.enrollmentId),
      ),
    );
  return m?.groupId ?? null;
}

describe("group repositories (issue #2, lot 2)", () => {
  let db: TestDb;
  let s: Seed;
  let app: FastifyInstance;
  beforeEach(async () => {
    calls.length = 0;
    failing.clear();
    existing.clear();
    db = await testDb();
    s = await seed(db);
    app = await serve(db);
  });

  it("the first acceptance creates the group's repository and invites the whole group", async () => {
    const res = await accept(app, s, "Curie");
    expect(res.statusCode).toBe(200);

    const repos = await groupRepos(db, s);
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      groupId: s.group["Group 2"],
      userId: s.student.Curie!.userId,
      fullName: "heig-org/labo-1-group-2",
      provisionStatus: "ok",
    });
    // Provisioned once, under the group's name, inviting the acceptor…
    expect(of("provision")).toHaveLength(1);
    expect(of("provision")[0]!.params).toMatchObject({
      targetRepo: "labo-1-group-2",
      studentLogin: "curie",
    });
    // …and nobody else to invite: Dubois has no GitHub login yet.
    expect(invitedLogins()).toEqual([]);

    // Group 1: Bovet is invited right away when Ammann accepts.
    calls.length = 0;
    expect((await accept(app, s, "Ammann")).statusCode).toBe(200);
    expect(of("provision")[0]!.params).toMatchObject({ targetRepo: "labo-1-group-1" });
    expect(invitedLogins()).toEqual(["bovet"]);
    const invites = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "group.repo.invite"));
    expect(invites.map((a) => (a.payload as { login: string }).login)).toEqual(["bovet"]);
    await app.close();
  });

  it("a later acceptance attaches the member to the existing repository", async () => {
    const first = (await accept(app, s, "Ammann")).json<{ id: string }>();
    calls.length = 0;
    const second = await accept(app, s, "Bovet");
    expect(second.statusCode).toBe(200);
    expect(second.json<{ id: string }>().id).toBe(first.id);
    expect(of("provision")).toHaveLength(0);
    expect(invitedLogins()).toEqual(["bovet"]);
    expect(await groupRepos(db, s)).toHaveLength(1);
    await app.close();
  });

  it("two members accepting at the same second create ONE repository", async () => {
    const [a, b] = await Promise.all([accept(app, s, "Ammann"), accept(app, s, "Bovet")]);
    // One provisions; the other either attaches once it is done (200) or is
    // told to come back in a moment (409) — never a second provisioning.
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes[0]).toBe(200);
    expect([200, 409]).toContain(codes[1]);
    const repos = await groupRepos(db, s);
    expect(repos).toHaveLength(1);
    expect(repos[0]!.provisionStatus).toBe("ok");
    expect(of("provision")).toHaveLength(1);
    await app.close();
  });

  it("a student in no group cannot accept a group assignment", async () => {
    const res = await accept(app, s, "Euler");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_group");
    expect(await groupRepos(db, s)).toHaveLength(0);
    await app.close();
  });

  it("disambiguates a name another classroom's in-flight provisioning reserves", async () => {
    // Another classroom of the same organization, same assignment slug.
    const otherAssignment = randomUUID();
    await db.insert(assignments).values({
      id: otherAssignment,
      classroomId: s.classroomId,
      name: "Labo 1 (other)",
      slug: "labo-1-bis",
      startAt: new Date("2026-09-01T08:00:00Z"),
      deadlineAt: new Date("2126-09-08T08:00:00Z"),
      sourceRepoId: 2,
      sourceFullName: "heig-org/labo-1",
      branches: ["main"],
      protectedFiles: [],
    });
    await db.insert(studentRepos).values({
      id: randomUUID(),
      assignmentId: otherAssignment,
      userId: s.teacherId,
      // Still being provisioned: the name is only reserved on the row.
      fullName: "heig-org/labo-1-group-1",
      provisionStatus: "pending",
      provisionClaimedAt: new Date(),
    });
    await accept(app, s, "Ammann");
    const target = String(of("provision")[0]!.params.targetRepo);
    expect(target).toBe(`labo-1-group-1-${s.group["Group 1"]!.slice(0, 8)}`);
    await app.close();
  });

  it("adding a member to a group with a repository invites them, removing one revokes", async () => {
    await accept(app, s, "Ammann");
    const teacher = { "x-as": s.teacherId };
    calls.length = 0;

    // Euler joins Group 1: invited on its repository.
    const add = await app.inject({
      method: "POST",
      url: groupsUrl(s, `/${s.group["Group 1"]}/members`),
      headers: teacher,
      payload: { enrollmentId: s.student.Euler!.enrollmentId },
    });
    expect(add.statusCode).toBe(200);
    expect(invitedLogins()).toEqual(["euler"]);

    // Bovet is removed: collaborator seat and pending invitation both go.
    calls.length = 0;
    const removal = await app.inject({
      method: "DELETE",
      url: groupsUrl(s, `/${s.group["Group 1"]}/members/${s.student.Bovet!.enrollmentId}`),
      headers: teacher,
    });
    expect(removal.statusCode).toBe(200);
    expect(of("DELETE /repos/{owner}/{repo}/collaborators/{username}")[0]!.params).toMatchObject({
      repo: "labo-1-group-1",
      username: "bovet",
    });
    expect(of("DELETE /repos/{owner}/{repo}/invitations/{invitation_id}")).toHaveLength(1);
    expect(await memberOf(db, s, "Bovet")).toBeNull();
    const revokes = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "group.repo.revoke"));
    expect(revokes).toHaveLength(1);
    await app.close();
  });

  it("moving a member out of a locked group revokes, then invites into the new one", async () => {
    await accept(app, s, "Ammann");
    await accept(app, s, "Curie");
    calls.length = 0;
    const move = await app.inject({
      method: "POST",
      url: groupsUrl(s, `/${s.group["Group 2"]}/members`),
      headers: { "x-as": s.teacherId },
      payload: { enrollmentId: s.student.Bovet!.enrollmentId },
    });
    expect(move.statusCode).toBe(200);
    expect(of("DELETE /repos/{owner}/{repo}/collaborators/{username}")[0]!.params.repo).toBe(
      "labo-1-group-1",
    );
    expect(of("PUT /repos/{owner}/{repo}/collaborators/{username}")[0]!.params).toMatchObject({
      repo: "labo-1-group-2",
      username: "bovet",
    });
    expect(await memberOf(db, s, "Bovet")).toBe(s.group["Group 2"]);
    await app.close();
  });

  it("a revocation GitHub refuses leaves the membership untouched", async () => {
    await accept(app, s, "Ammann");
    failing.add("DELETE /repos/{owner}/{repo}/collaborators/{username}");
    const removal = await app.inject({
      method: "DELETE",
      url: groupsUrl(s, `/${s.group["Group 1"]}/members/${s.student.Bovet!.enrollmentId}`),
      headers: { "x-as": s.teacherId },
    });
    expect(removal.statusCode).toBe(502);
    expect(removal.json().error).toBe("revoke_failed");
    expect(await memberOf(db, s, "Bovet")).toBe(s.group["Group 1"]);
    await app.close();
  });

  it("rename and deletion of a group with a repository stay refused", async () => {
    await accept(app, s, "Ammann");
    const teacher = { "x-as": s.teacherId };
    const rename = await app.inject({
      method: "PATCH",
      url: groupsUrl(s, `/${s.group["Group 1"]}`),
      headers: teacher,
      payload: { name: "Renamed" },
    });
    expect(rename.statusCode).toBe(409);
    const del = await app.inject({
      method: "DELETE",
      url: groupsUrl(s, `/${s.group["Group 1"]}`),
      headers: teacher,
    });
    expect(del.statusCode).toBe(409);
    await app.close();
  });

  it("removing a student from the roster revokes their group access first", async () => {
    await accept(app, s, "Ammann");
    const url = `/app/api/classrooms/${s.classroomId}/roster/${s.student.Bovet!.enrollmentId}`;
    const teacher = { "x-as": s.teacherId };

    failing.add("DELETE /repos/{owner}/{repo}/collaborators/{username}");
    const refused = await app.inject({ method: "DELETE", url, headers: teacher });
    expect(refused.statusCode).toBe(502);
    expect(refused.json().error).toBe("revoke_failed");
    expect(await memberOf(db, s, "Bovet")).toBe(s.group["Group 1"]);

    failing.clear();
    calls.length = 0;
    const removed = await app.inject({ method: "DELETE", url, headers: teacher });
    expect(removed.statusCode).toBe(204);
    expect(of("DELETE /repos/{owner}/{repo}/collaborators/{username}")[0]!.params.username).toBe(
      "bovet",
    );
    const gone = await db
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, s.student.Bovet!.enrollmentId));
    expect(gone).toHaveLength(0);
    await app.close();
  });

  it("grades stay one line per student, every member reading the group's grade", async () => {
    await accept(app, s, "Ammann");
    await db
      .update(studentRepos)
      .set({ teacherPoints: 5 })
      .where(eq(studentRepos.groupId, s.group["Group 1"]!));

    const sheet: ClassroomGradesPayload = await classroomGrades(app, {
      id: s.classroomId,
      name: "PRG1",
    });
    const points = Object.fromEntries(
      sheet.students.map((st) => [st.nom, st.points[s.assignmentId] ?? null]),
    );
    expect(points).toEqual({ Ammann: 5, Bovet: 5, Curie: null, Dubois: null, Euler: null });

    // The detail table: one line per student, the group's repo on both.
    const detail = (
      await app.inject({
        method: "GET",
        url: `/app/api/classrooms/${s.classroomId}/assignments/${s.assignmentId}/detail`,
        headers: { "x-as": s.teacherId },
      })
    ).json<AssignmentDetailPayload>();
    const line = (nom: string) => detail.students.find((st) => st.nom === nom)!;
    expect(line("Ammann").group).toEqual({ id: s.group["Group 1"], name: "Group 1" });
    expect(line("Bovet").repo?.id).toBe(line("Ammann").repo?.id);
    expect(line("Bovet").repo?.teacherPoints).toBe(5);
    expect(line("Euler").group).toBeNull();

    // The student home: Bovet sees the group's repository and his teammate.
    const home = (
      await app.inject({
        method: "GET",
        url: "/app/api/student/classrooms",
        headers: { "x-as": s.student.Bovet!.userId },
      })
    ).json<StudentClassroom[]>();
    const mine = home[0]!.assignments[0]!;
    expect(mine.repo?.fullName).toBe("heig-org/labo-1-group-1");
    expect(mine.group).toEqual({ name: "Group 1", teammates: ["Alex Ammann"] });
    await app.close();
  });

  it("a lot-1 individual repository on a group assignment keeps working for its student", async () => {
    // Lot 1 left Ammann with an individual repository on this assignment.
    const legacyId = randomUUID();
    await db.insert(studentRepos).values({
      id: legacyId,
      assignmentId: s.assignmentId,
      userId: s.student.Ammann!.userId,
      fullName: "heig-org/labo-1-ammann",
      provisionStatus: "ok",
      teacherPoints: 4,
    });

    // Accepting again returns it untouched.
    const again = await accept(app, s, "Ammann");
    expect(again.json<{ id: string }>().id).toBe(legacyId);
    expect(of("provision")).toHaveLength(0);

    // Bovet's acceptance creates the group repository without dragging
    // Ammann into it (he keeps his own), and without stealing his authorship.
    expect((await accept(app, s, "Bovet")).statusCode).toBe(200);
    const group = (await groupRepos(db, s)).find((r) => r.groupId === s.group["Group 1"])!;
    expect(group.userId).toBe(s.student.Bovet!.userId);
    expect(invitedLogins()).toEqual([]);

    const sheet = await classroomGrades(app, { id: s.classroomId, name: "PRG1" });
    const ammann = sheet.students.find((st) => st.nom === "Ammann")!;
    expect(ammann.points[s.assignmentId]).toBe(4);
    await app.close();
  });

  it("linking GitHub invites the student on their group's existing repository", async () => {
    await accept(app, s, "Curie");
    await db
      .update(users)
      .set({ githubLogin: "dubois" })
      .where(eq(users.id, s.student.Dubois!.userId));
    calls.length = 0;
    const invited = await inviteOnGithubLink(
      app,
      {} as AppConfig,
      s.student.Dubois!.userId,
      "dubois",
    );
    expect(invited).toEqual(["heig-org/labo-1-group-2"]);
    expect(invitedLogins()).toEqual(["dubois"]);
    await app.close();
  });
});

/** A lot-1 individual row of `nom` on the assignment, in the given state. */
async function legacyRow(
  db: TestDb,
  s: Seed,
  nom: string,
  state: Partial<typeof studentRepos.$inferInsert> = {},
) {
  const id = randomUUID();
  await db.insert(studentRepos).values({
    id,
    assignmentId: s.assignmentId,
    userId: s.student[nom]!.userId,
    fullName: `heig-org/labo-1-${nom.toLowerCase()}`,
    provisionStatus: "ok",
    ...state,
  });
  return id;
}

describe("group repositories — review fixes", () => {
  let db: TestDb;
  let s: Seed;
  let app: FastifyInstance;
  beforeEach(async () => {
    calls.length = 0;
    failing.clear();
    existing.clear();
    db = await testDb();
    s = await seed(db);
    app = await serve(db);
  });

  it("a failed lot-1 row does not hold its student out of the group repository", async () => {
    await legacyRow(db, s, "Ammann", { provisionStatus: "error", fullName: null });
    await accept(app, s, "Bovet");
    // Invited like any member…
    expect(invitedLogins()).toEqual(["ammann"]);
    // …and every view reads the group's repository for him, not the failure.
    const detail = (
      await app.inject({
        method: "GET",
        url: `/app/api/classrooms/${s.classroomId}/assignments/${s.assignmentId}/detail`,
        headers: { "x-as": s.teacherId },
      })
    ).json<AssignmentDetailPayload>();
    const line = (nom: string) => detail.students.find((st) => st.nom === nom)!;
    expect(line("Ammann").repo?.id).toBe(line("Bovet").repo?.id);
    expect(line("Ammann").repo?.provisionStatus).toBe("ok");
    // His own acceptance attaches him instead of retrying the dead row.
    calls.length = 0;
    expect((await accept(app, s, "Ammann")).json<{ groupId: string }>().groupId).toBe(
      s.group["Group 1"],
    );
    expect(of("provision")).toHaveLength(0);
    await app.close();
  });

  it("a solo group whose student has a failed lot-1 row can accept", async () => {
    // "Everyone else alone": Euler in a group of one, with a failed lot-1 row.
    const solo = randomUUID();
    await db.insert(assignmentGroups).values({
      id: solo,
      assignmentId: s.assignmentId,
      name: "Alex Euler",
      slug: "alex-euler",
      position: 2,
    });
    await db.insert(assignmentGroupMembers).values({
      id: randomUUID(),
      assignmentId: s.assignmentId,
      groupId: solo,
      enrollmentId: s.student.Euler!.enrollmentId,
    });
    await legacyRow(db, s, "Euler", { provisionStatus: "error", fullName: null });
    const res = await accept(app, s, "Euler");
    expect(res.statusCode).toBe(200);
    const row = (await groupRepos(db, s)).find((r) => r.groupId === solo)!;
    // Authored by Euler although he already holds a row on this assignment.
    expect(row).toMatchObject({ userId: s.student.Euler!.userId, provisionStatus: "ok" });
    await app.close();
  });

  it("a provisioning in flight answers 409 instead of provisioning twice", async () => {
    // Ammann's acceptance claimed the row a moment ago and is still running.
    await db.insert(studentRepos).values({
      id: randomUUID(),
      assignmentId: s.assignmentId,
      userId: s.student.Ammann!.userId,
      groupId: s.group["Group 1"],
      fullName: "heig-org/labo-1-group-1",
      provisionStatus: "pending",
      provisionClaimedAt: new Date(),
    });
    const res = await accept(app, s, "Bovet");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("provision_in_progress");
    expect(of("provision")).toHaveLength(0);

    // A claim nobody finished (the process died) is taken over after a while.
    await db
      .update(studentRepos)
      .set({ provisionClaimedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(studentRepos.groupId, s.group["Group 1"]!));
    expect((await accept(app, s, "Bovet")).statusCode).toBe(200);
    expect(of("provision")).toHaveLength(1);
    await app.close();
  });

  it("a late provisioning failure never turns a working repository into an error", async () => {
    await accept(app, s, "Ammann");
    const [row] = await groupRepos(db, s);
    // The loser of a race (or a replay) fails after the winner succeeded.
    await markProvisionFailed(db, row!.id, "422 ruleset hgc-protect already exists");
    const [after] = await groupRepos(db, s);
    expect(after).toMatchObject({ provisionStatus: "ok", provisionError: null });
    await app.close();
  });

  it("never adopts a repository another row already records, and invites no one on it", async () => {
    // `labo-1-group-1` exists on GitHub and is tracked by another classroom's
    // row (renamed since, so the name check alone would not see it).
    const otherAssignment = randomUUID();
    await db.insert(assignments).values({
      id: otherAssignment,
      classroomId: s.classroomId,
      name: "Other",
      slug: "other",
      startAt: new Date("2026-09-01T08:00:00Z"),
      deadlineAt: new Date("2126-09-08T08:00:00Z"),
      sourceRepoId: 3,
      sourceFullName: "heig-org/other",
      branches: ["main"],
      protectedFiles: [],
    });
    await db.insert(studentRepos).values({
      id: randomUUID(),
      assignmentId: otherAssignment,
      userId: s.teacherId,
      githubRepoId: 4242,
      fullName: "heig-org/renamed-since",
      provisionStatus: "ok",
    });
    existing.set("labo-1-group-1", 4242);

    const res = await accept(app, s, "Ammann");
    expect(res.statusCode).toBe(502);
    expect(of("provision-invite")).toHaveLength(0);
    expect(invitedLogins()).toEqual([]);
    const [row] = (await groupRepos(db, s)).filter((r) => r.groupId !== null);
    expect(row).toMatchObject({ provisionStatus: "error", githubRepoId: null });
    await app.close();
  });

  it("group-repository e-mails and hints skip a lot-1 individual holder", async () => {
    await legacyRow(db, s, "Ammann");
    await accept(app, s, "Bovet");
    const group = (await groupRepos(db, s)).find((r) => r.groupId === s.group["Group 1"])!;
    expect(await repoUserIds(db, [group])).toEqual([s.student.Bovet!.userId]);
    await app.close();
  });

  it("does not invite a member removed while the repository was being created", async () => {
    await accept(app, s, "Ammann");
    const repo = (await groupRepos(db, s)).find((r) => r.groupId === s.group["Group 1"])!;
    // The invitation list was read before Bovet left the group.
    await db
      .delete(assignmentGroupMembers)
      .where(eq(assignmentGroupMembers.enrollmentId, s.student.Bovet!.enrollmentId));
    calls.length = 0;
    const { invited } = await inviteMembers(
      db,
      { request } as never,
      repo,
      [{ enrollmentId: s.student.Bovet!.enrollmentId, githubLogin: "bovet" }],
      { actorUserId: null, reason: "test" },
    );
    expect(invited).toEqual([]);
    expect(invitedLogins()).toEqual([]);
    await app.close();
  });
});
