/** Assignment lifecycle: list, create, patch (incl. reopen), publish, archive, delete. */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";

import { audit } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import {
  assignmentMilestones,
  assignments,
  gradeDispatches,
  gradeRuns,
  studentRepos,
} from "../../db/schema.js";
import { publish } from "../../events.js";
import { installationClient } from "../../github/app.js";
import { unlockStudentRepo } from "../../github/lock.js";
import { zurichIso } from "../../github/commit.js";
import { createSquashedRepo } from "../../github/squash.js";
import { selectGradeRun } from "../../grading.js";
import { classroomRecipients, queueEmail } from "../../mailer.js";
import { ownedAssignment, ownedClassroomWithOrg, teacherGuard } from "../guards.js";
import { resolveOffset } from "./milestones.js";
import { clientFor } from "./shared.js";

/** Manual mode: 15 min to 400 days after publication. */
const Duration = z.number().int().min(15).max(400 * 1440);

const AssignmentCreate = z
  .object({
    name: z.string().min(1).max(200),
    sourceRepo: z.string().min(1).max(200),
    publishMode: z.enum(["scheduled", "manual"]).default("manual"),
    startAt: z.coerce.date().optional(),
    deadlineAt: z.coerce.date().optional(),
    durationMinutes: Duration.optional(),
    graceMinutes: z.number().int().min(0).max(1440).default(30),
    sourceStrategy: z.enum(["whole", "squash"]).default("squash"),
    deadlineStrategy: z.enum(["lock", "commit"]).default("lock"),
    gradingMode: z.enum(["none", "auto"]).default("auto"),
    branches: z.array(z.string().min(1)).min(1).max(10).optional(),
    protectedFiles: z.array(z.string().min(1).max(300)).max(50).default([]),
  })
  .superRefine((b, ctx) => {
    if (b.publishMode === "scheduled") {
      // Auto-publication at startAt: both dates are absolute and required.
      if (!b.startAt || !b.deadlineAt) {
        ctx.addIssue({ code: "custom", message: "Scheduled publication needs a start and a deadline" });
      } else if (b.deadlineAt <= b.startAt) {
        ctx.addIssue({ code: "custom", message: "Deadline must be after the start date" });
      }
      if (b.durationMinutes !== undefined) {
        ctx.addIssue({ code: "custom", message: "A duration only applies to manual publication" });
      }
    } else if ((b.deadlineAt == null) === (b.durationMinutes == null)) {
      // Manual: the deadline is either an absolute date or a duration, not both.
      ctx.addIssue({ code: "custom", message: "Manual publication needs a deadline date or a duration" });
    }
  });

/** Milestones authored as J±n follow the deadline: re-resolve the ones not
    dispatched yet (a fired milestone is history, its date stays). */
async function retargetOffsetMilestones(
  app: FastifyInstance,
  assignmentId: string,
  deadlineAt: Date,
) {
  const offsets = await app.db
    .select()
    .from(assignmentMilestones)
    .where(
      and(
        eq(assignmentMilestones.assignmentId, assignmentId),
        isNotNull(assignmentMilestones.offsetDays),
        isNull(assignmentMilestones.dispatchedAt),
      ),
    );
  for (const m of offsets) {
    await app.db
      .update(assignmentMilestones)
      .set({ dueAt: resolveOffset(deadlineAt, m.offsetDays!) })
      .where(eq(assignmentMilestones.id, m.id));
  }
}

