/**
 * Ticker unique (ADR-006) : pas de job one-shot planifié — toutes les 20 s,
 * il relit la base et enfile ce qui est dû. Replanification gratuite (la
 * condition est relue), rattrapage après panne gratuit (la condition reste
 * vraie). La sûreté multi-processus ne repose pas sur le ticker : chaque
 * action fait un claim atomique (UPDATE conditionnel) ou passe par un
 * singleton pg-boss.
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
    if (running || !app.boss) return; // pas de chevauchement, pas de file
    running = true;
    try {
      // 1. Deadlines échues (GH-43) : publiés, échus, non appliqués.
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

      // 2. Gel définitif à deadline + grace (ADR-012).
      await freezeDueAssignments(app);

      // 3. Tâches planifiées : claim atomique (last_run_at posé par l'UPDATE
      //    conditionnel), l'exécution part dans la file avec un singleton.
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
  void tick(); // premier passage immédiat (rattrapage post-redémarrage)
}
