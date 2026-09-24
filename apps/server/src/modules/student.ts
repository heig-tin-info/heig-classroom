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
import { cachedRepoLiveState, type RepoLiveState } from "../github/metrics.js";
import { provisionStudentRepo } from "../github/provision.js";
import {
  adoptableBy,
  attachMember,
  claimGroupRepo,
  claimProvisioning,
  groupMemberAccounts,
  markProvisionFailed,
  inviteMembers,
  invitableMembers,
  studentRepoResolver,
  type GroupRow,
  type RepoRow,
} from "../group-repos.js";
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
        await claimEnrollments(app.db, { id: me.id });
      }

      const rooms = await app.db
        .select({
          id: classrooms.id,
          enrollmentId: enrollments.id,
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
              graceMinutes: assignments.graceMinutes,
              gradingMode: assignments.gradingMode,
              gradesValidatedAt: assignments.gradesValidatedAt,
              // ADR-013: drives the Start button. The Browser Exam Keys are
              // deliberately NOT selected — they are secrets.
              workMode: assignments.workMode,
              groupMode: assignments.groupMode,
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

      // My repository per assignment: my own, or my group's (issue #2).
      const enrollmentOf = new Map(rooms.map((r) => [r.id, r.enrollmentId]));
      const resolver = await studentRepoResolver(
        app.db,
        published.map((a) => a.id),
      );
      const repoOf = new Map(
        published.map((a) => [
          a.id,
          resolver.repoOf(a.id, { enrollmentId: enrollmentOf.get(a.classroomId)!, userId: me.id }),
        ]),
      );
      const repos = [...repoOf.values()].filter((r): r is RepoRow => r !== undefined);
      // My groups and who I share them with, for the line under the name.
      const groupOf = new Map(
        published.map((a) => [
          a.id,
          a.groupMode ? resolver.groupOf(a.id, enrollmentOf.get(a.classroomId)!) : null,
        ]),
      );
      const teammates = await groupMemberAccounts(
        app.db,
        [...groupOf.values()].flatMap((g) => (g ? [g.id] : [])),
      );

      // GR-10: indicative grade (current, or frozen as soon as the deadline
      // is applied, GR-12/13).
      const grades = await gradeViewsByIds(
        app,
        repos.flatMap((sr) => [sr.currentGradeRunId, sr.frozenGradeRunId, sr.llmGradeRunId]),
      );

      // Live commit count and check-run breakdown (for the dashboard charts).
      // Cheap here: a student only has a handful of provisioned repositories.
      const live = new Map<string, RepoLiveState | null>();
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
              live.set(
                sr.id,
                await cachedRepoLiveState(client.octokit, installationId, sr.fullName!),
              );
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
          .map(({ groupMode: _groupMode, ...a }) => {
            const repo = repoOf.get(a.id);
            const group = groupOf.get(a.id);
            const frozen = a.state === "locked";
            const gradeRunId = repo
              ? frozen
                ? repo.frozenGradeRunId
                : repo.currentGradeRunId
              : null;
            const state = repo ? live.get(repo.id) : null;
            return {
              ...a,
              group: group
                ? {
                    name: group.name,
                    teammates: teammates
                      .filter(
                        (m) =>
                          m.groupId === group.id &&
                          m.enrollmentId !== enrollmentOf.get(a.classroomId),
                      )
                      .map((m) => `${m.prenom} ${m.nom}`.trim()),
                  }
                : null,
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
                    // The teacher's adjustment stays private until sign-off.
                    teacherPoints: a.gradesValidatedAt ? repo.teacherPoints : null,
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

      const assignment = row.assignment;
      const client = await installationClient(config, row.org.installationId);

      /** The group's repository exists: this acceptance only attaches the member. */
      const joinGroupRepo = async (group: GroupRow, repoRow: RepoRow) => {
        // Dead is dead (issue #10), exactly like an individual repository.
        if (repoRow.deletedAt) return repoRow;
        let attached: Awaited<ReturnType<typeof attachMember>>;
        try {
          attached = await attachMember(
            app.db,
            async () => client.octokit,
            { assignmentId: assignment.id, groupId: group.id, enrollmentId: enrolled.id },
            { actorUserId: me.id, reason: "accept" },
          );
        } catch (err) {
          req.log.error({ err, repo: repoRow.fullName }, "group repository invitation failed");
          return reply.code(502).send({
            error: "invite_failed",
            message: "Could not invite you on your group's repository — try again",
          });
        }
        await audit(app.db, {
          actorUserId: me.id,
          actorType: "user",
          action: "assignment.accept",
          subjectType: "student_repo",
          subjectId: repoRow.id,
          payload: {
            repo: repoRow.fullName,
            group: group.name,
            joined: true,
            invitation: attached?.invitation ?? null,
          },
        });
        publish("repos", [`classroom:${assignment.classroomId}`, `user:${me.id}`]);
        return repoRow;
      };

      let repoRow: RepoRow | undefined;
      let targetRepo = `${assignment.slug}-${me.githubLogin}`;
      let group: GroupRow | null = null;
      if (assignment.groupMode) {
        // Issue #2, lot 2: ONE repository per group, created by the first
        // member to accept, every member invited on it (ADR-014).
        const claim = await claimGroupRepo(app.db, {
          assignment,
          orgLogin: row.org.login,
          enrollmentId: enrolled.id,
          userId: me.id,
        });
        if (claim.kind === "refused") {
          return reply.code(409).send({ error: claim.error, message: claim.message });
        }
        // A lot-1 individual repository: the student keeps working in it.
        if (claim.kind === "individual") return claim.row;
        ({ group, row: repoRow, repoName: targetRepo } = claim);
        if (repoRow.provisionStatus === "ok") return joinGroupRepo(group, repoRow);
      } else {
        // Idempotency (GH-20): one row per (assignment, user).
        const mine = and(
          eq(studentRepos.assignmentId, assignment.id),
          eq(studentRepos.userId, me.id),
          isNull(studentRepos.groupId),
        );
        [repoRow] = await app.db.select().from(studentRepos).where(mine).limit(1);
        if (repoRow && repoRow.provisionStatus === "ok") return repoRow;
        if (!repoRow) {
          await app.db
            .insert(studentRepos)
            .values({ id: randomUUID(), assignmentId: assignment.id, userId: me.id })
            .onConflictDoNothing();
          [repoRow] = await app.db.select().from(studentRepos).where(mine).limit(1);
        }
      }
      const rowId = repoRow!.id;

      // One acceptance provisions a row at a time: two members of a group
      // accepting together (or one student in two tabs) must not both run
      // it, or the loser's failure would overwrite the winner's repository.
      if (!(await claimProvisioning(app.db, rowId, `${row.org.login}/${targetRepo}`))) {
        const [current] = await app.db
          .select()
          .from(studentRepos)
          .where(eq(studentRepos.id, rowId))
          .limit(1);
        if (current?.provisionStatus === "ok") {
          return group ? joinGroupRepo(group, current) : current;
        }
        return reply.code(409).send({
          error: "provision_in_progress",
          message: "The repository is being created — try again in a moment",
        });
      }

      const defaultBranch = assignment.branches[0] ?? "main";
      try {
        const result = await provisionStudentRepo({
          octokit: client.octokit,
          token: client.token,
          org: row.org.login,
          squashedRepo: row.assignment.squashedFullName.split("/")[1]!,
          targetRepo,
          branches: assignment.branches,
          defaultBranch,
          studentLogin: me.githubLogin,
          // ADR-013: read-only in online mode, no invitation at all in exam mode.
          workMode: assignment.workMode,
          // A group never adopts a repository another row already records.
          ...(group ? { canAdopt: (id: number) => adoptableBy(app.db, rowId, id) } : {}),
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
          .where(eq(studentRepos.id, rowId))
          .returning();

        // The rest of the group gets access right away, not at their own
        // acceptance: whoever accepts first opens the repository for all.
        // Best effort per member — their own acceptance re-invites them.
        const others = group
          ? (await invitableMembers(app.db, assignment.id, group.id)).filter(
              (m) => m.userId !== me.id,
            )
          : [];
        const { invited, failed } = await inviteMembers(app.db, client.octokit, updated!, others, {
          actorUserId: me.id,
          reason: "group_repo_created",
        });
        if (failed.length > 0) {
          req.log.warn({ repo: result.fullName, failed }, "group members not invited");
        }
        const newcomers = others.filter((m) => invited.includes(m.githubLogin));

        await audit(app.db, {
          actorUserId: me.id,
          actorType: "user",
          action: "assignment.accept",
          subjectType: "student_repo",
          subjectId: rowId,
          // `protected: false` = plan without rulesets, the repository is
          // provisioned but not shielded from force-push (degraded mode H8).
          payload: {
            repo: result.fullName,
            invitation: result.invitationStatus,
            protected: result.rulesetId !== null,
            ...(group ? { group: group.name, invited, failed } : {}),
          },
        });
        publish(
          "repos",
          [
            `classroom:${assignment.classroomId}`,
            `user:${me.id}`,
            ...newcomers.map((m) => `user:${m.userId}` as const),
          ],
          {
            kind: "assignment_accepted",
            message: `${me.givenName} ${me.familyName} accepted “${assignment.name}”`.trim(),
          },
        );
        // Repo confirmation: the GitHub invitation must still be accepted —
        // by every member who was just invited, not only by the acceptor.
        for (const userId of [me.id, ...newcomers.map((m) => m.userId)]) {
          const recipient = userId === me.id ? me : await mailRecipient(app, userId);
          if (!recipient) continue;
          await queueEmail(app, config, recipient, "repo.invitation", {
            assignmentName: assignment.name,
            classroomName: row.classroomName,
            repoFullName: result.fullName,
          });
        }
        return updated;
      } catch (err) {
        req.log.error({ err }, "provisioning failed");
        await markProvisionFailed(app.db, rowId, String(err));
        await audit(app.db, {
          actorUserId: me.id,
          actorType: "system",
          action: "assignment.accept_failed",
          subjectType: "student_repo",
          subjectId: rowId,
        });
        // The teacher can often fix the cause (permissions, quota, template).
        const teacher = await mailRecipient(app, row.teacherId);
        if (teacher) {
          await queueEmail(app, config, teacher, "provision.error", {
            assignmentName: assignment.name,
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
