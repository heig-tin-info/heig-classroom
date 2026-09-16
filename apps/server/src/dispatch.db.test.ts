/**
 * Review dispatch against repositories that no longer exist on GitHub
 * (issue #10): a 404 is terminal, never a retryable failure, and a pass
 * that dispatched nothing never publishes a notice.
 */
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import type { AppConfig } from "./config.js";
import {
  assignmentMilestones,
  assignments,
  classrooms,
  gradeRuns,
  organizations,
  pushReceipts,
  studentRepos,
  users,
} from "./db/schema.js";
import { subscribe, type AppEvent } from "./events.js";
import { makeGradeDispatchHandler } from "./dispatch.js";
import { testApp, type TestDb } from "./test/db.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./github/app.js", () => ({
  installationClient: async () => ({ octokit: { request }, token: "t" }),
}));

const config = {} as AppConfig;
const sha = "a".repeat(40);

/** Notices (toasts) published while `fn` runs. */
async function noticesOf(fn: () => Promise<unknown>): Promise<AppEvent[]> {
  const seen: AppEvent[] = [];
  const off = subscribe((e) => {
    if (e.notice) seen.push(e);
  });
  try {
    await fn();
  } finally {
    off();
  }
  return seen;
}

/** One frozen assignment with a single provisioned repo and a frozen run. */
async function seed(db: TestDb, opts: { frozen?: boolean; deletedAt?: Date } = {}) {
  const frozen = opts.frozen ?? true;
  const teacherId = randomUUID();
  const studentId = randomUUID();
  const orgId = randomUUID();
  const classroomId = randomUUID();
  const assignmentId = randomUUID();
  const repoId = randomUUID();
  const runId = randomUUID();
  await db.insert(users).values([
    { id: teacherId, oidcSub: `t-${teacherId}`, email: "t@heig.test", role: "teacher" },
    { id: studentId, oidcSub: `s-${studentId}`, email: "s@heig.test" },
  ]);
  await db.insert(organizations).values({ id: orgId, login: "org", installationId: 99 });
  await db.insert(classrooms).values({ id: classroomId, orgId, teacherId, name: "PRG1" });
  await db.insert(assignments).values({
    id: assignmentId,
    classroomId,
    name: "Labo02-V1",
    slug: "labo02-v1",
    state: "locked",
    startAt: new Date("2026-07-01T08:00:00Z"),
    deadlineAt: new Date("2026-07-10T22:00:00Z"),
    frozenAt: frozen ? new Date("2026-07-10T22:30:00Z") : null,
    sourceRepoId: 1,
    sourceFullName: "org/labo02",
    branches: ["main"],
    protectedFiles: [],
  });
  await db.insert(studentRepos).values({
    id: repoId,
    assignmentId,
    userId: studentId,
    fullName: "org/labo02-student",
    provisionStatus: "ok",
    deletedAt: opts.deletedAt ?? null,
  });
  await db.insert(gradeRuns).values({
    id: runId,
    studentRepoId: repoId,
    workflowRunId: 1,
    headBranch: "main",
    headSha: sha,
    conclusion: "success",
    parseStatus: "ok",
    completedAt: new Date("2026-07-10T21:00:00Z"),
  });
  await db
    .update(studentRepos)
    .set({ frozenGradeRunId: runId })
    .where(eq(studentRepos.id, repoId));
  return { assignmentId, repoId };
}

const repoOf = async (db: TestDb, id: string) =>
  (await db.select().from(studentRepos).where(eq(studentRepos.id, id)))[0]!;
const assignmentOf = async (db: TestDb, id: string) =>
  (await db.select().from(assignments).where(eq(assignments.id, id)))[0]!;

afterEach(() => request.mockReset());

describe("grade dispatch with deleted repositories (GR-16, issue #10)", () => {
  it("dispatches and publishes exactly one notice when something happened", async () => {
    const app = await testApp();
    const { assignmentId } = await seed(app.db);
    request.mockResolvedValue({});

    const notices = await noticesOf(() =>
      makeGradeDispatchHandler(app, config)({ assignmentId }),
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.notice!.message).toContain("(1/1 repositories)");
    expect((await assignmentOf(app.db, assignmentId)).llmDispatchedAt).not.toBeNull();
  });

  it("skips repositories already marked deleted and completes the assignment", async () => {
    const app = await testApp();
    const { assignmentId } = await seed(app.db, { deletedAt: new Date("2026-07-09T10:00:00Z") });

    const notices = await noticesOf(() =>
      makeGradeDispatchHandler(app, config)({ assignmentId }),
    );

    expect(request).not.toHaveBeenCalled();
    expect(notices).toHaveLength(0); // nothing dispatched: nothing to say
    // Completed, so the ticker stops re-enqueueing every 20 s.
    expect((await assignmentOf(app.db, assignmentId)).llmDispatchedAt).not.toBeNull();
  });

  it("turns a 404 into deleted_at and completes instead of retrying forever", async () => {
    const app = await testApp();
    const { assignmentId, repoId } = await seed(app.db);
    request.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));

    const notices = await noticesOf(() =>
      makeGradeDispatchHandler(app, config)({ assignmentId }),
    );

    expect(notices).toHaveLength(0);
    expect((await repoOf(app.db, repoId)).deletedAt).not.toBeNull();
    expect((await assignmentOf(app.db, assignmentId)).llmDispatchedAt).not.toBeNull();
  });

  it("stays silent on a retryable failure, pass after pass", async () => {
    const app = await testApp();
    const { assignmentId, repoId } = await seed(app.db);
    request.mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
    const handler = makeGradeDispatchHandler(app, config);

    const notices = await noticesOf(async () => {
      await expect(handler({ assignmentId })).rejects.toThrow(/incomplete/);
      await expect(handler({ assignmentId })).rejects.toThrow(/incomplete/);
    });

    expect(notices).toHaveLength(0); // the loop of issue #10
    expect((await repoOf(app.db, repoId)).deletedAt).toBeNull(); // still retryable
    expect((await assignmentOf(app.db, assignmentId)).llmDispatchedAt).toBeNull();
  });
});

describe("milestone dispatch with deleted repositories", () => {
  it("marks the repository deleted on a 404 and completes the milestone", async () => {
    const app = await testApp();
    const { assignmentId, repoId } = await seed(app.db, { frozen: false });
    const milestoneId = randomUUID();
    await app.db.insert(assignmentMilestones).values({
      id: milestoneId,
      assignmentId,
      name: "mid-review",
      dueAt: new Date("2026-07-05T22:00:00Z"),
    });
    await app.db.insert(pushReceipts).values({
      id: randomUUID(),
      studentRepoId: repoId,
      branch: "main",
      headSha: sha,
      receivedAt: new Date("2026-07-04T10:00:00Z"),
    });
    request.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));

    const notices = await noticesOf(() =>
      makeGradeDispatchHandler(app, config)({ assignmentId, milestoneId }),
    );

    expect(notices).toHaveLength(0);
    expect((await repoOf(app.db, repoId)).deletedAt).not.toBeNull();
    const [m] = await app.db
      .select()
      .from(assignmentMilestones)
      .where(eq(assignmentMilestones.id, milestoneId));
    expect(m!.dispatchedAt).not.toBeNull();
  });
});
