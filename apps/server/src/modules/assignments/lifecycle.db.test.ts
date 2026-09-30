/**
 * Deleting an assignment (issue #48) over the real routes: PGlite plays the
 * migrations, GitHub is a stub. An assignment nobody accepted goes away in
 * any state and frees its slug; the first acceptance, individual or group,
 * leaves Archive as the only way out.
 */
import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

import type { AppConfig } from "../../config.js";
import {
  assignmentGroupMembers,
  assignmentGroups,
  assignmentMilestones,
  assignments,
  auditLog,
  classrooms,
  enrollments,
  organizations,
  studentRepos,
  users,
} from "../../db/schema.js";
import { subscribe, type AppEvent } from "../../events.js";
import { testDb, type TestDb } from "../../test/db.js";
import { assignmentLifecycleRoutes } from "./lifecycle.js";

const { request, createSquashedRepo } = vi.hoisted(() => ({
  request: vi.fn(),
  createSquashedRepo: vi.fn(),
}));
vi.mock("../../github/app.js", () => ({
  installationClient: async () => ({ octokit: { request }, token: "t" }),
}));
vi.mock("../../github/squash.js", () => ({ createSquashedRepo }));

async function serve(db: TestDb, teacherId: string) {
  const app = Fastify();
  app.decorate("db", db as unknown as FastifyInstance["db"]);
  app.decorate("boss", null);
  app.decorate("requireSession", async () => undefined);
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    req.user = { id: teacherId, role: "teacher" } as never;
  });
  await assignmentLifecycleRoutes(app as unknown as FastifyInstance, {
    config: {} as AppConfig,
  });
  await app.ready();
  return app;
}

async function seed(
  db: TestDb,
  opts: { state?: "draft" | "published" | "locked"; archived?: boolean; groupMode?: boolean } = {},
) {
  const teacherId = randomUUID();
  const orgId = randomUUID();
  const classroomId = randomUUID();
  const assignmentId = randomUUID();
  const orgLogin = `org-${orgId.slice(0, 8)}`;
  await db.insert(users).values({
    id: teacherId,
    oidcSub: `t-${teacherId}`,
    email: `t-${teacherId}@heig.test`,
    role: "teacher",
  });
  await db
    .insert(organizations)
    .values({ id: orgId, login: orgLogin, installationId: Math.floor(Math.random() * 1e9) });
  await db.insert(classrooms).values({ id: classroomId, orgId, teacherId, name: "PRG1" });
  await db.insert(assignments).values({
    id: assignmentId,
    classroomId,
    name: "Labo 1",
    slug: "labo-1",
    state: opts.state ?? "published",
    startAt: new Date("2026-09-01T08:00:00Z"),
    deadlineAt: new Date("2126-09-08T08:00:00Z"),
    sourceRepoId: 1,
    sourceFullName: `${orgLogin}/labo-1`,
    squashedRepoId: 2,
    squashedFullName: `${orgLogin}/labo-1-squashed`,
    branches: ["main"],
    protectedFiles: [],
    groupMode: opts.groupMode ?? false,
    archivedAt: opts.archived ? new Date() : null,
  });
  return { teacherId, orgLogin, classroomId, assignmentId };
}
type Seed = Awaited<ReturnType<typeof seed>>;

const url = (s: Seed) => `/app/api/classrooms/${s.classroomId}/assignments/${s.assignmentId}`;

/** A student with a repository row on the assignment (optionally a group's). */
async function accept(db: TestDb, s: Seed, opts: { groupId?: string; claimed?: boolean } = {}) {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, oidcSub: `s-${userId}`, email: `s-${userId}@heig.test` });
  await db.insert(studentRepos).values({
    id: randomUUID(),
    assignmentId: s.assignmentId,
    userId,
    groupId: opts.groupId ?? null,
    // In flight: claimed, not provisioned yet. Still an acceptance.
    provisionStatus: "pending",
    provisionClaimedAt: opts.claimed ? new Date() : null,
  });
  return userId;
}

const squashedDeletes = () =>
  request.mock.calls.filter(([route]) => route === "DELETE /repos/{owner}/{repo}");

async function assignmentRow(db: TestDb, id: string) {
  const [row] = await db.select().from(assignments).where(eq(assignments.id, id));
  return row;
}

