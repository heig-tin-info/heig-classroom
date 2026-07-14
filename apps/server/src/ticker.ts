/**
 * Single ticker (ADR-006): no one-shot scheduled jobs. Every 20 s it re-reads
 * the database and enqueues whatever is due. Rescheduling is free (the
 * condition is re-read), catch-up after an outage is free (the condition
 * stays true). Multi-process safety does not rest on the ticker: every
 * action performs an atomic claim (conditional UPDATE) or goes through a
 * pg-boss singleton.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";

import type { AppConfig } from "./config.js";
import { assignmentMilestones, assignments, classrooms, scheduledTasks } from "./db/schema.js";
import { freezeDueAssignments } from "./deadline.js";
import { zurichIso } from "./github/commit.js";
import { DEADLINE_QUEUE, GRADE_DISPATCH_QUEUE, TASK_QUEUE } from "./jobs.js";
import { classroomRecipients, queueEmail } from "./mailer.js";
import { TASK_DEFS } from "./tasks.js";

const TICK_MS = 20_000;

export function startTicker(app: FastifyInstance, config: AppConfig) {
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

      // 1b. J-1 email reminder: published, due within 24 h, not yet reminded.
      //     The conditional UPDATE is the atomic claim — one shot even with
      //     several workers; rescheduling far enough resets nothing (the
      //     reminder already went out for that deadline).
      const remind = await app.db
        .update(assignments)
        .set({ reminderSentAt: sql`now()` })
        .where(
          and(
            eq(assignments.state, "published"),
            isNull(assignments.deadlineAppliedAt),
            isNull(assignments.reminderSentAt),
            isNull(assignments.archivedAt),
            lte(assignments.deadlineAt, sql`now() + interval '24 hours'`),
            sql`${assignments.deadlineAt} > now()`,
          ),
        )
        .returning({
          id: assignments.id,
          name: assignments.name,
          deadlineAt: assignments.deadlineAt,
          classroomId: assignments.classroomId,
        });
      for (const a of remind) {
        const [room] = await app.db
          .select({ name: classrooms.name })
          .from(classrooms)
          .where(eq(classrooms.id, a.classroomId))
          .limit(1);
        for (const student of await classroomRecipients(app, a.classroomId)) {
          await queueEmail(app, config, student, "deadline.reminder", {
            assignmentName: a.name,
            classroomName: room?.name ?? "",
            deadlineAt: zurichIso(a.deadlineAt),
          });
        }
      }

      // 2. Definitive freeze at deadline + grace (ADR-012).
      await freezeDueAssignments(app);

      // 2b. Authoritative LLM review (GR-16): frozen, not yet dispatched.
      //     The handler re-reads the condition and claims per-repo rows, so
      //     enqueueing the same assignment twice is harmless.
      const reviewDue = await app.db
        .select({ id: assignments.id })
        .from(assignments)
        .where(
          and(
            isNotNull(assignments.frozenAt),
            isNull(assignments.llmDispatchedAt),
            isNull(assignments.archivedAt),
          ),
        );
      for (const { id } of reviewDue) {
        await app.boss.send(
          GRADE_DISPATCH_QUEUE,
          { assignmentId: id },
          { singletonKey: id, retryLimit: 5, retryBackoff: true, retryDelay: 30 },
        );
      }

      // 2c. Intermediate reviews (milestones): due, not yet dispatched, on a
      //     live (published or locked) assignment. The handler re-reads the
      //     condition and claims per-repo ledger rows (trigger `milestone`),
      //     so double-enqueueing is harmless.
      const milestonesDue = await app.db
        .select({ id: assignmentMilestones.id, assignmentId: assignmentMilestones.assignmentId })
        .from(assignmentMilestones)
        .innerJoin(assignments, eq(assignmentMilestones.assignmentId, assignments.id))
        .where(
          and(
            isNull(assignmentMilestones.dispatchedAt),
            lte(assignmentMilestones.dueAt, sql`now()`),
            ne(assignments.state, "draft"),
            isNull(assignments.archivedAt),
          ),
        );
      for (const m of milestonesDue) {
        await app.boss.send(
          GRADE_DISPATCH_QUEUE,
          { assignmentId: m.assignmentId, milestoneId: m.id },
          { singletonKey: m.id, retryLimit: 5, retryBackoff: true, retryDelay: 30 },
        );
      }

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
