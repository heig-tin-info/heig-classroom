/**
 * Scheduled tasks (ADR-011): the fallback polling behind the webhooks.
 * The catalog lives here (description, handler, default interval); the
 * `scheduled_tasks` table carries the admin configuration (interval,
 * activation) and the state of the last run. Webhook events wake the queue
 * immediately; these tasks are only the safety net.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";

import type { AppConfig } from "./config.js";
import {
  assignments,
  classrooms,
  organizations,
  scheduledTasks,
  sessions,
  studentRepos,
  users,
  webhookDeliveries,
} from "./db/schema.js";
import { publish } from "./events.js";
import { githubApp, installationClient } from "./github/app.js";
import { fetchRepoLiveState } from "./github/metrics.js";
import { ingestCompletedRun, type RepoCtx } from "./grading.js";
import { WEBHOOK_QUEUE } from "./jobs.js";

export interface TaskDef {
  key: string;
  /** Description shown on the admin screen (English, like the whole UI). */
  description: string;
  defaultIntervalMinutes: number;
  /** The domain is also covered by webhooks (processed immediately). */
  webhookWoken: boolean;
  run: (app: FastifyInstance, config: AppConfig) => Promise<string>;
}

export const TASK_DEFS: TaskDef[] = [
  {
    key: "reconcile.grades",
    description:
      "Re-read CI runs of repositories quiet for more than 30 minutes and capture missed grades (GR-07).",
    defaultIntervalMinutes: 15,
    webhookWoken: true,
    run: reconcileGrades,
  },
  {
    key: "reconcile.repos",
    description:
      "Refresh commit and CI metrics of every provisioned repository from GitHub (catches lost webhooks).",
    defaultIntervalMinutes: 24 * 60,
    webhookWoken: true,
    run: reconcileRepos,
  },
  {
    key: "reconcile.deliveries",
    description:
      "Re-enqueue stuck webhook deliveries and ask GitHub to redeliver failed ones (GH-62).",
    defaultIntervalMinutes: 24 * 60,
    webhookWoken: true,
    run: reconcileDeliveries,
  },
  {
    key: "purge.housekeeping",
    description:
      "Delete expired sessions and strip webhook payloads older than 30 days.",
    defaultIntervalMinutes: 24 * 60,
    webhookWoken: false,
    run: purgeHousekeeping,
  },
];

export function taskDef(key: string): TaskDef | undefined {
  return TASK_DEFS.find((t) => t.key === key);
}

/** Missing configuration rows are created with the default intervals. */
export async function seedTasks(app: FastifyInstance) {
  for (const def of TASK_DEFS) {
    await app.db
      .insert(scheduledTasks)
      .values({ key: def.key, intervalMinutes: def.defaultIntervalMinutes })
      .onConflictDoNothing();
  }
}

/** Instrumented execution: status, duration and error visible in the admin. */
export async function runTask(app: FastifyInstance, config: AppConfig, key: string) {
  const def = taskDef(key);
  if (!def) return;
  const started = Date.now();
  try {
    const summary = await def.run(app, config);
    await app.db
      .update(scheduledTasks)
      .set({
        lastStatus: "ok",
        lastError: summary || null,
        lastDurationMs: Date.now() - started,
      })
      .where(eq(scheduledTasks.key, key));
  } catch (err) {
    app.log.error({ err, task: key }, "scheduled task failed");
    await app.db
      .update(scheduledTasks)
      .set({
        lastStatus: "error",
        lastError: String(err).slice(0, 500),
        lastDurationMs: Date.now() - started,
      })
      .where(eq(scheduledTasks.key, key));
  }
  publish("tasks", ["admin"]);
}

/**
 * GR-07: re-queries the runs of repositories quiet for more than 30 minutes
 * (no push webhook nor recent GradeRun). The GR-05 pipeline is reused as-is
 * via `ingestCompletedRun` (idempotent by (repo, run, attempt)).
 */
