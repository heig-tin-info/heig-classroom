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
import { fetchRepoLiveState } from "../github/metrics.js";
import { provisionStudentRepo } from "../github/provision.js";
import { gradeViewsByIds } from "../grading.js";
import { mailRecipient, queueEmail } from "../mailer.js";
import { claimEnrollments } from "./roster.js";

/**
 * Student view and actions: attached classrooms, published assignments,
 * acceptance with repository provisioning (GH-20..25). Loading first
 * attempts a claim (AU-18): an entry added during an active session is
 * attached without a re-login.
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

      // GR-10: indicative grade (current, or frozen as soon as the deadline
      // is applied, GR-12/13).
      const grades = await gradeViewsByIds(
        app,
        repos.flatMap((sr) => [sr.currentGradeRunId, sr.frozenGradeRunId, sr.llmGradeRunId]),
      );

      // Live commit count and check-run breakdown (for the dashboard charts).
      // Cheap here: a student only has a handful of provisioned repositories.
      const live = new Map<string, Awaited<ReturnType<typeof fetchRepoLiveState>>>();
      const provisioned = repos.filter((sr) => sr.provisionStatus === "ok" && sr.fullName);
      if (provisioned.length > 0) {
        const clients = new Map<number, Awaited<ReturnType<typeof installationClient>>>();
        const orgByRoom = new Map(
          await app.db
            .select({ classroomId: classrooms.id, installationId: organizations.installationId })
            .from(classrooms)
            .innerJoin(organizations, eq(classrooms.orgId, organizations.id))
            .where(inArray(classrooms.id, roomIds))
            .then((rows) => rows.map((x) => [x.classroomId, x.installationId] as const)),
        );
        await Promise.all(
          provisioned.map(async (sr) => {
            // Best effort: a student's dashboard must render even if GitHub is
            // unreachable or the App is unavailable (falls back to cached ci).
            try {
              const a = published.find((x) => x.id === sr.assignmentId);
              const installationId = a ? orgByRoom.get(a.classroomId) : null;
              if (!installationId) return;
              let client = clients.get(installationId);
              if (!client) {
                client = await installationClient(config, installationId);
                clients.set(installationId, client);
              }
              live.set(sr.id, await fetchRepoLiveState(client.octokit, sr.fullName!));
            } catch (err) {
              req.log.warn({ err, repo: sr.fullName }, "student live state fetch failed");
            }
          }),
        );
      }

      return rooms.map((r) => ({
        id: r.id,
        name: r.name,
        orgLogin: r.orgLogin,
        teacher: `${r.teacher} ${r.teacherFamily}`.trim(),
        assignments: published
          .filter((a) => a.classroomId === r.id)
          .map((a) => {
            const repo = repos.find((sr) => sr.assignmentId === a.id);
            const frozen = a.state === "locked";
            const gradeRunId = repo
              ? frozen
                ? repo.frozenGradeRunId
                : repo.currentGradeRunId
              : null;
            const state = repo ? live.get(repo.id) : null;
            return {
              ...a,
              repo: repo
                ? {
                    fullName: repo.fullName,
                    provisionStatus: repo.provisionStatus,
                    invitationStatus: repo.invitationStatus,
                    ciStatus: state?.ciStatus ?? repo.ciStatus,
                    lockedAt: repo.lockedAt?.toISOString() ?? null,
                    commitCount: state?.commitCount ?? null,
                    checksPassed: state?.checksPassed ?? null,
                    checksTotal: state?.checksTotal ?? null,
                    grade: gradeRunId ? (grades.get(gradeRunId) ?? null) : null,
                    // GR-16: authoritative review of the frozen commit, when it
                    // has come back from the dispatched llm-review run.
                    llmGrade: repo.llmGradeRunId
                      ? (grades.get(repo.llmGradeRunId) ?? null)
                      : null,
                    gradeFrozen: frozen,
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
        .select({
          assignment: assignments,
          org: organizations,
          classroomName: classrooms.name,
          teacherId: classrooms.teacherId,
        })
        .from(assignments)
        .innerJoin(classrooms, eq(assignments.classroomId, classrooms.id))
        .innerJoin(organizations, eq(classrooms.orgId, organizations.id))
        .where(eq(assignments.id, params.data.aid))
        .limit(1);
      if (!row) return reply.code(404).send({ error: "not_found" });

      // The student must be attached to the classroom (indistinguishable 404).
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

      // Idempotency (GH-20): one row per (assignment, user).
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
        publish("repos", [`classroom:${row.assignment.classroomId}`, `user:${me.id}`], {
          kind: "assignment_accepted",
          message: `${me.givenName} ${me.familyName} accepted “${row.assignment.name}”`.trim(),
        });
        // Repo confirmation: the GitHub invitation must still be accepted.
        await queueEmail(app, config, me, "repo.invitation", {
          assignmentName: row.assignment.name,
          classroomName: row.classroomName,
          repoFullName: result.fullName,
        });
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
        // The teacher can often fix the cause (permissions, quota, template).
        const teacher = await mailRecipient(app, row.teacherId);
        if (teacher) {
          await queueEmail(app, config, teacher, "provision.error", {
            assignmentName: row.assignment.name,
            classroomName: row.classroomName,
            detail: `${me.givenName} ${me.familyName}`.trim() || me.email,
          });
        }
        return reply
          .code(502)
          .send({ error: "provision_failed", message: "Repository provisioning failed — try again" });
      }
    },
  );
}
