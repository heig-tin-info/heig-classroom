/**
 * pg-boss job queue (ADR-004): Postgres is the only stateful component.
 * The webhook endpoint acknowledges fast, the handlers do the real work here,
 * with exponential-backoff retries then dead-letter (visible in the database).
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
    // The pgboss.* schema lives in the same database (NFR-16: a single backup).
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
  // A failed scheduled task is not retried by the queue: the status is
  // recorded and the next ticker pass will retry it.
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
    /** Absent if the queue failed to start (database unreachable at boot). */
    boss?: PgBoss;
  }
}