async function reconcileGrades(app: FastifyInstance, config: AppConfig): Promise<string> {
  const QUIET_MINUTES = 30;
  const rows = await app.db
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
    .where(
      and(
        eq(studentRepos.provisionStatus, "ok"),
        isNotNull(studentRepos.fullName),
        isNotNull(organizations.installationId),
        isNull(assignments.archivedAt),
        ne(assignments.state, "draft"),
        sql`coalesce(
          greatest(
            (SELECT max(pr.received_at) FROM push_receipts pr WHERE pr.student_repo_id = ${studentRepos.id}),
            (SELECT max(gr.created_at) FROM grade_runs gr WHERE gr.student_repo_id = ${studentRepos.id})
          ),
          to_timestamp(0)
        ) < now() - make_interval(mins => ${QUIET_MINUTES})`,
      ),
    );
  const clients = new Map<number, Awaited<ReturnType<typeof installationClient>>>();
  const touched = new Set<string>();
  let ingested = 0;
  for (const { repo, assignment, classroomId, installationId } of rows) {
    let client = clients.get(installationId!);
    if (!client) {
      client = await installationClient(config, installationId!);
      clients.set(installationId!, client);
    }
    const ctx: RepoCtx = { repo, assignment, classroomId };
    const [owner, repoName] = repo.fullName!.split("/") as [string, string];
    try {
      const { data } = await client.octokit.request("GET /repos/{owner}/{repo}/actions/runs", {
        owner,
        repo: repoName,
        per_page: 20,
        status: "completed",
      });
      for (const run of data.workflow_runs) {
        const id = await ingestCompletedRun(app, client.octokit, ctx, {
          workflowRunId: run.id,
          runAttempt: run.run_attempt ?? 1,
          headBranch: run.head_branch ?? "",
          headSha: run.head_sha,
          conclusion: run.conclusion ?? "unknown",
          path: run.path,
          event: run.event,
          checkSuiteId: run.check_suite_id ?? null,
          completedAt: new Date(run.updated_at),
        });
        if (id) {
          ingested += 1;
          touched.add(`classroom:${classroomId}`);
          touched.add(`user:${repo.userId}`);
        }
      }
    } catch (err) {
      app.log.warn({ err, repo: repo.fullName }, "reconcile.grades: repo fetch failed");
    }
  }
  if (touched.size > 0) {
    publish("grades", [...touched]);
    publish("repos", [...touched]);
  }
  return `${rows.length} quiet repositories checked, ${ingested} runs captured`;
}

/** GR-15 fallback: same metrics as the detail view, sourced from reconciliation. */
async function reconcileRepos(app: FastifyInstance, config: AppConfig): Promise<string> {
  const rows = await app.db
    .select({
      repo: studentRepos,
      classroomId: classrooms.id,
      installationId: organizations.installationId,
      githubLogin: users.githubLogin,
    })
    .from(studentRepos)
    .innerJoin(assignments, eq(studentRepos.assignmentId, assignments.id))
    .innerJoin(classrooms, eq(assignments.classroomId, classrooms.id))
    .innerJoin(organizations, eq(classrooms.orgId, organizations.id))
    .innerJoin(users, eq(studentRepos.userId, users.id))
    .where(
      and(
        eq(studentRepos.provisionStatus, "ok"),
        isNotNull(studentRepos.fullName),
        isNotNull(organizations.installationId),
        isNull(assignments.archivedAt),
      ),
    );
  const clients = new Map<number, Awaited<ReturnType<typeof installationClient>>>();
  const touched = new Set<string>();
  let updated = 0;
  for (const { repo, classroomId, installationId, githubLogin } of rows) {
    let client = clients.get(installationId!);
    if (!client) {
      client = await installationClient(config, installationId!);
      clients.set(installationId!, client);
    }
    const notify = () => {
      touched.add(`classroom:${classroomId}`);
      touched.add(`user:${repo.userId}`);
    };
    // Invitation acceptance has no reliable retro-active webhook: a pending
    // invite whose invitee is now a collaborator has been accepted (204),
    // otherwise the collaborators endpoint answers 404.
    if (repo.invitationStatus === "pending" && githubLogin) {
      const [owner, name] = repo.fullName!.split("/") as [string, string];
      try {
        await client.octokit.request(
          "GET /repos/{owner}/{repo}/collaborators/{username}",
          { owner, repo: name, username: githubLogin, request: { retries: 0 } },
        );
        await app.db
          .update(studentRepos)
          .set({ invitationStatus: "accepted" })
          .where(eq(studentRepos.id, repo.id));
        updated += 1;
        notify();
      } catch (err) {
        if ((err as { status?: number }).status !== 404) {
          app.log.warn({ err, repo: repo.fullName }, "reconcile.repos: collaborator check failed");
        }
      }
    }
    try {
      const state = await fetchRepoLiveState(client.octokit, repo.fullName!);
      if (!state?.lastCommitSha) continue;
      if (state.lastCommitSha === repo.lastCommitSha && state.ciStatus === repo.ciStatus) continue;
      await app.db
        .update(studentRepos)
        .set({
          lastCommitSha: state.lastCommitSha,
          lastCommitAt: state.lastCommitAt ? new Date(state.lastCommitAt) : null,
          ciStatus: state.ciStatus,
        })
        .where(eq(studentRepos.id, repo.id));
      updated += 1;
      notify();
    } catch (err) {
      app.log.warn({ err, repo: repo.fullName }, "reconcile.repos: repo fetch failed");
    }
  }
  if (touched.size > 0) publish("repos", [...touched]);
  return `${rows.length} repositories checked, ${updated} updated`;
}

