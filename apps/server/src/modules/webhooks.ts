import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, eq, gte, isNull, ne, sql } from "drizzle-orm";

import { audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  assignments,
  botCommits,
  classrooms,
  organizations,
  pushReceipts,
  reverts,
  studentRepos,
  webhookDeliveries,
} from "../db/schema.js";
import { publish } from "../events.js";
import { installationClient } from "../github/app.js";
import { revertProtectedFiles } from "../github/revert.js";
import { ingestCompletedRun, isEligible } from "../grading.js";
import { WEBHOOK_QUEUE, type WebhookJob } from "../jobs.js";

const MAX_REVERTS_PER_HOUR = 5; // anti-loop cap (H10, GH-33)

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
    id?: number;
    run_attempt?: number;
    head_branch?: string | null;
    head_sha?: string;
    status?: string;
    conclusion?: string | null;
    path?: string;
    check_suite_id?: number;
    updated_at?: string;
  };
}

/** Constant-time HMAC verification (GH-60, NFR-04). */
function verifySignature(secret: string, raw: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const received = header.slice("sha256=".length);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
}

async function repoContext(db: Db, githubRepoId: number) {
  const [row] = await db
    .select({
      repo: studentRepos,
      assignment: assignments,
      classroomId: classrooms.id,
      installationId: organizations.installationId,
    })
    .from(studentRepos)
    .innerJoin(assignments, eq(studentRepos.assignmentId, assignments.id))
    .innerJoin(classrooms, eq(assignments.classroomId, classrooms.id))
    .innerJoin(organizations, eq(classrooms.orgId, organizations.id))
    .where(eq(studentRepos.githubRepoId, githubRepoId))
    .limit(1);
  return row ?? null;
}

/** Asynchronous processing of a delivery (replayable: every step is idempotent). */
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
        await handleSourcePush(app, delivery.payload as PushPayload);
        await handlePush(app, config, delivery.payload as PushPayload);
      } else if (delivery.event === "workflow_run") {
        await handleWorkflowRun(app, config, delivery.payload as WorkflowRunPayload);
      } else if (delivery.event === "pull_request") {
        await handlePullRequest(app, delivery.payload as PullRequestPayload);
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
      throw err; // pg-boss retry, then dead-letter
    }
  };
}

/**
 * GH-50: a push on a selected branch of a SOURCE repository makes the sync
 * available in the teacher view. No auto-propagation: the teacher triggers
 * it explicitly (avoids spamming students with PRs on every commit).
 */
async function handleSourcePush(app: FastifyInstance, p: PushPayload) {
  if (!p.repository?.id || !p.after || /^0+$/.test(p.after)) return;
  const branch = p.ref?.replace("refs/heads/", "") ?? "";
  const affected = await app.db
    .update(assignments)
    .set({ sourceAheadSha: p.after, sourcePushedAt: new Date() })
    .where(
      and(
        eq(assignments.sourceRepoId, p.repository.id),
        ne(assignments.state, "draft"),
        isNull(assignments.archivedAt),
        sql`${branch} = ANY(${assignments.branches})`,
      ),
    )
    .returning({ classroomId: assignments.classroomId });
  for (const a of affected) publish("assignments", [`classroom:${a.classroomId}`]);
}

