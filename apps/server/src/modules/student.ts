import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { audit } from "../audit.js";
import { publish } from "../events.js";
import type { AppConfig } from "../config.js";
import {
  assignments,
  classrooms,
  enrollments,
  organizations,
  studentRepos,
  users,
} from "../db/schema.js";
import { installationClient } from "../github/app.js";
import { provisionStudentRepo } from "../github/provision.js";
import { claimEnrollments } from "./roster.js";

/**
 * Vue et actions étudiant : classrooms rattachées, assignments publiés,
 * acceptation avec provisionnement du dépôt (GH-20..25). Le chargement tente
 * d'abord un claim (AU-18) : une entrée ajoutée pendant une session active
 * est rattachée sans re-login.
 */
export async function studentPlugin(
  app: FastifyInstance,
  opts: { config: AppConfig },
) {
  const { config } = opts;

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
        .where(
          and(
            eq(enrollments.userId, me.id),
            eq(enrollments.status, "claimed"),
            isNull(classrooms.archivedAt),
          ),
        )
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

      const repos = published.length
        ? await app.db
            .select()
            .from(studentRepos)
            .where(
              and(
                eq(studentRepos.userId, me.id),
                inArray(
                  studentRepos.assignmentId,
                  published.map((a) => a.id),
                ),
              ),
            )
        : [];

      return rooms.map((r) => ({
        id: r.id,
        name: r.name,
        orgLogin: r.orgLogin,
        teacher: `${r.teacher} ${r.teacherFamily}`.trim(),
        assignments: published
          .filter((a) => a.classroomId === r.id)
          .map((a) => {
            const repo = repos.find((sr) => sr.assignmentId === a.id);
            return {
              ...a,
              repo: repo
                ? {
                    fullName: repo.fullName,
                    provisionStatus: repo.provisionStatus,
                    invitationStatus: repo.invitationStatus,
                  }
                : null,
            };
          }),
      }));
    },
  );

  const AcceptParam = z.object({ aid: z.uuid() });

  app.post(
    "/app/api/student/assignments/:aid/accept",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const me = req.user!;
      const params = AcceptParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });

      const [row] = await app.db
        .select({ assignment: assignments, org: organizations })
        .from(assignments)
        .innerJoin(classrooms, eq(assignments.classroomId, classrooms.id))
        .innerJoin(organizations, eq(classrooms.orgId, organizations.id))
        .where(eq(assignments.id, params.data.aid))
        .limit(1);
      if (!row) return reply.code(404).send({ error: "not_found" });

      // L'étudiant doit être rattaché à la classroom (404 indiscernable).
      const [enrolled] = await app.db
        .select({ id: enrollments.id })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.classroomId, row.assignment.classroomId),
            eq(enrollments.userId, me.id),
            eq(enrollments.status, "claimed"),
          ),
        )
        .limit(1);
      if (!enrolled) return reply.code(404).send({ error: "not_found" });

      if (row.assignment.state !== "published") {
        return reply
          .code(409)
          .send({ error: "not_published", message: "This assignment is not open for acceptance" });
      }
      if (!me.githubLogin) {
        return reply
          .code(409)
          .send({ error: "github_not_linked", message: "Link your GitHub account first" });
      }
      if (row.org.installationId === null || !row.assignment.squashedFullName) {
        return reply
          .code(502)
          .send({ error: "not_provisionable", message: "Assignment is not ready — contact your teacher" });
      }

      // Idempotence (GH-20) : une ligne par (assignment, user).
      let [repoRow] = await app.db
        .select()
        .from(studentRepos)
        .where(
          and(
            eq(studentRepos.assignmentId, row.assignment.id),
            eq(studentRepos.userId, me.id),
          ),
        )
        .limit(1);
      if (repoRow && repoRow.provisionStatus === "ok") return repoRow;
      if (!repoRow) {
        await app.db
          .insert(studentRepos)
          .values({ id: randomUUID(), assignmentId: row.assignment.id, userId: me.id })
          .onConflictDoNothing();
        [repoRow] = await app.db
          .select()
          .from(studentRepos)
          .where(
            and(
              eq(studentRepos.assignmentId, row.assignment.id),
              eq(studentRepos.userId, me.id),
            ),
          )
          .limit(1);
      }

      const client = await installationClient(config, row.org.installationId);
      const defaultBranch = row.assignment.branches[0] ?? "main";
      try {
        const result = await provisionStudentRepo({
          octokit: client.octokit,
          token: client.token,
          org: row.org.login,
          squashedRepo: row.assignment.squashedFullName.split("/")[1]!,
          targetRepo: `${row.assignment.slug}-${me.githubLogin}`,
          branches: row.assignment.branches,
          defaultBranch,
          studentLogin: me.githubLogin,
        });
        const [updated] = await app.db
          .update(studentRepos)
          .set({
            githubRepoId: result.repoId,
            fullName: result.fullName,
            defaultBranch: result.defaultBranch,
            provisionStatus: "ok",
            provisionError: null,
            rulesetId: result.rulesetId,
            invitationStatus: result.invitationStatus,
          })
          .where(eq(studentRepos.id, repoRow!.id))
          .returning();
        await audit(app.db, {
          actorUserId: me.id,
          actorType: "user",
          action: "assignment.accept",
          subjectType: "student_repo",
          subjectId: repoRow!.id,
          payload: { repo: result.fullName, invitation: result.invitationStatus },
        });
        publish("repos", [`classroom:${row.assignment.classroomId}`, `user:${me.id}`]);
        return updated;
      } catch (err) {
        req.log.error({ err }, "provisioning failed");
        await app.db
          .update(studentRepos)
          .set({ provisionStatus: "error", provisionError: String(err).slice(0, 500) })
          .where(eq(studentRepos.id, repoRow!.id));
        await audit(app.db, {
          actorUserId: me.id,
          actorType: "system",
          action: "assignment.accept_failed",
          subjectType: "student_repo",
          subjectId: repoRow!.id,
        });
        return reply
          .code(502)
          .send({ error: "provision_failed", message: "Repository provisioning failed — try again" });
      }
    },
  );
}