/** GH-62: re-enqueues stuck local deliveries, requests redelivery of GitHub failures. */
async function reconcileDeliveries(app: FastifyInstance, config: AppConfig): Promise<string> {
  // 1. Deliveries received but never processed (lost job, crash): re-enqueued.
  let requeued = 0;
  if (app.boss) {
    const stuck = await app.db
      .select({ deliveryId: webhookDeliveries.deliveryId })
      .from(webhookDeliveries)
      .where(
        and(
          isNull(webhookDeliveries.processedAt),
          lt(webhookDeliveries.receivedAt, sql`now() - interval '10 minutes'`),
        ),
      )
      .limit(200);
    for (const { deliveryId } of stuck) {
      await app.boss.send(WEBHOOK_QUEUE, { deliveryId }, { singletonKey: deliveryId });
      requeued += 1;
    }
  }

  // 2. Deliveries failed on the GitHub side (endpoint down): redelivery API.
  //    Deduplication by X-GitHub-Delivery absorbs the duplicates.
  let redelivered = 0;
  const gh = githubApp(config);
  if (gh) {
    let deliveries: { id: number; guid: string; status_code: number; redelivery: boolean; delivered_at: string }[] = [];
    try {
      const res = await gh.octokit.request("GET /app/hook/deliveries", { per_page: 100 });
      deliveries = res.data;
    } catch (err) {
      // 404: the App has no webhook configured (dev), nothing to reconcile.
      if ((err as { status?: number }).status !== 404) throw err;
    }
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    const failed = deliveries.filter(
      (d) =>
        d.status_code >= 400 &&
        !d.redelivery &&
        new Date(d.delivered_at).getTime() >= dayAgo,
    );
    for (const d of failed.slice(0, 50)) {
      try {
        await gh.octokit.request("POST /app/hook/deliveries/{delivery_id}/attempts", {
          delivery_id: d.id,
        });
        redelivered += 1;
      } catch (err) {
        app.log.warn({ err, guid: d.guid }, "reconcile.deliveries: redelivery failed");
      }
    }
  }
  return `${requeued} local deliveries re-enqueued, ${redelivered} GitHub redeliveries requested`;
}

/** NFR: bounded data volume; expired sessions, webhook payloads > 30 days. */
async function purgeHousekeeping(app: FastifyInstance): Promise<string> {
  const deletedSessions = await app.db
    .delete(sessions)
    .where(lt(sessions.expiresAt, sql`now()`))
    .returning({ sid: sessions.sidHash });
  const purged = await app.db
    .update(webhookDeliveries)
    .set({ payload: sql`'{}'::jsonb` })
    .where(
      and(
        isNotNull(webhookDeliveries.processedAt),
        lt(webhookDeliveries.receivedAt, sql`now() - interval '30 days'`),
        ne(webhookDeliveries.payload, sql`'{}'::jsonb`),
      ),
    )
    .returning({ id: webhookDeliveries.deliveryId });
  return `${deletedSessions.length} expired sessions deleted, ${purged.length} webhook payloads purged`;
}
