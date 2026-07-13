import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Octokit } from "octokit";

import type { AppConfig } from "./config.js";
import {
  assignments,
  classrooms,
  gradeRuns,
  organizations,
  pushReceipts,
  studentRepos,
  users,
} from "./db/schema.js";
import {
  GRADING_WORKFLOW_PATH,
  ingestCompletedRun,
  isAfterDeadline,
  selectGradeRun,
  type CompletedRun,
  type RepoCtx,
} from "./grading.js";
import { testApp, type TestDb } from "./test/db.js";

const config = { PUBLIC_URL: "https://classroom.test", COOKIE_SECRET: "s" } as AppConfig;

const sha = (c: string) => c.repeat(40);

/** One classroom, one provisioned student repo; deadline defaults to the future. */
async function seed(db: TestDb, opts: { deadlineAt?: Date } = {}): Promise<RepoCtx> {
  const teacherId = randomUUID();
  const studentId = randomUUID();
  const orgId = randomUUID();
  const classroomId = randomUUID();
  const assignmentId = randomUUID();
  const repoId = randomUUID();
  await db.insert(users).values([
    { id: teacherId, oidcSub: `t-${teacherId}`, email: `t-${teacherId}@heig.test`, role: "teacher" },
    { id: studentId, oidcSub: `s-${studentId}`, email: `s-${studentId}@heig.test` },
  ]);
  await db.insert(organizations).values({ id: orgId, login: `org-${orgId.slice(0, 8)}` });
  await db.insert(classrooms).values({ id: classroomId, orgId, teacherId, name: "PRG1" });
  await db.insert(assignments).values({
    id: assignmentId,
    classroomId,
    name: "Labo 1",
    slug: "labo-1",
    state: "published",
    startAt: new Date("2026-07-01T08:00:00Z"),
    deadlineAt: opts.deadlineAt ?? new Date(Date.now() + 7 * 86_400_000),
    sourceRepoId: 1,
    sourceFullName: "org/labo-1",
    branches: ["main"],
    protectedFiles: [],
  });
  await db.insert(studentRepos).values({
    id: repoId,
    assignmentId,
    userId: studentId,
    fullName: "org/labo-1-student",
    provisionStatus: "ok",
  });
  const [repo] = await db.select().from(studentRepos).where(eq(studentRepos.id, repoId));
  const [assignment] = await db.select().from(assignments).where(eq(assignments.id, assignmentId));
  return { repo: repo!, assignment: assignment!, classroomId };
}

type RunRow = typeof gradeRuns.$inferInsert;

function run(repoId: string, over: Partial<RunRow>): RunRow {
  return {
    id: randomUUID(),
    studentRepoId: repoId,
    workflowRunId: Math.floor(Math.random() * 1e9),
    runAttempt: 1,
    headBranch: "main",
    headSha: sha("a"),
    conclusion: "success",
    parseStatus: "ok",
    kind: "ci",
    afterDeadline: false,
    completedAt: new Date("2026-07-02T10:00:00Z"),
    ...over,
  };
}

describe("selectGradeRun (GR-09)", () => {
  let app: FastifyInstance & { db: TestDb };
  beforeAll(async () => {
    app = await testApp();
  });

  it("returns null when the repository has no eligible run", async () => {
    const ctx = await seed(app.db);
    expect(await selectGradeRun(app, ctx.repo.id)).toBeNull();
  });

  it("picks the most recent ok|fallback CI run and nothing else", async () => {
    const ctx = await seed(app.db);
    const old = run(ctx.repo.id, { completedAt: new Date("2026-07-02T10:00:00Z") });
    const newer = run(ctx.repo.id, { completedAt: new Date("2026-07-03T10:00:00Z") });
    // Every decoy is MORE recent than `newer` and must still lose:
    const llm = run(ctx.repo.id, { kind: "llm", completedAt: new Date("2026-07-05T10:00:00Z") });
    const late = run(ctx.repo.id, { afterDeadline: true, completedAt: new Date("2026-07-05T11:00:00Z") });
    const malformed = run(ctx.repo.id, { parseStatus: "malformed", completedAt: new Date("2026-07-05T12:00:00Z") });
    const multiple = run(ctx.repo.id, { parseStatus: "multiple", completedAt: new Date("2026-07-05T13:00:00Z") });
    await app.db.insert(gradeRuns).values([old, newer, llm, late, malformed, multiple]);
    expect(await selectGradeRun(app, ctx.repo.id)).toBe(newer.id);
  });

  it("accepts fallback runs (repo without the grading convention, GR-06)", async () => {
    const ctx = await seed(app.db);
    const fb = run(ctx.repo.id, { parseStatus: "fallback" });
    await app.db.insert(gradeRuns).values(fb);
    expect(await selectGradeRun(app, ctx.repo.id)).toBe(fb.id);
  });
});

