/**
 * Tâches planifiées (ADR-011) : le polling de secours derrière les webhooks.
 * Le catalogue vit ici (description, handler, période par défaut) ; la table
 * `scheduled_tasks` porte la configuration admin (période, activation) et
 * l'état de la dernière exécution. Les événements webhook, eux, réveillent
 * la file immédiatement — ces tâches ne sont que le filet.
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
  webhookDeliveries,
} from "./db/schema.js";
import { publish } from "./events.js";
import { githubApp, installationClient } from "./github/app.js";
import { fetchRepoLiveState } from "./github/metrics.js";
import { WEBHOOK_QUEUE } from "./jobs.js";

export interface TaskDef {
  key: string;
  /** Description affichée dans l'écran admin (anglais, comme toute l'UI). */
  description: string;
  defaultIntervalMinutes: number;
  /** Le domaine est aussi couvert par les webhooks (traités immédiatement). */
  webhookWoken: boolean;
  run: (app: FastifyInstance, config: AppConfig) => Promise<string>;
}

export const TASK_DEFS: TaskDef[] = [
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

/** Lignes de configuration manquantes créées avec les périodes par défaut. */
export async function seedTasks(app: FastifyInstance) {
  for (const def of TASK_DEFS) {
    await app.db
      .insert(scheduledTasks)
      .values({ key: def.key, intervalMinutes: def.defaultIntervalMinutes })
      .onConflictDoNothing();
  }
}

/** Exécution instrumentée : statut, durée et erreur visibles dans l'admin. */
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

/** GR-15 en secours : mêmes métriques que la vue détail, source réconciliation. */
async function reconcileRepos(app: FastifyInstance, config: AppConfig): Promise<string> {
  const rows = await app.db
    .select({
      repo: studentRepos,
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
      ),
    );
  const clients = new Map<number, Awaited<ReturnType<typeof installationClient>>>();
  const touched = new Set<string>();
  let updated = 0;
  for (const { repo, classroomId, installationId } of rows) {
    let client = clients.get(installationId!);
    if (!client) {
      client = await installationClient(config, installationId!);
      clients.set(installationId!, client);
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
      touched.add(`classroom:${classroomId}`);
      touched.add(`user:${repo.userId}`);
    } catch (err) {
      app.log.warn({ err, repo: repo.fullName }, "reconcile.repos: repo fetch failed");
    }
  }
  if (touched.size > 0) publish("repos", [...touched]);
  return `${rows.length} repositories checked, ${updated} updated`;
}

/** GH-62 : re-enfile les livraisons locales bloquées, redemande les échecs GitHub. */
async function reconcileDeliveries(app: FastifyInstance, config: AppConfig): Promise<string> {
  // 1. Livraisons reçues mais jamais traitées (job perdu, crash) : re-enfilées.
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

  // 2. Livraisons en échec côté GitHub (endpoint down) : redelivery API.
  //    La dédup par X-GitHub-Delivery absorbe les doublons.
  let redelivered = 0;
  const gh = githubApp(config);
  if (gh) {
    let deliveries: { id: number; guid: string; status_code: number; redelivery: boolean; delivered_at: string }[] = [];
    try {
      const res = await gh.octokit.request("GET /app/hook/deliveries", { per_page: 100 });
      deliveries = res.data;
    } catch (err) {
      // 404 : l'App n'a pas de webhook configuré (dev) — rien à réconcilier.
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

/** NFR : volumétrie bornée — sessions expirées, payloads webhooks > 30 j. */
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
