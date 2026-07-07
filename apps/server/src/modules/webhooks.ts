import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, eq, gte, sql } from "drizzle-orm";

import { audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  assignments,
  botCommits,
  classrooms,
  pushReceipts,
  reverts,
  studentRepos,
  webhookDeliveries,
} from "../db/schema.js";
import { publish } from "../events.js";
import { installationClient } from "../github/app.js";
import { revertProtectedFiles } from "../github/revert.js";
import { WEBHOOK_QUEUE, type WebhookJob } from "../jobs.js";

const MAX_REVERTS_PER_HOUR = 5; // plafond anti-boucle (H10, GH-33)

interface PushPayload {
  ref: string;
  after: string;
  forced?: boolean;
  repository?: { id: number };
  sender?: { login?: string };
  head_commit?: { timestamp?: string } | null;
  commits?: { added: string[]; modified: string[]; removed: string[] }[];
}

interface WorkflowRunPayload {
  action?: string;
  repository?: { id: number };
  workflow_run?: {
    head_sha?: string;
    status?: string;
    conclusion?: string | null;
  };
}

/** Vérification HMAC en temps constant (GH-60, NFR-04). */
function verifySignature(secret: string, raw: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const received = header.slice("sha256=".length);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
}

async function repoContext(db: Db, githubRepoId: number) {
  const [row] = await db
    .select({ repo: studentRepos, assignment: assignments, classroomId: classrooms.id })
    .from(studentRepos)
    .innerJoin(assignments, eq(studentRepos.assignmentId, assignments.id))
    .innerJoin(classrooms, eq(assignments.classroomId, classrooms.id))
    .where(eq(studentRepos.githubRepoId, githubRepoId))
    .limit(1);
  return row ?? null;
}

/** Traitement asynchrone d'une livraison (rejouable : chaque étape est idempotente). */
export function makeWebhookHandler(app: FastifyInstance, config: AppConfig) {
  return async ({ deliveryId }: WebhookJob) => {
    const [delivery] = await app.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, deliveryId))
      .limit(1);
    if (!delivery || delivery.processedAt) return;

    try {
      if (delivery.event === "push") {
        await handlePush(app, config, delivery.payload as PushPayload);
      } else if (delivery.event === "workflow_run") {
        await handleWorkflowRun(app, delivery.payload as WorkflowRunPayload);
      }
      await app.db
        .update(webhookDeliveries)
        .set({ processedAt: new Date(), error: null })
        .where(eq(webhookDeliveries.deliveryId, deliveryId));
    } catch (err) {
      await app.db
        .update(webhookDeliveries)
        .set({ error: String(err).slice(0, 500) })
        .where(eq(webhookDeliveries.deliveryId, deliveryId));
      throw err; // pg-boss retry → dead-letter
    }
  };
}

async function handlePush(app: FastifyInstance, config: AppConfig, p: PushPayload) {
  if (!p.repository?.id || !p.after) return;
  const ctx = await repoContext(app.db, p.repository.id);
  if (!ctx) return; // dépôt inconnu de la plateforme
  const branch = p.ref?.replace("refs/heads/", "") ?? "";
  const botLogin = config.GITHUB_APP_SLUG ? `${config.GITHUB_APP_SLUG}[bot]` : "";
  const isBot = Boolean(botLogin && p.sender?.login === botLogin);

  // Métriques (GR-15) + SSE — la table du teacher bouge sans refresh.
  await app.db
    .update(studentRepos)
    .set({
      lastCommitSha: p.after,
      lastCommitAt: p.head_commit?.timestamp ? new Date(p.head_commit.timestamp) : new Date(),
    })
    .where(eq(studentRepos.id, ctx.repo.id));
  publish("repos", [`classroom:${ctx.classroomId}`, `user:${ctx.repo.userId}`]);

  // Protected files (GH-30..35) — jamais sur un push du bot (anti-boucle).
  if (isBot || ctx.assignment.protectedFiles.length === 0) return;
  const touched = new Set<string>();
  for (const c of p.commits ?? []) {
    for (const f of [...c.added, ...c.modified, ...c.removed]) touched.add(f);
  }
  const hit = ctx.assignment.protectedFiles.filter((f) => touched.has(f));
  if (hit.length === 0) return;

  // Plafond anti-boucle : 5 reverts / heure / dépôt → conflit signalé.
  const capRows = await app.db
    .select({ count: sql<number>`count(*)::int` })
    .from(reverts)
    .where(
      and(
        eq(reverts.studentRepoId, ctx.repo.id),
        gte(reverts.createdAt, sql`now() - interval '1 hour'`),
      ),
    );
  if ((capRows[0]?.count ?? 0) >= MAX_REVERTS_PER_HOUR) {
    await app.db
      .update(studentRepos)
      .set({ provisionError: "protected files revert cap reached" })
      .where(eq(studentRepos.id, ctx.repo.id));
    await audit(app.db, {
      actorType: "system",
      action: "repo.revert_cap",
      subjectType: "student_repo",
      subjectId: ctx.repo.id,
      payload: { files: hit },
    });
    return;
  }

  const [org, repoName] = ctx.repo.fullName!.split("/") as [string, string];
  const [, squashedName] = (ctx.assignment.squashedFullName ?? "").split("/") as [string, string];
  const orgRes = await app.db.execute(
    sql`SELECT installation_id FROM organizations o JOIN classrooms c ON c.org_id = o.id WHERE c.id = ${ctx.classroomId}`,
  );
  const installationId = (orgRes.rows[0] as { installation_id: number | null } | undefined)
    ?.installation_id;
  if (!installationId || !squashedName) return;

  const client = await installationClient(config, installationId);
  const result = await revertProtectedFiles({
    octokit: client.octokit,
    org,
    studentRepo: repoName,
    squashedRepo: squashedName,
    branch: branch || ctx.repo.defaultBranch || "main",
    paths: hit,
  });
  if (!result) return;

  await app.db
    .insert(botCommits)
    .values({ studentRepoId: ctx.repo.id, sha: result.sha, kind: "revert" })
    .onConflictDoNothing();
  await app.db.insert(reverts).values({
    id: randomUUID(),
    studentRepoId: ctx.repo.id,
    revertSha: result.sha,
    files: result.files,
  });
  await audit(app.db, {
    actorType: "system",
    action: "repo.protected_files_reverted",
    subjectType: "student_repo",
    subjectId: ctx.repo.id,
    payload: { files: result.files, sha: result.sha },
  });
  publish("repos", [`classroom:${ctx.classroomId}`, `user:${ctx.repo.userId}`]);
}

