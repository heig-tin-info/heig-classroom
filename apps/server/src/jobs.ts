/**
 * File de jobs pg-boss (ADR-004) : Postgres est l'unique composant stateful.
 * L'endpoint webhook acquitte vite, les handlers font le travail réel ici,
 * avec retries à backoff exponentiel puis dead-letter (visible en base).
 */
import { PgBoss } from "pg-boss";

import type { FastifyInstance } from "fastify";

export const WEBHOOK_QUEUE = "webhook.process";
export const DEADLINE_QUEUE = "deadline.apply";
export const TASK_QUEUE = "task.run";

export interface WebhookJob {
  deliveryId: string;
  [key: string]: unknown;
}

export interface TaskJob {
  key: string;
  [key: string]: unknown;
}

export async function startJobs(
  app: FastifyInstance,
  opts: {
    connectionString: string;
    runWorkers: boolean;
    webhookHandler: (job: WebhookJob) => Promise<void>;
    deadlineHandler: (job: { assignmentId: string }) => Promise<void>;
    taskRunner: (key: string) => Promise<void>;
  },
) {
  const boss = new PgBoss({
    connectionString: opts.connectionString,
    // Le schéma pgboss.* vit dans la même base (NFR-16 : un seul backup).
  });
  boss.on("error", (err: Error) => app.log.error({ err }, "pg-boss error"));
  await boss.start();
  await boss.createQueue(WEBHOOK_QUEUE, {
    retryLimit: 5,
    retryBackoff: true,
    retryDelay: 5,
  });
  await boss.createQueue(DEADLINE_QUEUE, {
    retryLimit: 5,
    retryBackoff: true,
    retryDelay: 10,
  });
  // L'échec d'une tâche planifiée n'est pas retenté par la file : le statut
  // est journalisé et le passage suivant du ticker retentera.
  await boss.createQueue(TASK_QUEUE, { retryLimit: 0 });

  if (opts.runWorkers) {
    await boss.work<WebhookJob>(WEBHOOK_QUEUE, async (jobs) => {
      for (const job of jobs) await opts.webhookHandler(job.data);
    });
    await boss.work<{ assignmentId: string }>(DEADLINE_QUEUE, async (jobs) => {
      for (const job of jobs) await opts.deadlineHandler(job.data);
    });
    await boss.work<TaskJob>(TASK_QUEUE, async (jobs) => {
      for (const job of jobs) await opts.taskRunner(job.data.key);
    });
  }

  app.decorate("boss", boss);
  app.addHook("onClose", async () => {
    await boss.stop({ close: true, timeout: 5000 });
  });
  return boss;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Absent si le démarrage de la file a échoué (base injoignable au boot). */
    boss?: PgBoss;
  }
}
