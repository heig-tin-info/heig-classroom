/**
 * Online workspace routes (ADR-013).
 *
 * - `GET /app/codespace/start/:aid` — the student's Start button. A plain
 *   navigable GET on purpose: the portal hands this very URL to Safe Exam
 *   Browser as the exam `startURL`, and SEB can only navigate. It checks the
 *   student is enrolled, has accepted (repository provisioned), that the
 *   assignment is published and in an online mode, mints a five-minute
 *   `LaunchTokenClaims` and 303s to the portal.
 * - `POST /app/api/classrooms/:id/assignments/:aid/codespace-sync` — the
 *   teacher's Resync button; re-queues the pg-boss job.
 *
 * Every route answers 404 when `CODESPACE_URL` is empty: without the portal
 * the feature does not exist.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { LaunchTokenClaims } from "@hgc/contracts";
import { signHs256 } from "@hgc/domain";

import { audit } from "../audit.js";
import { codespaceConfigured, isOnlineMode, queueCodespaceSync } from "../codespace.js";
import type { AppConfig } from "../config.js";
import { assignments, classrooms, enrollments, studentRepos } from "../db/schema.js";
import { accessibleAssignment, teacherGuard } from "./guards.js";

/** A launch token is consumed within seconds; five minutes covers a slow hop. */
const LAUNCH_TOKEN_TTL_SECONDS = 300;

export async function codespacePlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const requireTeacher = teacherGuard(app);

  const AssignmentParam = z.object({ aid: z.uuid() });

  app.get("/app/codespace/start/:aid", async (req, reply) => {
    if (!codespaceConfigured(config)) return reply.code(404).send({ error: "not_found" });

    // Navigable route: an anonymous visitor (or an expired session, or SEB
    // opening the startURL cold) is sent through the IdP and comes back here.
    if (!req.user) {
      const returnTo = encodeURIComponent(req.url);
      return reply.redirect(`/app/auth/login?returnTo=${returnTo}`, 303);
    }
    const params = AssignmentParam.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const me = req.user;

    const [row] = await app.db
      .select({ assignment: assignments, classroomId: classrooms.id })
      .from(assignments)
      .innerJoin(classrooms, eq(assignments.classroomId, classrooms.id))
      .where(eq(assignments.id, params.data.aid))
      .limit(1);
    if (!row) return reply.code(404).send({ error: "not_found" });
    const a = row.assignment;

    // Not enrolled: indistinguishable from a missing assignment (AU-23/24).
    const [enrolled] = await app.db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.classroomId, a.classroomId),
          eq(enrollments.userId, me.id),
          eq(enrollments.status, "claimed"),
        ),
      )
      .limit(1);
    if (!enrolled) return reply.code(404).send({ error: "not_found" });

    // A `free` assignment has no portal counterpart at all.
    if (!isOnlineMode(a.workMode)) {
      return reply
        .code(409)
        .send({ error: "not_online", message: "This assignment does not use the online workspace" });
    }
    if (a.state !== "published") {
      return reply
        .code(409)
        .send({ error: "not_published", message: "This assignment is not open" });
    }

    const [repo] = await app.db
      .select()
      .from(studentRepos)
      .where(and(eq(studentRepos.assignmentId, a.id), eq(studentRepos.userId, me.id)))
      .limit(1);
    if (!repo || repo.provisionStatus !== "ok" || !repo.fullName) {
      return reply
        .code(409)
        .send({ error: "not_accepted", message: "Accept the assignment first" });
    }

    const iat = Math.floor(Date.now() / 1000);
    const jti = randomUUID();
    const claims: LaunchTokenClaims = {
      iss: "heig-classroom",
      aud: "heig-codespace",
      iat,
      exp: iat + LAUNCH_TOKEN_TTL_SECONDS,
      jti,
      sub: me.id,
      email: me.email,
      displayName: `${me.givenName} ${me.familyName}`.trim() || me.email,
      githubLogin: me.githubLogin,
      assignmentId: a.id,
      repo: { fullName: repo.fullName, defaultBranch: repo.defaultBranch ?? a.branches[0] ?? "main" },
    };
    const token = await signHs256(
      { ...claims } as Record<string, unknown>,
      config.CODESPACE_LAUNCH_SECRET,
    );
    // The `jti` identifies the launch in both logs; the token itself is a
    // bearer credential and never reaches the audit log (AU-41).
    await audit(app.db, {
      actorUserId: me.id,
      actorType: "user",
      action: "codespace.launch_issued",
      subjectType: "assignment",
      subjectId: a.id,
      payload: { jti, mode: a.workMode, repo: repo.fullName },
    });
    return reply.redirect(
      `${config.CODESPACE_URL}/launch?token=${encodeURIComponent(token)}`,
      303,
    );
  });

  // --- Teacher: force a re-push of the assignment to the portal ---
  app.post(
    "/app/api/classrooms/:id/assignments/:aid/codespace-sync",
    { preHandler: requireTeacher },
    async (req, reply) => {
      if (!codespaceConfigured(config)) return reply.code(404).send({ error: "not_found" });
      const scope = await accessibleAssignment(app, req, reply);
      if (!scope) return reply;
      if (!isOnlineMode(scope.assignment.workMode)) {
        return reply.code(409).send({
          error: "not_online",
          message: "This assignment does not use the online workspace",
        });
      }
      if (!app.boss) {
        return reply
          .code(503)
          .send({ error: "jobs_down", message: "The job queue is not running" });
      }
      await queueCodespaceSync(app, scope.assignment.id);
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "codespace.sync_requested",
        subjectType: "assignment",
        subjectId: scope.assignment.id,
      });
      return reply.code(202).send({ ok: true });
    },
  );
}
