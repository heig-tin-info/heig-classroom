/**
 * Online workspace (ADR-013), end to end on PGlite + the real migrations:
 * additive migration, admin grant, refusal without a grant, provisioning
 * permission per mode, launch route and portal synchronization job.
 */
import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { CodespaceAssignmentSync, LaunchTokenClaims, ServiceTokenClaims } from "@hgc/contracts";
import { verifyHs256 } from "@hgc/domain";

import { makeCodespaceSyncHandler, sebFileUrl } from "./codespace.js";
import { loadConfig, type AppConfig } from "./config.js";
import {
  assignments,
  classrooms,
  enrollments,
  organizations,
  studentRepos,
  teacherGrants,
  userEmails,
  users,
} from "./db/schema.js";
import { provisionStudentRepo } from "./github/provision.js";
import { adminPlugin } from "./modules/admin.js";
import { assignmentLifecycleRoutes } from "./modules/assignments/lifecycle.js";
import { codespacePlugin } from "./modules/codespace.js";
import { testDb, type TestDb } from "./test/db.js";

const SECRET = "0123456789abcdef0123456789abcdef";

const withPortal = loadConfig({
  NODE_ENV: "test",
  CODESPACE_URL: "http://localhost:3100",
  CODESPACE_LAUNCH_SECRET: SECRET,
  SUPER_ADMIN_EMAIL: "boss@heig.test",
});
const withoutPortal = loadConfig({ NODE_ENV: "test", SUPER_ADMIN_EMAIL: "boss@heig.test" });

type SessionUser = typeof users.$inferSelect;

/**
 * Minimal portal: the real plugins, the PGlite database, and a session hook
 * whose current user the test sets. The auth plugin itself (cookies, CSRF,
 * OIDC) is not under test here.
 */
async function harness(db: TestDb, config: AppConfig) {
  const app = Fastify({ logger: false });
  const state: { user: SessionUser | null } = { user: null };
  app.decorate("db", db as unknown as FastifyInstance["db"]);
  app.decorateRequest("user", null);
  app.decorate("requireSession", async (req: { user: SessionUser | null }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    return undefined;
  });
  app.addHook("preHandler", async (req) => {
    req.user = state.user;
  });
  await app.register(adminPlugin, { config });
  await app.register(assignmentLifecycleRoutes, { config });
  await app.register(codespacePlugin, { config });
  await app.ready();
  return { app, as: (u: SessionUser | null) => (state.user = u) };
}

async function seedUser(
  db: TestDb,
  email: string,
  role: "student" | "teacher" | "admin" = "teacher",
): Promise<SessionUser> {
  const id = randomUUID();
  const [row] = await db
    .insert(users)
    .values({ id, oidcSub: `u-${id}`, email, emailVerified: true, role, githubLogin: `gh-${id.slice(0, 6)}` })
    .returning();
  await db.insert(userEmails).values({ userId: id, email, source: "login", verified: true });
  return row!;
}

async function seedClassroom(db: TestDb, teacherId: string) {
  const orgId = randomUUID();
  const classroomId = randomUUID();
  await db.insert(organizations).values({ id: orgId, login: `org-${orgId.slice(0, 8)}`, installationId: null });
  await db.insert(classrooms).values({ id: classroomId, orgId, teacherId, name: "PRG1" });
  return classroomId;
}

async function seedAssignment(
  db: TestDb,
  classroomId: string,
  overrides: Partial<typeof assignments.$inferInsert> = {},
) {
  const id = randomUUID();
  const [row] = await db
    .insert(assignments)
    .values({
      id,
      classroomId,
      name: "Lab 1",
      slug: `lab-${id.slice(0, 8)}`,
      startAt: new Date("2026-09-01T08:00:00Z"),
      deadlineAt: new Date("2126-09-30T22:00:00Z"),
      sourceRepoId: 1,
      sourceFullName: "org/lab-1",
      squashedRepoId: 2,
      squashedFullName: "org/lab-1-squashed",
      branches: ["main"],
      protectedFiles: [],
      ...overrides,
    })
    .returning();
  return row!;
}

