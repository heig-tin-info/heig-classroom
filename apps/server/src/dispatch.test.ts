import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { classrooms, organizations, pushReceipts, studentRepos, users, assignments } from "./db/schema.js";
import { milestoneShaForRepo, planDispatch, planMilestoneDispatch } from "./dispatch.js";
import { runKind, GRADING_WORKFLOW_PATH } from "./grading.js";
import { testApp } from "./test/db.js";

describe("planDispatch (GR-16)", () => {
  const assignment = {
    id: "a-1",
    deadlineAt: new Date("2026-07-03T21:59:00Z"),
  };

  it("skips repositories without a frozen grade run (nothing to review)", () => {
    expect(planDispatch(assignment, null)).toBeNull();
  });

  it("builds the grade-final payload around the frozen commit", () => {
    const sha = "a".repeat(40);
    const plan = planDispatch(assignment, sha);
    expect(plan).toEqual({
      sha,
      eventType: "grade-final",
      clientPayload: {
        sha,
        assignment_id: "a-1",
        deadline: "2026-07-03T21:59:00.000Z",
        trigger: "deadline",
      },
    });
  });
});

describe("planMilestoneDispatch", () => {
  const milestone = {
    id: "m-1",
    name: "mid-review",
    dueAt: new Date("2026-07-01T22:00:00Z"),
  };

  it("skips repositories where the student never pushed before the milestone", () => {
    expect(planMilestoneDispatch("a-1", milestone, null)).toBeNull();
  });

  it("builds the grade-milestone payload around the last received commit", () => {
    const sha = "b".repeat(40);
    expect(planMilestoneDispatch("a-1", milestone, sha)).toEqual({
      sha,
      eventType: "grade-milestone",
      clientPayload: {
        sha,
        assignment_id: "a-1",
        milestone_id: "m-1",
        milestone: "mid-review",
        due: "2026-07-01T22:00:00.000Z",
        trigger: "milestone",
      },
    });
  });
});

describe("milestoneShaForRepo (server-receipt selection)", () => {
  const sha = (c: string) => c.repeat(40);

  it("picks the last student push on a selected branch received before the milestone", async () => {
    const app = await testApp();
    const teacherId = randomUUID();
    const studentId = randomUUID();
    const orgId = randomUUID();
    const classroomId = randomUUID();
    const assignmentId = randomUUID();
    const repoId = randomUUID();
    await app.db.insert(users).values([
      { id: teacherId, oidcSub: `t-${teacherId}`, email: "t@heig.test", role: "teacher" },
      { id: studentId, oidcSub: `s-${studentId}`, email: "s@heig.test" },
    ]);
    await app.db.insert(organizations).values({ id: orgId, login: "org" });
    await app.db.insert(classrooms).values({ id: classroomId, orgId, teacherId, name: "PRG1" });
    await app.db.insert(assignments).values({
      id: assignmentId,
      classroomId,
      name: "Labo 1",
      slug: "labo-1",
      startAt: new Date("2026-07-01T08:00:00Z"),
      deadlineAt: new Date("2026-07-10T22:00:00Z"),
      sourceRepoId: 1,
      sourceFullName: "org/labo-1",
      branches: ["main"],
      protectedFiles: [],
    });
    await app.db.insert(studentRepos).values({
      id: repoId,
      assignmentId,
      userId: studentId,
      fullName: "org/labo-1-student",
      provisionStatus: "ok",
    });
    const due = new Date("2026-07-05T22:00:00Z");
    await app.db.insert(pushReceipts).values([
      // Before the milestone: candidate.
      { id: randomUUID(), studentRepoId: repoId, branch: "main", headSha: sha("1"), receivedAt: new Date("2026-07-03T10:00:00Z") },
      // Latest before the milestone: the winner.
      { id: randomUUID(), studentRepoId: repoId, branch: "main", headSha: sha("2"), receivedAt: new Date("2026-07-05T21:00:00Z") },
      // Bot push (deadline marker, GRADING.yml): never reviewed.
      { id: randomUUID(), studentRepoId: repoId, branch: "main", headSha: sha("3"), receivedAt: new Date("2026-07-05T21:30:00Z"), isBot: true },
      // Unselected branch: ignored.
      { id: randomUUID(), studentRepoId: repoId, branch: "wip", headSha: sha("4"), receivedAt: new Date("2026-07-05T21:45:00Z") },
      // After the milestone: next round's material.
      { id: randomUUID(), studentRepoId: repoId, branch: "main", headSha: sha("5"), receivedAt: new Date("2026-07-06T08:00:00Z") },
    ]);

    expect(await milestoneShaForRepo(app, repoId, ["main"], due)).toBe(sha("2"));
    expect(await milestoneShaForRepo(app, randomUUID(), ["main"], due)).toBeNull();
  });
});

describe("runKind (GR-16)", () => {
  it("classifies the dispatched grading run as llm", () => {
    expect(runKind({ event: "repository_dispatch", path: GRADING_WORKFLOW_PATH })).toBe("llm");
  });

  it("keeps push-triggered grading runs as ci (indicative tier)", () => {
    expect(runKind({ event: "push", path: GRADING_WORKFLOW_PATH })).toBe("ci");
  });

  it("never classifies a non-grading workflow as llm, even on dispatch", () => {
    // A student workflow listening to repository_dispatch must not be able
    // to impersonate the review pipeline.
    expect(runKind({ event: "repository_dispatch", path: ".github/workflows/own.yml" })).toBe("ci");
  });

  it("treats unknown events conservatively as ci", () => {
    expect(runKind({ event: "", path: GRADING_WORKFLOW_PATH })).toBe("ci");
  });
});
