import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import { assignments, classrooms, organizations } from "../db/schema.js";
import { installationClient } from "../github/app.js";
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
    if (req.user!.role !== "teacher") return reply.code(403).send({ error: "forbidden" });
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
      if (owned.assignment.state !== "draft") {
        // L'édition d'un assignment publié (replanification du ticker, etc.)
        // arrive avec le jalon M4.
        return reply
          .code(409)
          .send({ error: "not_draft", message: "Only draft assignments can be edited for now" });
      }
      const body = AssignmentPatch.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: "validation", issues: body.error.issues });
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
