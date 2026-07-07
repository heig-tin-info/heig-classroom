import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq } from "drizzle-orm";
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
    message: "La deadline doit être postérieure au début",
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
        message: `GitHub App non installée sur ${org.login}`,
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
      return data
        .filter((r) => !r.archived)
        .map((r) => ({
          name: r.name,
          defaultBranch: r.default_branch,
          private: r.private,
          pushedAt: r.pushed_at,
        }));
    },
  );

  // --- Defaults d'un dépôt source : branche + fichiers protégeables présents ---
  app.get(
    "/app/api/classrooms/:id/org-repos/:repo/defaults",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedClassroomWithOrg(req, reply);
      if (!owned) return reply;
      const client = await clientFor(reply, owned.org);
      if (!client) return reply;
      const repo = z.string().min(1).max(200).parse((req.params as { repo: string }).repo);
      let repoData;
      try {
        const res = await client.octokit.request("GET /repos/{owner}/{repo}", {
          owner: owned.org.login,
          repo,
          request: { retries: 0 },
        });
        repoData = res.data;
      } catch (err) {
        if ((err as { status?: number }).status === 404) {
          return reply.code(404).send({ error: "repo_not_found" });
        }
        throw err;
      }
      const protectedFiles: string[] = [];
      for (const path of PROTECTED_CANDIDATES) {
        try {
          await client.octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
            owner: owned.org.login,
            repo,
            path,
            request: { retries: 0 },
          });
          protectedFiles.push(path);
        } catch (err) {
          if ((err as { status?: number }).status !== 404) throw err;
        }
      }
      return {
        name: repoData.name,
        repoId: repoData.id,
        defaultBranch: repoData.default_branch,
        protectedFiles,
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
        .where(eq(assignments.classroomId, owned.room.id))
        .orderBy(desc(assignments.createdAt));
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
            message: `Dépôt ${body.data.sourceRepo} introuvable dans ${owned.org.login}`,
          });
        }
        throw err;
      }

      const slug = slugify(body.data.name);
      if (!slug) {
        return reply.code(400).send({ error: "validation", message: "Nom sans caractères utilisables" });
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
              ? `Le dépôt ${slug}-squashed existe déjà dans l'organisation`
              : "Création du dépôt squashed impossible — réessaie",
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
          message: `Un assignment « ${slug} » existe déjà dans cette classroom`,
        });
      }
    },
  );
}
