import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  assignments,
  classrooms,
  enrollments,
  gradeRuns,
  organizations,
  studentRepos,
  users,
} from "../db/schema.js";
import { testApp, type TestDb } from "../test/db.js";
import { classroomGrades } from "./grades.js";

const sha = (c: string) => c.repeat(40);

type App = Awaited<ReturnType<typeof testApp>>;

/**
 * One classroom, one graded assignment, four students: a teacher override, an
 * LLM review, a frozen CI grade only, and a student without a repository.
 */
async function seed(db: TestDb) {
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
    state: "locked",
    startAt: new Date("2026-07-01T08:00:00Z"),
    deadlineAt: new Date("2026-07-08T08:00:00Z"),
    frozenAt: new Date("2026-07-08T08:30:00Z"),
    sourceRepoId: 1,
    sourceFullName: "org/labo-1",
    branches: ["main"],
    protectedFiles: [],
  });

  /** Enrolls a student and, unless `noRepo`, provisions their repository. */
  const student = async (
    nom: string,
    opts: { noRepo?: boolean; staff?: boolean; teacherPoints?: number } = {},
  ) => {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      oidcSub: `s-${userId}`,
      email: `${nom.toLowerCase()}@heig.test`,
    });
    await db.insert(enrollments).values({
      id: randomUUID(),
      classroomId,
      nom,
      prenom: "X",
      email: `${nom.toLowerCase()}@heig.test`,
      status: "claimed",
      userId,
      staff: opts.staff ?? false,
    });
    if (opts.noRepo) return { userId, repoId: null };
    const repoId = randomUUID();
    await db.insert(studentRepos).values({
      id: repoId,
      assignmentId,
      userId,
      fullName: `org/labo-1-${nom.toLowerCase()}`,
      provisionStatus: "ok",
      teacherPoints: opts.teacherPoints ?? null,
    });
    return { userId, repoId };
  };

  /** Captures a grade run and points the given slot of the repo at it. */
  const grade = async (
    repoId: string,
    slot: "currentGradeRunId" | "frozenGradeRunId" | "llmGradeRunId",
    points: number,
    kind: "ci" | "llm" = "ci",
  ) => {
    const id = randomUUID();
    await db.insert(gradeRuns).values({
      id,
      studentRepoId: repoId,
      workflowRunId: Math.floor(Math.random() * 1e9),
      runAttempt: 1,
      headBranch: "main",
      headSha: sha("a"),
      conclusion: "success",
      gradePoints: points,
      gradeMax: 6,
      parseStatus: "ok",
      kind,
      afterDeadline: false,
      completedAt: new Date("2026-07-08T07:00:00Z"),
    });
    await db
      .update(studentRepos)
      .set({ [slot]: id })
      .where(eq(studentRepos.id, repoId));
  };

  return { classroomId, assignmentId, student, grade };
}

describe("classroomGrades", () => {
  let app: App;
  beforeAll(async () => {
    app = await testApp();
  });

  it("resolves teacher override > LLM review > frozen CI, per student", async () => {
    const { classroomId, assignmentId, student, grade } = await seed(app.db);
    const adjusted = await student("Adjusted", { teacherPoints: 5.5 });
    await grade(adjusted.repoId!, "llmGradeRunId", 4, "llm");
    await grade(adjusted.repoId!, "frozenGradeRunId", 3);
    const reviewed = await student("Reviewed");
    await grade(reviewed.repoId!, "llmGradeRunId", 4.5, "llm");
    await grade(reviewed.repoId!, "frozenGradeRunId", 3.5);
    const ciOnly = await student("Cionly");
    await grade(ciOnly.repoId!, "frozenGradeRunId", 2.5);
    await student("Norepo", { noRepo: true });
    await student("Staffer", { staff: true });

    const sheet = await classroomGrades(app, { id: classroomId, name: "PRG1" });

    expect(sheet.assignments).toEqual([
      {
        id: assignmentId,
        name: "Labo 1",
        deadlineAt: "2026-07-08T08:00:00.000Z",
        gradesValidatedAt: null,
      },
    ]);
    // Staff seats stay out of the sheet; the roster is ordered by name.
    expect(sheet.students.map((s) => s.nom)).toEqual([
      "Adjusted",
      "Cionly",
      "Norepo",
      "Reviewed",
    ]);
    const points = Object.fromEntries(
      sheet.students.map((s) => [s.nom, s.points[assignmentId]]),
    );
    expect(points).toEqual({
      Adjusted: 5.5,
      Reviewed: 4.5,
      Cionly: 2.5,
      // No repository (never accepted the assignment): no grade, not a zero.
      Norepo: null,
    });
  });

  it("leaves out ungraded and archived assignments", async () => {
    const { classroomId } = await seed(app.db);
    await app.db.insert(assignments).values([
      {
        id: randomUUID(),
        classroomId,
        name: "Ungraded",
        slug: "ungraded",
        gradingMode: "none",
        startAt: new Date("2026-07-01T08:00:00Z"),
        deadlineAt: new Date("2026-07-02T08:00:00Z"),
        sourceRepoId: 2,
        sourceFullName: "org/ungraded",
        branches: ["main"],
        protectedFiles: [],
      },
      {
        id: randomUUID(),
        classroomId,
        name: "Archived",
        slug: "archived",
        archivedAt: new Date("2026-07-03T08:00:00Z"),
        startAt: new Date("2026-07-01T08:00:00Z"),
        deadlineAt: new Date("2026-07-03T08:00:00Z"),
        sourceRepoId: 3,
        sourceFullName: "org/archived",
        branches: ["main"],
        protectedFiles: [],
      },
    ]);

    const sheet = await classroomGrades(app, { id: classroomId, name: "PRG1" });

    expect(sheet.assignments.map((a) => a.name)).toEqual(["Labo 1"]);
  });
});
