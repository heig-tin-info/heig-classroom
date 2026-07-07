/**
 * File de jobs pg-boss (ADR-004) : Postgres est l'unique composant stateful.
 * L'endpoint webhook acquitte vite, les handlers font le travail réel ici,
 * avec retries à backoff exponentiel puis dead-letter (visible en base).
 */
import { PgBoss } from "pg-boss";

import type { FastifyInstance } from "fastify";

export const WEBHOOK_QUEUE = "webhook.process";

export interface WebhookJob {
  deliveryId: string;
  [key: string]: unknown;
}

export async function startJobs(
  app: FastifyInstance,
  opts: {
    connectionString: string;
    runWorkers: boolean;
    handler: (job: WebhookJob) => Promise<void>;
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

  if (opts.runWorkers) {
    await boss.work<WebhookJob>(WEBHOOK_QUEUE, async (jobs) => {
      for (const job of jobs) {
        await opts.handler(job.data);
      }
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
    boss: PgBoss;
  }
}