let db: TestDb;
beforeAll(async () => {
  db = await testDb();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("migration 0026 (additive)", () => {
  it("gives every existing row a `free` work mode and a disabled grant", async () => {
    const teacher = await seedUser(db, `t-${randomUUID()}@heig.test`);
    const classroomId = await seedClassroom(db, teacher.id);
    const a = await seedAssignment(db, classroomId);
    expect(a.workMode).toBe("free");
    expect(a.browserExamKeys).toEqual([]);
    expect(a.codespaceImage).toBeNull();
    expect(a.codespaceSyncedAt).toBeNull();
    expect(a.codespaceSyncError).toBeNull();

    const [grant] = await db
      .insert(teacherGrants)
      .values({ id: randomUUID(), email: `g-${randomUUID()}@heig.test`, createdBy: teacher.id })
      .returning();
    expect(grant!.codespaceEnabled).toBe(false);
    expect(grant!.codespaceMaxActiveSessions).toBe(2);
  });

  it("is replayable: re-running its statements changes nothing", async () => {
    const teacher = await seedUser(db, `t-${randomUUID()}@heig.test`);
    const classroomId = await seedClassroom(db, teacher.id);
    const a = await seedAssignment(db, classroomId, { workMode: "online" });
    // The exact statements of drizzle/0026_codespace-work-mode.sql.
    for (const stmt of [
      sql`ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "work_mode" text DEFAULT 'free' NOT NULL`,
      sql`ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "codespace_image" text`,
      sql`ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "browser_exam_keys" text[] DEFAULT '{}'::text[] NOT NULL`,
      sql`ALTER TABLE "teacher_grants" ADD COLUMN IF NOT EXISTS "codespace_enabled" boolean DEFAULT false NOT NULL`,
    ]) {
      await db.execute(stmt);
    }
    const [again] = await db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(again!.workMode).toBe("online");
  });
});

describe("admin grant", () => {
  it("hides the settings entirely when no portal is configured", async () => {
    const admin = await seedUser(db, `a-${randomUUID()}@heig.test`, "admin");
    await db
      .insert(teacherGrants)
      .values({ id: randomUUID(), email: `g-${randomUUID()}@heig.test`, createdBy: admin.id });
    const { app, as } = await harness(db, withoutPortal);
    as(admin);

    const list = await app.inject({ method: "GET", url: "/app/api/admin/teachers" });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ codespace: unknown }[]>().every((r) => r.codespace === null)).toBe(true);

    const patch = await app.inject({
      method: "PATCH",
      url: `/app/api/admin/teachers/${randomUUID()}`,
      payload: { codespace: { enabled: true } },
    });
    expect(patch.statusCode).toBe(404);
    await app.close();
  });

  it("switches the feature on and sets the quota", async () => {
    const admin = await seedUser(db, `a-${randomUUID()}@heig.test`, "admin");
    const email = `g-${randomUUID()}@heig.test`;
    const [grant] = await db
      .insert(teacherGrants)
      .values({ id: randomUUID(), email, createdBy: admin.id })
      .returning();
    const { app, as } = await harness(db, withPortal);
    as(admin);

    const patch = await app.inject({
      method: "PATCH",
      url: `/app/api/admin/teachers/${grant!.id}`,
      payload: { codespace: { enabled: true, maxActiveSessions: 5 } },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({
      codespace: { enabled: true, maxActiveSessions: 5 },
    });

    const list = await app.inject({ method: "GET", url: "/app/api/admin/teachers" });
    const row = list.json<{ id: string; codespace: { enabled: boolean } }[]>().find((r) => r.id === grant!.id);
    expect(row!.codespace).toEqual({ enabled: true, maxActiveSessions: 5 });
    await app.close();
  });
});

describe("choosing an online mode", () => {
  it("is refused with 403 when the teacher has no grant", async () => {
    const email = `t-${randomUUID()}@heig.test`;
    const teacher = await seedUser(db, email);
    const classroomId = await seedClassroom(db, teacher.id);
    const a = await seedAssignment(db, classroomId);
    const { app, as } = await harness(db, withPortal);
    as(teacher);

    const res = await app.inject({
      method: "PATCH",
      url: `/app/api/classrooms/${classroomId}/assignments/${a.id}`,
      payload: { workMode: "online" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "codespace_forbidden" });
    const [unchanged] = await db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(unchanged!.workMode).toBe("free");
    await app.close();
  });

  it("is accepted with a grant, and normalizes the exam keys", async () => {
    const email = `t-${randomUUID()}@heig.test`;
    const teacher = await seedUser(db, email);
    await db.insert(teacherGrants).values({
      id: randomUUID(),
      email,
      createdBy: teacher.id,
      codespaceEnabled: true,
      codespaceMaxActiveSessions: 4,
    });
    const classroomId = await seedClassroom(db, teacher.id);
    const a = await seedAssignment(db, classroomId);
    const { app, as } = await harness(db, withPortal);
    as(teacher);

    const key = "A".repeat(64);
    const res = await app.inject({
      method: "PATCH",
      url: `/app/api/classrooms/${classroomId}/assignments/${a.id}`,
      payload: { workMode: "online_seb", codespaceImage: "  ", browserExamKeys: [key] },
    });
    expect(res.statusCode).toBe(200);
    const [updated] = await db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(updated!.workMode).toBe("online_seb");
    // "" means "the portal's default image".
    expect(updated!.codespaceImage).toBeNull();
    expect(updated!.browserExamKeys).toEqual(["a".repeat(64)]);
    await app.close();
  });

  it("refuses a malformed Browser Exam Key", async () => {
    const email = `t-${randomUUID()}@heig.test`;
    const teacher = await seedUser(db, email);
    await db
      .insert(teacherGrants)
      .values({ id: randomUUID(), email, createdBy: teacher.id, codespaceEnabled: true });
    const classroomId = await seedClassroom(db, teacher.id);
    const a = await seedAssignment(db, classroomId);
    const { app, as } = await harness(db, withPortal);
    as(teacher);

    const res = await app.inject({
      method: "PATCH",
      url: `/app/api/classrooms/${classroomId}/assignments/${a.id}`,
      payload: { workMode: "online_seb", browserExamKeys: ["deadbeef"] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("cannot go back to free once published online (ADR-013, one-way door)", async () => {
    const email = `t-${randomUUID()}@heig.test`;
    const teacher = await seedUser(db, email);
    await db
      .insert(teacherGrants)
      .values({ id: randomUUID(), email, createdBy: teacher.id, codespaceEnabled: true });
    const classroomId = await seedClassroom(db, teacher.id);
    const a = await seedAssignment(db, classroomId, { workMode: "online", state: "published" });
    const { app, as } = await harness(db, withPortal);
    as(teacher);

    const res = await app.inject({
      method: "PATCH",
      url: `/app/api/classrooms/${classroomId}/assignments/${a.id}`,
      payload: { workMode: "free" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "work_mode_frozen" });
    await app.close();
  });
});

describe("provisioning permission per work mode", () => {
  /** Octokit stub on the "repository already exists" path: no git involved. */
  function fakeOctokit() {
    const calls: { route: string; params: Record<string, unknown> }[] = [];
    const request = async (route: string, params: Record<string, unknown>) => {
      calls.push({ route, params });
      if (route === "POST /orgs/{org}/repos") throw Object.assign(new Error("exists"), { status: 422 });
      if (route === "GET /repos/{owner}/{repo}") {
        return { data: { id: 42, full_name: `${params.owner}/${params.repo}`, default_branch: "main" } };
      }
      if (route === "GET /repos/{owner}/{repo}/git/matching-refs/{ref}") {
        return { data: [{ ref: "refs/heads/main" }] };
      }
      if (route === "GET /repos/{owner}/{repo}/rulesets") {
        return { data: [{ name: "hgc-protect", id: 7 }] };
      }
      if (route === "PUT /repos/{owner}/{repo}/collaborators/{username}") return { status: 201 };
      throw new Error(`unexpected route ${route}`);
    };
    return { calls, octokit: { request } as never };
  }

  const base = {
    token: "t",
    org: "org",
    squashedRepo: "lab-1-squashed",
    targetRepo: "lab-1-alice",
    branches: ["main"],
    defaultBranch: "main",
    studentLogin: "alice",
  };
  const invite = (calls: { route: string; params: Record<string, unknown> }[]) =>
    calls.find((c) => c.route === "PUT /repos/{owner}/{repo}/collaborators/{username}");

  it("free keeps push (historical flow, unchanged)", async () => {
    const { calls, octokit } = fakeOctokit();
    const res = await provisionStudentRepo({ ...base, octokit });
    expect(invite(calls)!.params.permission).toBe("push");
    expect(res.invitationStatus).toBe("pending");
    // The anti force-push ruleset is looked up in every mode.
    expect(calls.some((c) => c.route === "GET /repos/{owner}/{repo}/rulesets")).toBe(true);
  });

  it("online invites with pull only", async () => {
    const { calls, octokit } = fakeOctokit();
    await provisionStudentRepo({ ...base, octokit, workMode: "online" });
    expect(invite(calls)!.params.permission).toBe("pull");
  });

  it("online_seb does not invite the student at all", async () => {
    const { calls, octokit } = fakeOctokit();
    const res = await provisionStudentRepo({ ...base, octokit, workMode: "online_seb" });
    expect(invite(calls)).toBeUndefined();
    expect(res.invitationStatus).toBe("none");
    expect(res.rulesetId).toBe(7);
  });
});

describe("launch route", () => {
  /** Enrolled student with an accepted repository on a published online assignment. */
  async function scenario(overrides: Partial<typeof assignments.$inferInsert> = {}) {
    const teacher = await seedUser(db, `t-${randomUUID()}@heig.test`);
    const student = await seedUser(db, `s-${randomUUID()}@heig.test`, "student");
    const classroomId = await seedClassroom(db, teacher.id);
    const a = await seedAssignment(db, classroomId, {
      workMode: "online",
      state: "published",
      ...overrides,
    });
    await db.insert(enrollments).values({
      id: randomUUID(),
      classroomId,
      nom: "Doe",
      prenom: "Jane",
      email: student.email,
      status: "claimed",
      userId: student.id,
    });
    return { teacher, student, classroomId, a };
  }

  async function accept(assignmentId: string, userId: string) {
    await db.insert(studentRepos).values({
      id: randomUUID(),
      assignmentId,
      userId,
      fullName: "org/lab-1-alice",
      defaultBranch: "main",
      provisionStatus: "ok",
    });
  }

  it("is 404 when no portal is configured", async () => {
    const { student, a } = await scenario();
    await accept(a.id, student.id);
    const { app, as } = await harness(db, withoutPortal);
    as(student);
    const res = await app.inject({ method: "GET", url: `/app/codespace/start/${a.id}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("sends an anonymous visitor through the IdP and back", async () => {
    const { a } = await scenario();
    const { app, as } = await harness(db, withPortal);
    as(null);
    const res = await app.inject({ method: "GET", url: `/app/codespace/start/${a.id}` });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(
      `/app/auth/login?returnTo=${encodeURIComponent(`/app/codespace/start/${a.id}`)}`,
    );
    await app.close();
  });

  it("refuses a student who is not enrolled", async () => {
    const { a } = await scenario();
    const stranger = await seedUser(db, `x-${randomUUID()}@heig.test`, "student");
    const { app, as } = await harness(db, withPortal);
    as(stranger);
    const res = await app.inject({ method: "GET", url: `/app/codespace/start/${a.id}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("refuses a student who has not accepted the assignment", async () => {
    const { student, a } = await scenario();
    const { app, as } = await harness(db, withPortal);
    as(student);
    const res = await app.inject({ method: "GET", url: `/app/codespace/start/${a.id}` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "not_accepted" });
    await app.close();
  });

  it("refuses an assignment that is not published", async () => {
    const { student, a } = await scenario({ state: "draft" });
    await accept(a.id, student.id);
    const { app, as } = await harness(db, withPortal);
    as(student);
    const res = await app.inject({ method: "GET", url: `/app/codespace/start/${a.id}` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "not_published" });
    await app.close();
  });

  it("refuses a free assignment", async () => {
    const { student, a } = await scenario({ workMode: "free" });
    await accept(a.id, student.id);
    const { app, as } = await harness(db, withPortal);
    as(student);
    const res = await app.inject({ method: "GET", url: `/app/codespace/start/${a.id}` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "not_online" });
    await app.close();
  });

  it("redirects to the portal with a verifiable launch token", async () => {
    const { student, a } = await scenario();
    await accept(a.id, student.id);
    const { app, as } = await harness(db, withPortal);
    as(student);
    const res = await app.inject({ method: "GET", url: `/app/codespace/start/${a.id}` });
    expect(res.statusCode).toBe(303);
    const url = new URL(res.headers.location as string);
    expect(`${url.origin}${url.pathname}`).toBe("http://localhost:3100/launch");
    const token = url.searchParams.get("token")!;

    const verified = await verifyHs256<LaunchTokenClaims & Record<string, unknown>>(token, SECRET, {
      audience: "heig-codespace",
      issuer: "heig-classroom",
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims).toMatchObject({
      sub: student.id,
      email: student.email,
      assignmentId: a.id,
      repo: { fullName: "org/lab-1-alice", defaultBranch: "main" },
    });
    expect(verified.claims.jti).toMatch(/^[0-9a-f-]{36}$/);
    // Five minutes, not more.
    expect(verified.claims.exp - verified.claims.iat).toBe(300);
    // The wrong secret must not verify.
    expect(
      (await verifyHs256(token, "x".repeat(32), { audience: "heig-codespace" })).ok,
    ).toBe(false);
    await app.close();
  });
});

describe("portal synchronization job", () => {
  async function onlineAssignment() {
    const email = `t-${randomUUID()}@heig.test`;
    const teacher = await seedUser(db, email);
    await db.insert(teacherGrants).values({
      id: randomUUID(),
      email,
      createdBy: teacher.id,
      codespaceEnabled: true,
      codespaceMaxActiveSessions: 7,
    });
    const classroomId = await seedClassroom(db, teacher.id);
    const a = await seedAssignment(db, classroomId, {
      workMode: "online_seb",
      state: "published",
      codespaceImage: "c-dev",
      browserExamKeys: ["b".repeat(64)],
    });
    return { teacher, classroomId, a };
  }

  const appStub = () =>
    ({ db, log: { info: () => {}, warn: () => {}, error: () => {} } }) as unknown as FastifyInstance;

  it("PUTs a contract-shaped body with a verifiable service token", async () => {
    const { teacher, classroomId, a } = await onlineAssignment();
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response("{}", { status: 200 });
    });

    await makeCodespaceSyncHandler(appStub(), withPortal)({ assignmentId: a.id });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`http://localhost:3100/api/assignments/${a.id}`);
    expect(seen[0]!.init.method).toBe("PUT");

    const auth = (seen[0]!.init.headers as Record<string, string>).authorization!;
    const service = await verifyHs256<ServiceTokenClaims & Record<string, unknown>>(
      auth.replace("Bearer ", ""),
      SECRET,
      { audience: "heig-codespace-api", issuer: "heig-classroom" },
    );
    expect(service.ok).toBe(true);
    if (!service.ok) return;
    expect(service.claims.exp - service.claims.iat).toBe(120);

    const body = JSON.parse(seen[0]!.init.body as string) as CodespaceAssignmentSync;
    expect(body).toMatchObject({
      id: a.id,
      slug: a.slug,
      name: "Lab 1",
      classroomId,
      classroomName: "PRG1",
      mode: "online_seb",
      image: "c-dev",
      // Squash strategy (the default): the workspace is seeded from the
      // teacher's squashed template, never from the student's repository.
      sourceRepo: { fullName: "org/lab-1-squashed", defaultBranch: "main" },
      browserExamKeys: ["b".repeat(64)],
      teacher: { id: teacher.id, email: teacher.email },
      quota: { maxActiveSessions: 7 },
    });
    expect(typeof body.startAt).toBe("string");

    const [row] = await db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(row!.codespaceSyncedAt).not.toBeNull();
    expect(row!.codespaceSyncError).toBeNull();
  });

  it("records the error and rethrows on an HTTP failure, then recovers on retry", async () => {
    const { a } = await onlineAssignment();
    vi.stubGlobal("fetch", async () => new Response("portal exploded", { status: 502 }));
    const handler = makeCodespaceSyncHandler(appStub(), withPortal);
    await expect(handler({ assignmentId: a.id })).rejects.toThrow(/502/);
    const [failed] = await db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(failed!.codespaceSyncError).toContain("502");
    expect(failed!.codespaceSyncedAt).toBeNull();

    // pg-boss retries the very same job: the PUT is idempotent on both sides.
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    await handler({ assignmentId: a.id });
    const [ok] = await db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(ok!.codespaceSyncError).toBeNull();
    expect(ok!.codespaceSyncedAt).not.toBeNull();
  });

  it("does nothing for a free assignment", async () => {
    const teacher = await seedUser(db, `t-${randomUUID()}@heig.test`);
    const classroomId = await seedClassroom(db, teacher.id);
    const a = await seedAssignment(db, classroomId);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await makeCodespaceSyncHandler(appStub(), withPortal)({ assignmentId: a.id });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * The teacher's `.seb` download (2026-09-18 audit, item 1): the Config Key the
 * portal echoes back, and the plain HTTPS URL of the file.
 */
describe("the `.seb` a teacher downloads", () => {
  const appStub = () =>
    ({ db, log: { info: () => {}, warn: () => {}, error: () => {} } }) as unknown as FastifyInstance;

  async function examAssignment() {
    const email = `t-${randomUUID()}@heig.test`;
    const teacher = await seedUser(db, email);
    await db.insert(teacherGrants).values({
      id: randomUUID(),
      email,
      createdBy: teacher.id,
      codespaceEnabled: true,
      codespaceMaxActiveSessions: 2,
    });
    const classroomId = await seedClassroom(db, teacher.id);
    return seedAssignment(db, classroomId, {
      workMode: "online_seb",
      state: "published",
      browserExamKeys: ["b".repeat(64)],
    });
  }

  it("is an https:// URL on the portal, never the sebs:// deep link", async () => {
    const a = await examAssignment();
    expect(sebFileUrl(withPortal, a)).toBe(`http://localhost:3100/exam/${a.id}.seb`);
  });

  it("does not exist outside exam mode, nor without a portal", async () => {
    const a = await examAssignment();
    for (const workMode of ["free", "online"] as const) {
      expect(sebFileUrl(withPortal, { ...a, workMode })).toBeNull();
    }
    expect(sebFileUrl(withoutPortal, a)).toBeNull();
  });

  it("stores the Config Key the portal answers with", async () => {
    const a = await examAssignment();
    const key = "c".repeat(64);
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ id: a.id, configKey: key, sebLink: "sebs://p/x.seb" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await makeCodespaceSyncHandler(appStub(), withPortal)({ assignmentId: a.id });
    const [row] = await db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(row!.codespaceConfigKey).toBe(key);
  });

  it("a sync that succeeds with an unreadable body is still a success", async () => {
    // The PUT went through; only the echo was lost. Failing the job here
    // would make pg-boss retry a write the portal has already applied.
    const a = await examAssignment();
    vi.stubGlobal("fetch", async () => new Response("not json", { status: 200 }));
    await makeCodespaceSyncHandler(appStub(), withPortal)({ assignmentId: a.id });
    const [row] = await db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(row!.codespaceSyncedAt).not.toBeNull();
    expect(row!.codespaceSyncError).toBeNull();
    expect(row!.codespaceConfigKey).toBeNull();
  });

  it("leaving exam mode clears the key rather than leaving a stale one", async () => {
    const a = await examAssignment();
    const key = "d".repeat(64);
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ id: a.id, configKey: key, sebLink: null })),
    );
    const handler = makeCodespaceSyncHandler(appStub(), withPortal);
    await handler({ assignmentId: a.id });
    expect((await db.select().from(assignments).where(eq(assignments.id, a.id)))[0]!
      .codespaceConfigKey).toBe(key);

    // The teacher switches the assignment to plain online mode: the portal
    // stops serving a `.seb` for it and answers `configKey: null`.
    await db
      .update(assignments)
      .set({ workMode: "online", browserExamKeys: [] })
      .where(eq(assignments.id, a.id));
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ id: a.id, configKey: null, sebLink: null })),
    );
    await handler({ assignmentId: a.id });
    const [row] = await db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(row!.codespaceConfigKey).toBeNull();
  });
});
