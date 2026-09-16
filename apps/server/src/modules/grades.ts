/**
 * Classroom-wide grade sheet: the non-staff roster x the graded assignments,
 * with the final grade of every student. Database only — no GitHub call — so
 * it stays cheap enough to build on demand.
 *
 * The final grade rule itself lives in `resolveFinalGrade` (@hgc/domain), the
 * very one the assignment detail view and the student view apply: teacher
 * adjustment, else LLM review, else frozen CI grade.
 */
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import type { ClassroomGradesPayload } from "@hgc/contracts";
import { finalPoints } from "@hgc/domain";

import { assignments, enrollments, studentRepos } from "../db/schema.js";
import { gradeViewsByIds } from "../grading.js";

export async function classroomGrades(
  app: FastifyInstance,
  classroom: { id: string; name: string },
): Promise<ClassroomGradesPayload> {
  const graded = await app.db
    .select()
    .from(assignments)
    .where(
      and(
        eq(assignments.classroomId, classroom.id),
        ne(assignments.gradingMode, "none"),
        isNull(assignments.archivedAt),
      ),
    )
    .orderBy(assignments.deadlineAt);

  const roster = await app.db
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.classroomId, classroom.id), eq(enrollments.staff, false)))
    .orderBy(enrollments.nom, enrollments.prenom);

  const repos = graded.length
    ? await app.db
        .select()
        .from(studentRepos)
        .where(
          inArray(
            studentRepos.assignmentId,
            graded.map((a) => a.id),
          ),
        )
    : [];
  // Current, frozen and LLM slots of every repository, in one query.
  const grades = await gradeViewsByIds(
    app,
    repos.flatMap((r) => [r.currentGradeRunId, r.frozenGradeRunId, r.llmGradeRunId]),
  );
  const view = (id: string | null) => (id ? (grades.get(id) ?? null) : null);
  const byAssignmentUser = new Map(repos.map((r) => [`${r.assignmentId}:${r.userId}`, r]));

  return {
    classroom: { id: classroom.id, name: classroom.name },
    assignments: graded.map((a) => ({
      id: a.id,
      name: a.name,
      deadlineAt: a.deadlineAt.toISOString(),
      gradesValidatedAt: a.gradesValidatedAt?.toISOString() ?? null,
    })),
    students: roster.map((s) => {
      const points: Record<string, number | null> = {};
      for (const a of graded) {
        const repo = s.userId ? byAssignmentUser.get(`${a.id}:${s.userId}`) : undefined;
        points[a.id] = repo
          ? finalPoints({
              teacherPoints: repo.teacherPoints,
              llmGrade: view(repo.llmGradeRunId),
              frozenGrade: view(repo.frozenGradeRunId),
              grade: view(repo.currentGradeRunId),
            })
          : null;
      }
      return {
        enrollmentId: s.id,
        nom: s.nom,
        prenom: s.prenom,
        email: s.email,
        status: s.status,
        points,
      };
    }),
  };
}