async function handleWorkflowRun(app: FastifyInstance, p: WorkflowRunPayload) {
  if (p.action !== "completed" && p.action !== "requested" && p.action !== "in_progress") return;
  if (!p.repository?.id) return;
  const ctx = await repoContext(app.db, p.repository.id);
  if (!ctx) return;
  const run = p.workflow_run;
  const ciStatus =
    p.action !== "completed"
      ? ("pending" as const)
      : run?.conclusion === "success"
        ? ("pass" as const)
        : run?.conclusion === "failure"
          ? ("fail" as const)
          : ("none" as const);
  await app.db
    .update(studentRepos)
    .set({ ciStatus })
    .where(eq(studentRepos.id, ctx.repo.id));
  publish("repos", [`classroom:${ctx.classroomId}`, `user:${ctx.repo.userId}`]);
}

/** Endpoint public : HMAC, dédup, reçu synchrone, enfilage, 200 < 5 s (GH-60). */
export async function webhooksPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;

  // Corps BRUT requis pour l'HMAC — parser scoped à ce plugin encapsulé.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
    done(null, body),
  );

  app.post("/webhooks/github", async (req, reply) => {
    if (!config.GITHUB_WEBHOOK_SECRET) {
      return reply.code(503).send({ error: "webhooks_unconfigured" });
    }
    const raw = req.body as Buffer;
    if (
      !Buffer.isBuffer(raw) ||
      !verifySignature(config.GITHUB_WEBHOOK_SECRET, raw, req.headers["x-hub-signature-256"] as string | undefined)
    ) {
      req.log.warn("webhook signature rejected"); // compté (NFR-04)
      return reply.code(401).send({ error: "bad_signature" });
    }
    const deliveryId = req.headers["x-github-delivery"] as string | undefined;
    const event = req.headers["x-github-event"] as string | undefined;
    if (!deliveryId || !event) return reply.code(400).send({ error: "missing_headers" });

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return reply.code(400).send({ error: "bad_json" });
    }

    // Déduplication (GH-61) : la PK EST la déduplication.
    const inserted = await app.db
      .insert(webhookDeliveries)
      .values({
        deliveryId,
        event,
        action: typeof payload.action === "string" ? payload.action : null,
        payload,
      })
      .onConflictDoNothing()
      .returning({ id: webhookDeliveries.deliveryId });
    if (inserted.length === 0) return reply.code(200).send({ ok: true, duplicate: true });

    // Reçu de push SYNCHRONE (ADR-012) : l'heure légale du gel ne dépend
    // jamais du retard de la file.
    if (event === "push") {
      const p = payload as unknown as PushPayload;
      if (p.repository?.id && p.after && !/^0+$/.test(p.after)) {
        const ctx = await repoContext(app.db, p.repository.id);
        if (ctx) {
          const botLogin = config.GITHUB_APP_SLUG ? `${config.GITHUB_APP_SLUG}[bot]` : "";
          await app.db
            .insert(pushReceipts)
            .values({
              id: randomUUID(),
              studentRepoId: ctx.repo.id,
              branch: p.ref?.replace("refs/heads/", "") ?? "",
              headSha: p.after,
              isBot: Boolean(botLogin && p.sender?.login === botLogin),
              forced: Boolean(p.forced),
            })
            .onConflictDoNothing();
        }
      }
    }

    await app.boss.send(WEBHOOK_QUEUE, { deliveryId } satisfies WebhookJob);
    return reply.code(200).send({ ok: true });
  });
}
