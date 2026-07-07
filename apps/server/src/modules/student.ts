import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { assignments, classrooms, enrollments, organizations, users } from "../db/schema.js";
import { claimEnrollments } from "./roster.js";

/**
 * Vue étudiant : classrooms où l'étudiant est rattaché et assignments
 * publiés (US-10..14 — l'acceptation/provisionnement arrive en tranche
 * suivante). Le chargement tente d'abord un claim (AU-18) : une entrée de
 * roster ajoutée pendant que l'étudiant avait déjà une session est ainsi
 * rattachée sans re-login.
 */
export async function studentPlugin(app: FastifyInstance) {
  app.get(
    "/app/api/student/classrooms",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req) => {
      const me = req.user!;
      if (me.emailVerified) {
        await claimEnrollments(app.db, { id: me.id, email: me.email });
      }

      const rooms = await app.db
        .select({
          id: classrooms.id,
          name: classrooms.name,
          orgLogin: organizations.login,
          teacher: users.givenName,
          teacherFamily: users.familyName,
        })
        .from(enrollments)
        .innerJoin(classrooms, eq(enrollments.classroomId, classrooms.id))
        .innerJoin(organizations, eq(classrooms.orgId, organizations.id))
        .innerJoin(users, eq(classrooms.teacherId, users.id))
        .where(and(eq(enrollments.userId, me.id), eq(enrollments.status, "claimed")))
        .orderBy(asc(classrooms.name));

      const roomIds = rooms.map((r) => r.id);
      const published = roomIds.length
        ? await app.db
            .select({
              id: assignments.id,
              classroomId: assignments.classroomId,
              name: assignments.name,
              state: assignments.state,
              startAt: assignments.startAt,
              deadlineAt: assignments.deadlineAt,
            })
            .from(assignments)
            .where(
              and(
                inArray(assignments.classroomId, roomIds),
                inArray(assignments.state, ["published", "locked"]),
                isNull(assignments.archivedAt),
              ),
            )
            .orderBy(asc(assignments.deadlineAt))
        : [];

      return rooms.map((r) => ({
        id: r.id,
        name: r.name,
        orgLogin: r.orgLogin,
        teacher: `${r.teacher} ${r.teacherFamily}`.trim(),
        assignments: published.filter((a) => a.classroomId === r.id),
      }));
    },
  );
}