let db: TestDb;
beforeEach(async () => {
  db = await testDb();
  request.mockReset();
  request.mockResolvedValue({ data: {} });
  createSquashedRepo.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("DELETE /app/api/classrooms/:id/assignments/:aid", () => {
  it("deletes a draft with its distributed repository", async () => {
    const s = await seed(db, { state: "draft" });
    const app = await serve(db, s.teacherId);
    const res = await app.inject({ method: "DELETE", url: url(s) });
    expect(res.statusCode).toBe(204);
    expect(await assignmentRow(db, s.assignmentId)).toBeUndefined();
    expect(squashedDeletes()).toHaveLength(1);
    expect(squashedDeletes()[0]![1]).toEqual({ owner: s.orgLogin, repo: "labo-1-squashed" });
    const [event] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "assignment.delete"), eq(auditLog.subjectId, s.assignmentId)));
    expect(event?.payload).toMatchObject({ published: false });
  });

  it("deletes a published assignment nobody accepted, with what hangs off it", async () => {
    const s = await seed(db, { state: "published", groupMode: true });
    const groupId = randomUUID();
    await db
      .insert(assignmentGroups)
      .values({ id: groupId, assignmentId: s.assignmentId, name: "G1", slug: "g1", position: 0 });
    const enrollmentId = randomUUID();
    await db.insert(enrollments).values({
      id: enrollmentId,
      classroomId: s.classroomId,
      nom: "Ammann",
      prenom: "Alex",
      email: "ammann@heig.test",
    });
    await db
      .insert(assignmentGroupMembers)
      .values({ id: randomUUID(), assignmentId: s.assignmentId, groupId, enrollmentId });
    await db.insert(assignmentMilestones).values({
      id: randomUUID(),
      assignmentId: s.assignmentId,
      name: "M1",
      dueAt: new Date("2126-09-01T08:00:00Z"),
    });
    const app = await serve(db, s.teacherId);

    const events: AppEvent[] = [];
    const off = subscribe((e) => events.push(e));
    const res = await app.inject({ method: "DELETE", url: url(s) });
    off();

    expect(res.statusCode).toBe(204);
    expect(await assignmentRow(db, s.assignmentId)).toBeUndefined();
    expect(await db.select().from(assignmentGroups)).toHaveLength(0);
    expect(await db.select().from(assignmentGroupMembers)).toHaveLength(0);
    expect(await db.select().from(assignmentMilestones)).toHaveLength(0);
    expect(squashedDeletes()).toHaveLength(1);
    // Open views (the students' dashboards among them) drop it.
    expect(events).toContainEqual({ type: "assignments", topics: [`classroom:${s.classroomId}`] });
    const [event] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "assignment.delete"), eq(auditLog.subjectId, s.assignmentId)));
    expect(event?.payload).toMatchObject({ published: true, archived: false });
  });

  it("deletes an archived assignment nobody accepted", async () => {
    const s = await seed(db, { state: "locked", archived: true });
    const app = await serve(db, s.teacherId);
    const res = await app.inject({ method: "DELETE", url: url(s) });
    expect(res.statusCode).toBe(204);
    expect(await assignmentRow(db, s.assignmentId)).toBeUndefined();
  });

  it("refuses once a student accepted, and leaves GitHub alone", async () => {
    const s = await seed(db, { state: "published" });
    await accept(db, s, { claimed: true });
    const app = await serve(db, s.teacherId);
    const res = await app.inject({ method: "DELETE", url: url(s) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "already_accepted" });
    expect(await assignmentRow(db, s.assignmentId)).toBeDefined();
    expect(squashedDeletes()).toHaveLength(0);
  });

  it("refuses once a group accepted", async () => {
    const s = await seed(db, { state: "published", groupMode: true });
    const groupId = randomUUID();
    await db
      .insert(assignmentGroups)
      .values({ id: groupId, assignmentId: s.assignmentId, name: "G1", slug: "g1", position: 0 });
    await accept(db, s, { groupId });
    const app = await serve(db, s.teacherId);
    const res = await app.inject({ method: "DELETE", url: url(s) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "already_accepted" });
    expect(await assignmentRow(db, s.assignmentId)).toBeDefined();
    expect(await db.select().from(assignmentGroups)).toHaveLength(1);
  });

  it("frees the slug: the same name is recreated without a suffix", async () => {
    const s = await seed(db, { state: "published" });
    const app = await serve(db, s.teacherId);
    expect((await app.inject({ method: "DELETE", url: url(s) })).statusCode).toBe(204);

    request.mockImplementation(async (route: string) =>
      route === "GET /repos/{owner}/{repo}"
        ? {
            data: {
              id: 1,
              name: "labo-1",
              full_name: `${s.orgLogin}/labo-1`,
              default_branch: "main",
            },
          }
        : { data: {} },
    );
    createSquashedRepo.mockImplementation(async (o: { org: string; targetRepo: string }) => ({
      repoId: 3,
      fullName: `${o.org}/${o.targetRepo}`,
    }));
    const res = await app.inject({
      method: "POST",
      url: `/app/api/classrooms/${s.classroomId}/assignments`,
      payload: { name: "Labo 1", sourceRepo: "labo-1", durationMinutes: 1440 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      slug: "labo-1",
      squashedFullName: `${s.orgLogin}/labo-1-squashed`,
      accepted: false,
    });
  });
});

describe("GET /app/api/classrooms/:id/assignments", () => {
  it("says which assignments someone accepted", async () => {
    const s = await seed(db, { state: "published" });
    const untouched = randomUUID();
    await db.insert(assignments).values({
      id: untouched,
      classroomId: s.classroomId,
      name: "Labo 2",
      slug: "labo-2",
      state: "published",
      startAt: new Date("2026-09-01T08:00:00Z"),
      deadlineAt: new Date("2126-09-08T08:00:00Z"),
      sourceRepoId: 1,
      sourceFullName: `${s.orgLogin}/labo-2`,
      branches: ["main"],
      protectedFiles: [],
    });
    await accept(db, s);
    await accept(db, s);
    const app = await serve(db, s.teacherId);
    const res = await app.inject({
      method: "GET",
      url: `/app/api/classrooms/${s.classroomId}/assignments`,
    });
    expect(res.statusCode).toBe(200);
    const byId = new Map(
      (res.json() as { id: string; accepted: boolean }[]).map((a) => [a.id, a.accepted]),
    );
    expect(byId.get(s.assignmentId)).toBe(true);
    expect(byId.get(untouched)).toBe(false);
  });
});