describe("isAfterDeadline (GR-14)", () => {
  let app: FastifyInstance & { db: TestDb };
  beforeAll(async () => {
    app = await testApp();
  });

  it("trusts the push receipt over the current time", async () => {
    // Deadline already past, but the commit was RECEIVED before it.
    const ctx = await seed(app.db, { deadlineAt: new Date(Date.now() - 3_600_000) });
    await app.db.insert(pushReceipts).values({
      id: randomUUID(),
      studentRepoId: ctx.repo.id,
      branch: "main",
      headSha: sha("b"),
      receivedAt: new Date(Date.now() - 7_200_000),
    });
    expect(await isAfterDeadline(app, ctx, sha("b"))).toBe(false);
  });

  it("flags a receipt after the deadline", async () => {
    const ctx = await seed(app.db, { deadlineAt: new Date(Date.now() - 3_600_000) });
    await app.db.insert(pushReceipts).values({
      id: randomUUID(),
      studentRepoId: ctx.repo.id,
      branch: "main",
      headSha: sha("c"),
      receivedAt: new Date(Date.now() - 60_000),
    });
    expect(await isAfterDeadline(app, ctx, sha("c"))).toBe(true);
  });

  it("is conservative without a receipt once the deadline passed (GR-14.3)", async () => {
    const ctx = await seed(app.db, { deadlineAt: new Date(Date.now() - 3_600_000) });
    expect(await isAfterDeadline(app, ctx, sha("d"))).toBe(true);
  });

  it("stays permissive without a receipt while the deadline is ahead", async () => {
    const ctx = await seed(app.db);
    expect(await isAfterDeadline(app, ctx, sha("d"))).toBe(false);
  });
});

/** Octokit stub: GRADE annotation + empty workflow-run listing. */
function octokitStub(annotation: { title: string; message: string } | null) {
  return {
    request: async (route: string) => {
      if (route.includes("check-runs/{check_run_id}/annotations")) {
        return {
          data: annotation ? [{ annotation_level: "notice", ...annotation }] : [],
        };
      }
      if (route.includes("/commits/{ref}/check-runs")) {
        return {
          data: {
            check_runs: [{ id: 1, check_suite: { id: 99 }, output: { annotations_count: 1 } }],
          },
        };
      }
      if (route.includes("/actions/runs")) {
        return { data: { workflow_runs: [] } };
      }
      throw new Error(`unexpected octokit call: ${route}`);
    },
  } as unknown as Octokit;
}

function llmRun(over: Partial<CompletedRun> = {}): CompletedRun {
  return {
    workflowRunId: 4242,
    runAttempt: 1,
    headBranch: "main",
    headSha: sha("e"),
    conclusion: "success",
    path: GRADING_WORKFLOW_PATH,
    event: "repository_dispatch",
    checkSuiteId: 99,
    completedAt: new Date("2026-07-04T10:00:00Z"),
    ...over,
  };
}

describe("ingestCompletedRun — LLM review (GR-16)", () => {
  let app: FastifyInstance & { db: TestDb };
  beforeAll(async () => {
    app = await testApp();
  });

  async function llmRunIdOf(repoId: string) {
    const [row] = await app.db.select().from(studentRepos).where(eq(studentRepos.id, repoId));
    return row!.llmGradeRunId;
  }

  it("a successful review becomes the authoritative llm grade", async () => {
    const ctx = await seed(app.db);
    const id = await ingestCompletedRun(
      app,
      octokitStub({ title: "GRADE", message: "5/6" }),
      ctx,
      llmRun(),
      config,
    );
    expect(id).not.toBeNull();
    expect(await llmRunIdOf(ctx.repo.id)).toBe(id);
  });

  it("a failed run is captured for the trace but NEVER becomes authoritative", async () => {
    // Real incident: grading.yml falls back to "GRADE 1/6" when the LLM step
    // dies (missing ANTHROPIC_API_KEY) — an infrastructure failure, not a grade.
    const ctx = await seed(app.db);
    const id = await ingestCompletedRun(
      app,
      octokitStub({ title: "GRADE", message: "1/6" }),
      ctx,
      llmRun({ conclusion: "failure" }),
      config,
    );
    expect(id).not.toBeNull(); // the trace row exists…
    const [row] = await app.db.select().from(gradeRuns).where(eq(gradeRuns.id, id!));
    expect(row!.kind).toBe("llm");
    expect(await llmRunIdOf(ctx.repo.id)).toBeNull(); // …but no authority
  });

  it("is idempotent on (workflowRunId, runAttempt)", async () => {
    const ctx = await seed(app.db);
    const octokit = octokitStub({ title: "GRADE", message: "5/6" });
    const first = await ingestCompletedRun(app, octokit, ctx, llmRun(), config);
    const second = await ingestCompletedRun(app, octokit, ctx, llmRun(), config);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("ignores runs on a branch outside the assignment selection", async () => {
    const ctx = await seed(app.db);
    const id = await ingestCompletedRun(
      app,
      octokitStub({ title: "GRADE", message: "5/6" }),
      ctx,
      llmRun({ headBranch: "feature" }),
      config,
    );
    expect(id).toBeNull();
  });
});