function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function assignmentLifecycleRoutes(
  app: FastifyInstance,
  opts: { config: AppConfig },
) {
  const { config } = opts;
  const requireTeacher = teacherGuard(app);

  // --- Assignments ---
  app.get(
    "/app/api/classrooms/:id/assignments",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedClassroomWithOrg(app, req, reply);
      if (!owned) return reply;
      // ?archived=1 lists the archive instead of the active assignments.
      const archived = (req.query as { archived?: string }).archived === "1";
      return app.db
        .select()
        .from(assignments)
        .where(
          and(
            eq(assignments.classroomId, owned.room.id),
            archived ? isNotNull(assignments.archivedAt) : isNull(assignments.archivedAt),
          ),
        )
        .orderBy(desc(assignments.createdAt));
    },
  );

  const AssignmentPatch = z
    .object({
      name: z.string().min(1).max(200).optional(),
      publishMode: z.enum(["scheduled", "manual"]).optional(),
      startAt: z.coerce.date().optional(),
      deadlineAt: z.coerce.date().optional(),
      durationMinutes: Duration.nullable().optional(),
      graceMinutes: z.number().int().min(0).max(1440).optional(),
      deadlineStrategy: z.enum(["lock", "commit"]).optional(),
      gradingMode: z.enum(["none", "auto"]).optional(),
      protectedFiles: z.array(z.string().min(1).max(300)).max(100).optional(),
    })
    .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" });

  app.patch(
    "/app/api/classrooms/:id/assignments/:aid",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedAssignment(app, req, reply);
      if (!owned) return reply;
      const body = AssignmentPatch.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: "validation", issues: body.error.issues });
      }
      // The two strategies are exclusive and fixed at publication (GH-42).
      // Re-sending the current value is fine: the edit form always posts it.
      if (
        owned.assignment.state !== "draft" &&
        body.data.deadlineStrategy &&
        body.data.deadlineStrategy !== owned.assignment.deadlineStrategy
      ) {
        return reply.code(409).send({
          error: "strategy_frozen",
          message: "The deadline strategy cannot be changed after publication",
        });
      }
      // Publication mode only matters before going live; freeze it after.
      if (
        owned.assignment.state !== "draft" &&
        ((body.data.publishMode && body.data.publishMode !== owned.assignment.publishMode) ||
          (body.data.durationMinutes !== undefined &&
            body.data.durationMinutes !== owned.assignment.durationMinutes))
      ) {
        return reply.code(409).send({
          error: "publish_mode_frozen",
          message: "The publication mode cannot be changed after publication",
        });
      }
      const patch = { ...body.data };
      // A duration on a draft keeps a provisional deadline (now + duration)
      // so lists and the timeline stay meaningful; Publish recomputes it.
      if (patch.durationMinutes != null && owned.assignment.state === "draft") {
        patch.deadlineAt = new Date(Date.now() + patch.durationMinutes * 60_000);
      }
      const nextStart = patch.startAt ?? owned.assignment.startAt;
      const nextDeadline = patch.deadlineAt ?? owned.assignment.deadlineAt;
      if (nextDeadline <= nextStart) {
        return reply
          .code(400)
          .send({ error: "validation", message: "Deadline must be after the start date" });
      }
      const [updated] = await app.db
        .update(assignments)
        .set(patch)
        .where(eq(assignments.id, owned.assignment.id))
        .returning();
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "assignment.update",
        subjectType: "assignment",
        subjectId: owned.assignment.id,
        payload: body.data,
      });

      if (updated && patch.deadlineAt) {
        await retargetOffsetMilestones(app, updated.id, updated.deadlineAt);
      }

      // Rescheduling (US-08, GH-43): pushing back the deadline of an already
      // expired assignment reopens it; repositories are unlocked (lock
      // strategy) and markers are reset; the ticker will reapply at the new
      // deadline. Repositories archived in degraded mode (H8) stay archived.
      if (
        updated &&
        owned.assignment.deadlineAppliedAt &&
        updated.deadlineAt.getTime() > Date.now()
      ) {
        if (updated.deadlineStrategy === "lock" && owned.org.installationId !== null) {
          const lockedRepos = await app.db
            .select()
            .from(studentRepos)
            .where(
              and(eq(studentRepos.assignmentId, updated.id), isNotNull(studentRepos.lockedAt)),
            );
          if (lockedRepos.length > 0) {
            const client = await installationClient(config, owned.org.installationId);
            for (const repo of lockedRepos) {
              const [orgLogin, repoName] = repo.fullName!.split("/") as [string, string];
              try {
                await unlockStudentRepo(client.octokit, orgLogin, repoName);
                await app.db
                  .update(studentRepos)
                  .set({ lockedAt: null, rulesetId: null })
                  .where(eq(studentRepos.id, repo.id));
              } catch (err) {
                req.log.error({ err, repo: repo.fullName }, "reopen: unlock failed");
              }
            }
          }
        }
        await app.db
          .update(assignments)
          .set({
            state: "published",
            deadlineAppliedAt: null,
            frozenAt: null,
            llmDispatchedAt: null,
            // Re-arm the J-1 email reminder for the new deadline.
            reminderSentAt: null,
          })
          .where(eq(assignments.id, updated.id));
        // The provisional freeze no longer makes sense: it will be set again at
        // the new deadline. Same for the LLM review (GR-16): it graded the old
        // frozen commit, and the dispatch ledger must forget the old round or
        // the new freeze would be claimed as already dispatched.
        await app.db
          .update(studentRepos)
          .set({ frozenGradeRunId: null, llmGradeRunId: null })
          .where(eq(studentRepos.assignmentId, updated.id));
        await app.db.delete(gradeDispatches).where(
          and(
            eq(gradeDispatches.trigger, "deadline"),
            inArray(
              gradeDispatches.studentRepoId,
              app.db
                .select({ id: studentRepos.id })
                .from(studentRepos)
                .where(eq(studentRepos.assignmentId, updated.id)),
            ),
          ),
        );
        // Requalify captured runs (GR-14): every run already in the database
        // was necessarily received before the NEW (future) deadline, so the
        // after-deadline flag no longer holds — including runs that got the
        // conservative GR-14.3 treatment when their receipt was unknown.
        // Then recompute each repository's current grade selection.
        await app.db
          .update(gradeRuns)
          .set({ afterDeadline: false })
          .where(
            inArray(
              gradeRuns.studentRepoId,
              app.db
                .select({ id: studentRepos.id })
                .from(studentRepos)
                .where(eq(studentRepos.assignmentId, updated.id)),
            ),
          );
        const reposToRefresh = await app.db
          .select({ id: studentRepos.id })
          .from(studentRepos)
          .where(eq(studentRepos.assignmentId, updated.id));
        for (const repo of reposToRefresh) {
          const selected = await selectGradeRun(app, repo.id);
          await app.db
            .update(studentRepos)
            .set({ currentGradeRunId: selected })
            .where(eq(studentRepos.id, repo.id));
        }
        await audit(app.db, {
          actorUserId: req.user!.id,
          actorType: "user",
          action: "assignment.deadline_reopened",
          subjectType: "assignment",
          subjectId: updated.id,
          payload: { deadlineAt: updated.deadlineAt },
        });
        publish("assignments", [`classroom:${updated.classroomId}`]);
        return { ...updated, state: "published", deadlineAppliedAt: null, frozenAt: null };
      }
      return updated;
    },
  );

  app.post(
    "/app/api/classrooms/:id/assignments/:aid/publish",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedAssignment(app, req, reply);
      if (!owned) return reply;
      if (owned.assignment.state !== "draft") {
        return reply
          .code(409)
          .send({ error: "not_draft", message: "Only draft assignments can be published" });
      }
      // Manual mode: the countdown starts NOW — start = publication instant,
      // deadline = stored absolute date or now + duration. Scheduled drafts
      // published early keep their absolute dates.
      const now = new Date();
      const a = owned.assignment;
      const startAt = a.publishMode === "manual" ? now : a.startAt;
      const deadlineAt =
        a.publishMode === "manual" && a.durationMinutes != null
          ? new Date(now.getTime() + a.durationMinutes * 60_000)
          : a.deadlineAt;
      if (deadlineAt <= now) {
        return reply
          .code(400)
          .send({ error: "deadline_past", message: "Deadline is in the past" });
      }
      const [updated] = await app.db
        .update(assignments)
        .set({ state: "published", startAt, deadlineAt })
        .where(eq(assignments.id, a.id))
        .returning();
      if (deadlineAt.getTime() !== a.deadlineAt.getTime()) {
        await retargetOffsetMilestones(app, a.id, deadlineAt);
      }
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "assignment.publish",
        subjectType: "assignment",
        subjectId: a.id,
        payload: { startAt, deadlineAt },
      });
      // Announce to every claimed student (their preference filters).
      for (const student of await classroomRecipients(app, a.classroomId)) {
        await queueEmail(app, config, student, "assignment.published", {
          assignmentName: a.name,
          classroomName: owned.classroomName,
          deadlineAt: zurichIso(deadlineAt),
        });
      }
      return updated;
    },
  );

  app.post(
    "/app/api/classrooms/:id/assignments/:aid/archive",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedAssignment(app, req, reply);
      if (!owned) return reply;
      const [updated] = await app.db
        .update(assignments)
        .set({ archivedAt: new Date() })
        .where(eq(assignments.id, owned.assignment.id))
        .returning();
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "assignment.archive",
        subjectType: "assignment",
        subjectId: owned.assignment.id,
      });
      return updated;
    },
  );

  app.post(
    "/app/api/classrooms/:id/assignments/:aid/unarchive",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedAssignment(app, req, reply);
      if (!owned) return reply;
      const [updated] = await app.db
        .update(assignments)
        .set({ archivedAt: null })
        .where(eq(assignments.id, owned.assignment.id))
        .returning();
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "assignment.unarchive",
        subjectType: "assignment",
        subjectId: owned.assignment.id,
      });
      return updated;
    },
  );

  app.delete(
    "/app/api/classrooms/:id/assignments/:aid",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedAssignment(app, req, reply);
      if (!owned) return reply;
      if (owned.assignment.state !== "draft") {
        return reply
          .code(409)
          .send({ error: "not_draft", message: "Only draft assignments can be deleted" });
      }
      // The squashed repository is deleted with the draft (no student repository exists).
      if (owned.assignment.squashedFullName) {
        const client = await clientFor(config, reply, owned.org);
        if (!client) return reply;
        const [, repo] = owned.assignment.squashedFullName.split("/");
        await client.octokit
          .request("DELETE /repos/{owner}/{repo}", { owner: owned.org.login, repo: repo! })
          .catch((err) => req.log.warn({ err }, "squashed deletion failed"));
      }
      await app.db.delete(assignments).where(eq(assignments.id, owned.assignment.id));
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "assignment.delete",
        subjectType: "assignment",
        subjectId: owned.assignment.id,
        payload: { name: owned.assignment.name, squashed: owned.assignment.squashedFullName },
      });
      return reply.code(204).send();
    },
  );

  app.post(
    "/app/api/classrooms/:id/assignments",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedClassroomWithOrg(app, req, reply);
      if (!owned) return reply;
      const body = AssignmentCreate.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: "validation", issues: body.error.issues });
      }
      const client = await clientFor(config, reply, owned.org);
      if (!client) return reply;

      // The source repository must exist in the organization (GH-10).
      let source;
      try {
        const res = await client.octokit.request("GET /repos/{owner}/{repo}", {
          owner: owned.org.login,
          repo: body.data.sourceRepo,
          request: { retries: 0 },
        });
        source = res.data;
      } catch (err) {
        if ((err as { status?: number }).status === 404) {
          return reply.code(400).send({
            error: "source_not_found",
            message: `Repository ${body.data.sourceRepo} not found in ${owned.org.login}`,
          });
        }
        throw err;
      }

      const slug = slugify(body.data.name);
      if (!slug) {
        return reply.code(400).send({ error: "validation", message: "Name contains no usable characters" });
      }
      const branches = body.data.branches ?? [source.default_branch];

      // Squashed repository created when the assignment is created (GH-11/12);
      // synchronous for this slice (a few seconds), jobs in M3.
      // Slugs are only unique per classroom while the repo lives at the org
      // level: on a name collision (422 on a non-empty repo, e.g. the same
      // assignment in another classroom or a leftover from a failed delete),
      // retry with a numeric suffix. The real name lands in squashedFullName.
      let squashed;
      let targetRepo = `${slug}-squashed`;
      try {
        for (let attempt = 2; ; attempt++) {
          try {
            squashed = await createSquashedRepo({
              octokit: client.octokit,
              token: client.token,
              org: owned.org.login,
              sourceRepo: source.name,
              targetRepo,
              strategy: body.data.sourceStrategy,
              branches,
            });
            break;
          } catch (err) {
            if ((err as { status?: number }).status !== 422 || attempt > 5) throw err;
            req.log.info({ targetRepo }, "squashed name taken, retrying with suffix");
            targetRepo = `${slug}-squashed-${attempt}`;
          }
        }
      } catch (err) {
        req.log.error({ err }, "squashed repository creation failed");
        const status = (err as { status?: number }).status;
        return reply.code(status === 422 ? 409 : 502).send({
          error: "squashed_failed",
          message:
            status === 422
              ? `Repositories ${slug}-squashed through -5 all exist in the organization`
              : "Could not create the squashed repository — try again",
        });
      }

      // Manual drafts store provisional dates (start = creation, deadline =
      // stored date or creation + duration): the Publish action recomputes
      // them so the countdown starts at publication.
      const createdAt = new Date();
      const startAt = body.data.publishMode === "scheduled" ? body.data.startAt! : createdAt;
      const deadlineAt =
        body.data.durationMinutes != null
          ? new Date(createdAt.getTime() + body.data.durationMinutes * 60_000)
          : body.data.deadlineAt!;

      try {
        const [row] = await app.db
          .insert(assignments)
          .values({
            id: randomUUID(),
            classroomId: owned.room.id,
            name: body.data.name,
            slug,
            publishMode: body.data.publishMode,
            durationMinutes: body.data.durationMinutes ?? null,
            startAt,
            deadlineAt,
            graceMinutes: body.data.graceMinutes,
            sourceRepoId: source.id,
            sourceFullName: source.full_name,
            squashedRepoId: squashed.repoId,
            squashedFullName: squashed.fullName,
            sourceStrategy: body.data.sourceStrategy,
            deadlineStrategy: body.data.deadlineStrategy,
            gradingMode: body.data.gradingMode,
            branches,
            protectedFiles: body.data.protectedFiles,
          })
          .returning();
        await audit(app.db, {
          actorUserId: req.user!.id,
          actorType: "user",
          action: "assignment.create",
          subjectType: "assignment",
          subjectId: row!.id,
          payload: { slug, source: source.full_name, squashed: squashed.fullName },
        });
        return reply.code(201).send(row);
      } catch (err) {
        // UNIQUE(classroom_id, slug): name already taken; the squashed repo
        // was just created for nothing, delete it to stay replayable.
        await client.octokit
          .request("DELETE /repos/{owner}/{repo}", {
            owner: owned.org.login,
            repo: targetRepo,
          })
          .catch(() => {});
        return reply.code(409).send({
          error: "duplicate_slug",
          message: `An assignment “${slug}” already exists in this classroom`,
        });
      }
    },
  );
}
