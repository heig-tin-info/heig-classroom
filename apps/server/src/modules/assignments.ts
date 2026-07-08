import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";

import { audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import {
  assignments,
  classrooms,
  enrollments,
  organizations,
  studentRepos,
  users,
} from "../db/schema.js";
import { publish } from "../events.js";
import { installationClient } from "../github/app.js";
import { lockStudentRepo, unlockStudentRepo } from "../github/lock.js";
import { fetchRepoLiveState, type RepoLiveState } from "../github/metrics.js";
import { createSquashedRepo } from "../github/squash.js";

const IdParam = z.object({ id: z.uuid() });

const AssignmentCreate = z
  .object({
    name: z.string().min(1).max(200),
    sourceRepo: z.string().min(1).max(200),
    startAt: z.coerce.date(),
    deadlineAt: z.coerce.date(),
    graceMinutes: z.number().int().min(0).max(1440).default(30),
    sourceStrategy: z.enum(["whole", "squash"]).default("squash"),
    deadlineStrategy: z.enum(["lock", "commit"]).default("lock"),
    branches: z.array(z.string().min(1)).min(1).max(10).optional(),
    protectedFiles: z.array(z.string().min(1).max(300)).max(50).default([]),
  })
  .refine((b) => b.deadlineAt > b.startAt, {
    message: "Deadline must be after the start date",
  });

/** Fichiers pré-cochés comme protégés s'ils existent dans le source (GH-30). */
const PROTECTED_CANDIDATES = ["criteria.yml", "README.md", ".github/workflows/grading.yml"];

function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function assignmentsPlugin(
  app: FastifyInstance,
  opts: { config: AppConfig },
) {
  const { config } = opts;

  const requireTeacher = async (req: FastifyRequest, reply: FastifyReply) => {
    const denied = await app.requireSession(req, reply);
    if (denied) return denied;
    if (req.user!.role !== "teacher" && req.user!.role !== "admin") {
      return reply.code(403).send({ error: "forbidden" });
    }
    return undefined;
  };

  /** Classroom + organisation, si et seulement si le teacher la possède. */
  async function ownedClassroomWithOrg(req: FastifyRequest, reply: FastifyReply) {
    const params = IdParam.safeParse(req.params);
    if (!params.success) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    const [row] = await app.db
      .select({ room: classrooms, org: organizations })
      .from(classrooms)
      .innerJoin(organizations, eq(classrooms.orgId, organizations.id))
      .where(and(eq(classrooms.id, params.data.id), eq(classrooms.teacherId, req.user!.id)))
      .limit(1);
    if (!row) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    return row;
  }

  async function clientFor(
    reply: FastifyReply,
    org: { installationId: number | null; login: string },
  ) {
    if (org.installationId === null) {
      await reply.code(409).send({
        error: "app_not_installed",
        message: `GitHub App is not installed on ${org.login}`,
      });
      return null;
    }
    return installationClient(config, org.installationId);
  }

  // --- Picker : dépôts de l'organisation ---
  app.get(
    "/app/api/classrooms/:id/org-repos",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedClassroomWithOrg(req, reply);
      if (!owned) return reply;
      const client = await clientFor(reply, owned.org);
      if (!client) return reply;
      const { data } = await client.octokit.request("GET /orgs/{org}/repos", {
        org: owned.org.login,
        sort: "pushed",
        direction: "desc",
        per_page: 100,
      });
      // Les dépôts générés par la plateforme (squashed, et plus tard les
      // dépôts étudiants) ne sont pas des sources d'assignment.
      return data
        .filter((r) => !r.archived && !r.name.endsWith("-squashed"))
        .map((r) => ({
          name: r.name,
          defaultBranch: r.default_branch,
          private: r.private,
          pushedAt: r.pushed_at,
        }));
    },
  );

  // --- Exploration d'un dépôt source : branches, tête, arborescence ---
  app.get(
    "/app/api/classrooms/:id/org-repos/:repo/tree",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedClassroomWithOrg(req, reply);
      if (!owned) return reply;
      const client = await clientFor(reply, owned.org);
      if (!client) return reply;
      const repo = z.string().min(1).max(200).parse((req.params as { repo: string }).repo);
      const owner = owned.org.login;
      let repoData;
      try {
        const res = await client.octokit.request("GET /repos/{owner}/{repo}", {
          owner,
          repo,
          request: { retries: 0 },
        });
        repoData = res.data;
      } catch (err) {
        if ((err as { status?: number }).status === 404) {
          return reply.code(404).send({ error: "repo_not_found", message: "Repository not found" });
        }
        throw err;
      }
      const [{ data: branches }, { data: head }] = await Promise.all([
        client.octokit.request("GET /repos/{owner}/{repo}/branches", {
          owner,
          repo,
          per_page: 100,
        }),
        client.octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
          owner,
          repo,
          ref: repoData.default_branch,
        }),
      ]);
      const { data: tree } = await client.octokit.request(
        "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
        { owner, repo, tree_sha: head.sha, recursive: "1" },
      );
      const MAX_ENTRIES = 800;
      const entries = tree.tree
        .filter((e) => e.path && (e.type === "blob" || e.type === "tree"))
        .slice(0, MAX_ENTRIES)
        .map((e) => ({ path: e.path!, type: e.type as "blob" | "tree" }));
      const files = new Set(entries.filter((e) => e.type === "blob").map((e) => e.path));
      return {
        name: repoData.name,
        repoId: repoData.id,
        defaultBranch: repoData.default_branch,
        branches: branches.map((b) => b.name),
        headSha: head.sha,
        headDate: head.commit.committer?.date ?? head.commit.author?.date ?? null,
        pushedAt: repoData.pushed_at,
        tree: entries,
        truncated: tree.truncated || tree.tree.length > MAX_ENTRIES,
        suggestedProtected: PROTECTED_CANDIDATES.filter((p) => files.has(p)),
      };
    },
  );

  // --- Assignments ---
  app.get(
    "/app/api/classrooms/:id/assignments",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedClassroomWithOrg(req, reply);
      if (!owned) return reply;
      return app.db
        .select()
        .from(assignments)
        .where(and(eq(assignments.classroomId, owned.room.id), isNull(assignments.archivedAt)))
        .orderBy(desc(assignments.createdAt));
    },
  );

  const AssignmentParam = z.object({ id: z.uuid(), aid: z.uuid() });

  /** Charge l'assignment si sa classroom appartient au teacher courant. */
  async function ownedAssignment(req: FastifyRequest, reply: FastifyReply) {
    const params = AssignmentParam.safeParse(req.params);
    if (!params.success) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    const [row] = await app.db
      .select({ assignment: assignments, teacherId: classrooms.teacherId, org: organizations })
      .from(assignments)
      .innerJoin(classrooms, eq(assignments.classroomId, classrooms.id))
      .innerJoin(organizations, eq(classrooms.orgId, organizations.id))
      .where(and(eq(assignments.id, params.data.aid), eq(assignments.classroomId, params.data.id)))
      .limit(1);
    if (!row || row.teacherId !== req.user!.id) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    return row;
  }

  const AssignmentPatch = z
    .object({
      name: z.string().min(1).max(200).optional(),
      startAt: z.coerce.date().optional(),
      deadlineAt: z.coerce.date().optional(),
      graceMinutes: z.number().int().min(0).max(1440).optional(),
      deadlineStrategy: z.enum(["lock", "commit"]).optional(),
      protectedFiles: z.array(z.string().min(1).max(300)).max(100).optional(),
    })
    .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" });

  app.patch(
    "/app/api/classrooms/:id/assignments/:aid",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedAssignment(req, reply);
      if (!owned) return reply;
      const body = AssignmentPatch.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: "validation", issues: body.error.issues });
      }
      // Les deux stratégies sont exclusives et fixées à la publication (GH-42).
      if (owned.assignment.state !== "draft" && body.data.deadlineStrategy) {
        return reply.code(409).send({
          error: "strategy_frozen",
          message: "The deadline strategy cannot be changed after publication",
        });
      }
      const nextStart = body.data.startAt ?? owned.assignment.startAt;
      const nextDeadline = body.data.deadlineAt ?? owned.assignment.deadlineAt;
      if (nextDeadline <= nextStart) {
        return reply
          .code(400)
          .send({ error: "validation", message: "Deadline must be after the start date" });
      }
      const [updated] = await app.db
        .update(assignments)
        .set(body.data)
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

      // Replanification (US-08, GH-43) : repousser la deadline d'un assignment
      // déjà échu le ré-ouvre — déverrouillage des dépôts (stratégie lock) et
      // remise à zéro des marqueurs ; le ticker réappliquera à la nouvelle
      // échéance. Les dépôts archivés en mode dégradé (H8) restent archivés.
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
          .set({ state: "published", deadlineAppliedAt: null, frozenAt: null })
          .where(eq(assignments.id, updated.id));
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

  // --- Détail : roster × acceptations, état live des dépôts (US-13/GR-15) ---
  // Sans webhooks (M3), l'état est récupéré de GitHub à l'ouverture puis mis
  // en cache dans student_repos — même logique que la future réconciliation.
  app.get(
    "/app/api/classrooms/:id/assignments/:aid/detail",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedAssignment(req, reply);
      if (!owned) return reply;
      const a = owned.assignment;

      const roster = await app.db
        .select({
          enrollmentId: enrollments.id,
          nom: enrollments.nom,
          prenom: enrollments.prenom,
          email: enrollments.email,
          status: enrollments.status,
          userId: enrollments.userId,
          githubLogin: users.githubLogin,
        })
        .from(enrollments)
        .leftJoin(users, eq(enrollments.userId, users.id))
        .where(eq(enrollments.classroomId, a.classroomId))
        .orderBy(enrollments.nom, enrollments.prenom);

      const repos = await app.db
        .select()
        .from(studentRepos)
        .where(eq(studentRepos.assignmentId, a.id));

      const live = new Map<string, RepoLiveState>();

      const provisioned = repos.filter((r) => r.provisionStatus === "ok" && r.fullName);
      if (provisioned.length > 0 && owned.org.installationId !== null) {
        const client = await installationClient(config, owned.org.installationId);
        await Promise.all(
          provisioned.map(async (r) => {
            try {
              const state = await fetchRepoLiveState(client.octokit, r.fullName!);
              if (!state) return;
              live.set(r.id, state);
              if (state.lastCommitSha) {
                await app.db
                  .update(studentRepos)
                  .set({
                    lastCommitSha: state.lastCommitSha,
                    lastCommitAt: state.lastCommitAt ? new Date(state.lastCommitAt) : null,
                    ciStatus: state.ciStatus,
                  })
                  .where(eq(studentRepos.id, r.id));
              }
            } catch (err) {
              req.log.warn({ err, repo: r.fullName }, "live state fetch failed");
            }
          }),
        );
      }

      return {
        assignment: a,
        students: roster.map((s) => {
          const repo = s.userId ? repos.find((r) => r.userId === s.userId) : undefined;
          return {
            enrollmentId: s.enrollmentId,
            nom: s.nom,
            prenom: s.prenom,
            email: s.email,
            claimStatus: s.status,
            githubLogin: s.githubLogin,
            repo: repo
              ? {
                  id: repo.id,
                  fullName: repo.fullName,
                  provisionStatus: repo.provisionStatus,
                  invitationStatus: repo.invitationStatus,
                  acceptedAt: repo.acceptedAt,
                  lockedAt: repo.lockedAt,
                  ...(live.get(repo.id) ?? {
                    lastCommitSha: repo.lastCommitSha,
                    lastCommitAt: repo.lastCommitAt,
                    commitCount: null,
                    checksPassed: null,
                    checksTotal: null,
                    ciStatus: repo.ciStatus,
                  }),
                }
              : null,
          };
        }),
      };
    },
  );

  // --- Lock / unlock manuel d'un dépôt étudiant (US-22 : « un push de plus ») ---
  const RepoParam = z.object({ id: z.uuid(), aid: z.uuid(), rid: z.uuid() });

  async function ownedStudentRepo(req: FastifyRequest, reply: FastifyReply) {
    const owned = await ownedAssignment(req, reply);
    if (!owned) return null;
    const params = RepoParam.safeParse(req.params);
    if (!params.success) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    const [repo] = await app.db
      .select()
      .from(studentRepos)
      .where(
        and(eq(studentRepos.id, params.data.rid), eq(studentRepos.assignmentId, owned.assignment.id)),
      )
      .limit(1);
    if (!repo || repo.provisionStatus !== "ok" || !repo.fullName) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    return { ...owned, repo };
  }

  for (const action of ["lock", "unlock"] as const) {
    app.post(
      `/app/api/classrooms/:id/assignments/:aid/repos/:rid/${action}`,
      { preHandler: requireTeacher },
      async (req, reply) => {
        const owned = await ownedStudentRepo(req, reply);
        if (!owned) return reply;
        if (owned.org.installationId === null) {
          return reply.code(409).send({ error: "app_not_installed", message: "GitHub App is not installed" });
        }
        const client = await installationClient(config, owned.org.installationId);
        const repoName = owned.repo.fullName!.split("/")[1]!;
        if (action === "lock") {
          await lockStudentRepo(client.octokit, owned.org.login, repoName);
        } else {
          await unlockStudentRepo(client.octokit, owned.org.login, repoName);
        }
        const [updated] = await app.db
          .update(studentRepos)
          .set({ lockedAt: action === "lock" ? new Date() : null })
          .where(eq(studentRepos.id, owned.repo.id))
          .returning();
        await audit(app.db, {
          actorUserId: req.user!.id,
          actorType: "user",
          action: `repo.${action}`,
          subjectType: "student_repo",
          subjectId: owned.repo.id,
          payload: { repo: owned.repo.fullName },
        });
        return updated;
      },
    );
  }

  app.post(
    "/app/api/classrooms/:id/assignments/:aid/publish",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedAssignment(req, reply);
      if (!owned) return reply;
      if (owned.assignment.state !== "draft") {
        return reply
          .code(409)
          .send({ error: "not_draft", message: "Only draft assignments can be published" });
      }
      if (owned.assignment.deadlineAt <= new Date()) {
        return reply
          .code(400)
          .send({ error: "deadline_past", message: "Deadline is in the past" });
      }
      const [updated] = await app.db
        .update(assignments)
        .set({ state: "published" })
        .where(eq(assignments.id, owned.assignment.id))
        .returning();
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "assignment.publish",
        subjectType: "assignment",
        subjectId: owned.assignment.id,
      });
      return updated;
    },
  );

  app.post(
    "/app/api/classrooms/:id/assignments/:aid/archive",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedAssignment(req, reply);
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

  app.delete(
    "/app/api/classrooms/:id/assignments/:aid",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedAssignment(req, reply);
      if (!owned) return reply;
      if (owned.assignment.state !== "draft") {
        return reply
          .code(409)
          .send({ error: "not_draft", message: "Only draft assignments can be deleted" });
      }
      // Le squashed est supprimé avec le brouillon (aucun dépôt étudiant n'existe).
      if (owned.assignment.squashedFullName) {
        const client = await clientFor(reply, owned.org);
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
      const owned = await ownedClassroomWithOrg(req, reply);
      if (!owned) return reply;
      const body = AssignmentCreate.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: "validation", issues: body.error.issues });
      }
      const client = await clientFor(reply, owned.org);
      if (!client) return reply;

      // Le dépôt source doit exister dans l'organisation (GH-10).
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

      // Dépôt squashed créé à la création de l'assignment (GH-11/12) —
      // synchrone pour cette tranche (quelques secondes), jobs en M3.
      let squashed;
      try {
        squashed = await createSquashedRepo({
          octokit: client.octokit,
          token: client.token,
          org: owned.org.login,
          sourceRepo: source.name,
          targetRepo: `${slug}-squashed`,
          strategy: body.data.sourceStrategy,
          branches,
        });
      } catch (err) {
        req.log.error({ err }, "création du squashed impossible");
        const status = (err as { status?: number }).status;
        return reply.code(status === 422 ? 409 : 502).send({
          error: "squashed_failed",
          message:
            status === 422
              ? `Repository ${slug}-squashed already exists in the organization`
              : "Could not create the squashed repository — try again",
        });
      }

      try {
        const [row] = await app.db
          .insert(assignments)
          .values({
            id: randomUUID(),
            classroomId: owned.room.id,
            name: body.data.name,
            slug,
            startAt: body.data.startAt,
            deadlineAt: body.data.deadlineAt,
            graceMinutes: body.data.graceMinutes,
            sourceRepoId: source.id,
            sourceFullName: source.full_name,
            squashedRepoId: squashed.repoId,
            squashedFullName: squashed.fullName,
            sourceStrategy: body.data.sourceStrategy,
            deadlineStrategy: body.data.deadlineStrategy,
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
        // UNIQUE(classroom_id, slug) : nom déjà pris — le squashed vient d'être
        // créé pour rien, on le supprime pour rester rejouable.
        await client.octokit
          .request("DELETE /repos/{owner}/{repo}", {
            owner: owned.org.login,
            repo: `${slug}-squashed`,
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
