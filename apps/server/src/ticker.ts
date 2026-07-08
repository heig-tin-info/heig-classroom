/**
 * Single ticker (ADR-006): no one-shot scheduled jobs. Every 20 s it re-reads
 * the database and enqueues whatever is due. Rescheduling is free (the
 * condition is re-read), catch-up after an outage is free (the condition
 * stays true). Multi-process safety does not rest on the ticker: every
 * action performs an atomic claim (conditional UPDATE) or goes through a
 * pg-boss singleton.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import type { AppConfig } from "./config.js";
import { assignments, scheduledTasks } from "./db/schema.js";
import { freezeDueAssignments } from "./deadline.js";
import { DEADLINE_QUEUE, TASK_QUEUE } from "./jobs.js";
import { TASK_DEFS } from "./tasks.js";

const TICK_MS = 20_000;

export function startTicker(app: FastifyInstance, _config: AppConfig) {
  let running = false;

  const tick = async () => {
    if (running || !app.boss) return; // no overlap, no queue
    running = true;
    try {
      // 1. Elapsed deadlines (GH-43): published, past due, not yet applied.
      const due = await app.db
        .select({ id: assignments.id })
        .from(assignments)
        .where(
          and(
            eq(assignments.state, "published"),
            isNull(assignments.deadlineAppliedAt),
            lte(assignments.deadlineAt, sql`now()`),
            isNull(assignments.archivedAt),
          ),
        );
      for (const { id } of due) {
        await app.boss.send(
          DEADLINE_QUEUE,
          { assignmentId: id },
          { singletonKey: id, retryLimit: 5, retryBackoff: true, retryDelay: 10 },
        );
      }

      // 2. Definitive freeze at deadline + grace (ADR-012).
      await freezeDueAssignments(app);

      // 3. Scheduled tasks: atomic claim (last_run_at set by the conditional
      //    UPDATE), execution goes to the queue with a singleton.
      const claimed = await app.db
        .update(scheduledTasks)
        .set({ lastRunAt: sql`now()`, lastStatus: "running" })
        .where(
          and(
            eq(scheduledTasks.enabled, true),
            inArray(scheduledTasks.key, TASK_DEFS.map((t) => t.key)),
            or(
              isNull(scheduledTasks.lastRunAt),
              sql`${scheduledTasks.lastRunAt} + make_interval(mins => ${scheduledTasks.intervalMinutes}) <= now()`,
            ),
          ),
        )
        .returning({ key: scheduledTasks.key });
      for (const { key } of claimed) {
        await app.boss.send(TASK_QUEUE, { key }, { singletonKey: key });
      }
    } catch (err) {
      app.log.error({ err }, "ticker tick failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
  void tick(); // immediate first pass (catch-up after a restart)
}