async function handlePush(app: FastifyInstance, config: AppConfig, p: PushPayload) {
  if (!p.repository?.id || !p.after) return;
  const ctx = await repoContext(app.db, p.repository.id);
  if (!ctx) return; // repository unknown to the platform
  const branch = p.ref?.replace("refs/heads/", "") ?? "";
  const botLogin = config.GITHUB_APP_SLUG ? `${config.GITHUB_APP_SLUG}[bot]` : "";
  const isBot = Boolean(botLogin && p.sender?.login === botLogin);

  // Metrics (GR-15) + SSE: the teacher's table updates without a refresh.
  await app.db
    .update(studentRepos)
    .set({
      lastCommitSha: p.after,
      lastCommitAt: p.head_commit?.timestamp ? new Date(p.head_commit.timestamp) : new Date(),
    })
    .where(eq(studentRepos.id, ctx.repo.id));
  publish("repos", [`classroom:${ctx.classroomId}`, `user:${ctx.repo.userId}`]);

  // Protected files (GH-30..35): never on a push from the bot (anti-loop).
  if (isBot || ctx.assignment.protectedFiles.length === 0) return;
  const touched = new Set<string>();
  for (const c of p.commits ?? []) {
    for (const f of [...c.added, ...c.modified, ...c.removed]) touched.add(f);
  }
  const hit = ctx.assignment.protectedFiles.filter((f) => touched.has(f));
  if (hit.length === 0) return;

  // Anti-loop cap: 5 reverts / hour / repository, then the conflict is flagged.
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
  if (ctx.installationId === null || !squashedName) return;

  const client = await installationClient(config, ctx.installationId);
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

interface PullRequestPayload {
  action?: string;
  repository?: { id: number };
  pull_request?: {
    number?: number;
    merged?: boolean;
    head?: { ref?: string };
  };
}

/** GH-52: sync PR state (open / merged / closed) aggregated in the teacher view. */
async function handlePullRequest(app: FastifyInstance, p: PullRequestPayload) {
  if (!p.repository?.id || !p.pull_request?.number) return;
  if (!p.pull_request.head?.ref?.startsWith("sync/")) return;
  const ctx = await repoContext(app.db, p.repository.id);
  if (!ctx) return;
  const state =
    p.action === "closed"
      ? p.pull_request.merged
        ? ("merged" as const)
        : ("closed" as const)
      : ("open" as const);
  await app.db
    .update(studentRepos)
    .set({ syncPrNumber: p.pull_request.number, syncPrState: state })
    .where(eq(studentRepos.id, ctx.repo.id));
  publish("repos", [`classroom:${ctx.classroomId}`, `user:${ctx.repo.userId}`]);
}

/** GR-04/05: pending status on an eligible run, full ingestion on completed. */
async function handleWorkflowRun(
  app: FastifyInstance,
  config: AppConfig,
  p: WorkflowRunPayload,
) {
  if (p.action !== "completed" && p.action !== "requested" && p.action !== "in_progress") return;
  if (!p.repository?.id || !p.workflow_run) return;
  const ctx = await repoContext(app.db, p.repository.id);
  if (!ctx) return;
  const run = p.workflow_run;

  if (!(await isEligible(app, ctx, run.head_branch, run.head_sha))) return;

  if (p.action !== "completed") {
    await app.db
      .update(studentRepos)
      .set({ ciStatus: "pending" })
      .where(eq(studentRepos.id, ctx.repo.id));
    publish("repos", [`classroom:${ctx.classroomId}`, `user:${ctx.repo.userId}`]);
    return;
  }

  if (!run.id || !run.head_sha || !run.head_branch || ctx.installationId === null) return;
  const client = await installationClient(config, ctx.installationId);
  await ingestCompletedRun(app, client.octokit, ctx, {
    workflowRunId: run.id,
    runAttempt: run.run_attempt ?? 1,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    conclusion: run.conclusion ?? "unknown",
    path: run.path ?? "",
    checkSuiteId: run.check_suite_id ?? null,
    completedAt: run.updated_at ? new Date(run.updated_at) : new Date(),
  });
  publish("repos", [`classroom:${ctx.classroomId}`, `user:${ctx.repo.userId}`]);
  publish("grades", [`classroom:${ctx.classroomId}`, `user:${ctx.repo.userId}`]);
}

/** Public endpoint: HMAC, dedup, synchronous receipt, enqueue, 200 < 5 s (GH-60). */
export async function webhooksPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;

  // RAW body required for the HMAC; parser scoped to this encapsulated plugin.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
    done(null, body),
  );

  app.post("/webhooks/github", async (req, reply) => {
    if (!config.GITHUB_WEBHOOK_SECRET || !app.boss) {
      return reply.code(503).send({ error: "webhooks_unconfigured" });
    }
    const raw = req.body as Buffer;
    if (
      !Buffer.isBuffer(raw) ||
      !verifySignature(config.GITHUB_WEBHOOK_SECRET, raw, req.headers["x-hub-signature-256"] as string | undefined)
    ) {
      req.log.warn("webhook signature rejected"); // counted (NFR-04)
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

    // Deduplication (GH-61): the PK IS the deduplication.
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

    // SYNCHRONOUS push receipt (ADR-012): the legal freeze time never
    // depends on queue lag.
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
