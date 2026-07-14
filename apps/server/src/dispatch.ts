/**
 * Authoritative LLM review dispatcher (GR-16). Once an assignment's grade is
 * frozen (deadline + grace, ADR-012), the ticker enqueues `grade.dispatch`;
 * this handler fires ONE `repository_dispatch` (event `grade-final`) per
 * student repository, carrying the frozen commit in the client_payload. The
 * student repo's grading.yml reacts by running the llm-review job, whose
 * completed run comes back through the regular GR-05 ingestion as a `llm`
 * grade run.
 *
 * Idempotence is the grade_dispatches ledger: the row is claimed (unique
 * index + ON CONFLICT DO NOTHING) BEFORE calling GitHub, so a concurrent
 * worker never double-fires; a crash between the claim and the API call
 * leaves `dispatched_at` null and the row is retried on the next pass
 * (at-least-once, like every GR-* job).
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";

import { audit } from "./audit.js";
import type { AppConfig } from "./config.js";
import {
  assignmentMilestones,
  assignments,
  classrooms,
  gradeDispatches,
  gradeRuns,
  organizations,
  pushReceipts,
  studentRepos,
} from "./db/schema.js";
import { publish } from "./events.js";
import { installationClient } from "./github/app.js";

export interface GradeDispatchJob {
  assignmentId: string;
  /** Present for intermediate reviews (grade-milestone); absent = deadline. */
  milestoneId?: string;
  [key: string]: unknown;
}

export interface DispatchPlan {
  /** Frozen commit to review (client_payload.sha). */
  sha: string;
  eventType: "grade-final";
  clientPayload: {
    sha: string;
    assignment_id: string;
    deadline: string;
    trigger: "deadline";
  };
}

/**
 * Pure decision: what to dispatch for one repository. Null when there is
 * nothing to review (no frozen grade run → the student never produced an
 * eligible run; the LLM has nothing to grade).
 */
export function planDispatch(
  assignment: { id: string; deadlineAt: Date },
  frozenSha: string | null,
): DispatchPlan | null {
  if (!frozenSha) return null;
  return {
    sha: frozenSha,
    eventType: "grade-final",
    clientPayload: {
      sha: frozenSha,
      assignment_id: assignment.id,
      deadline: assignment.deadlineAt.toISOString(),
      trigger: "deadline",
    },
  };
}

export interface MilestoneDispatchPlan {
  /** Last commit received before the milestone (client_payload.sha). */
  sha: string;
  eventType: "grade-milestone";
  clientPayload: {
    sha: string;
    assignment_id: string;
    milestone_id: string;
    /** Tag matched by criteria.yml `milestone:` entries (score --milestone). */
    milestone: string;
    due: string;
    trigger: "milestone";
  };
}

/**
 * Pure decision for one repository at a milestone. Null when the student
 * never pushed before the milestone — nothing to review, like the missing
 * frozen run of the deadline flow.
 */
export function planMilestoneDispatch(
  assignmentId: string,
  milestone: { id: string; name: string; dueAt: Date },
  sha: string | null,
): MilestoneDispatchPlan | null {
  if (!sha) return null;
  return {
    sha,
    eventType: "grade-milestone",
    clientPayload: {
      sha,
      assignment_id: assignmentId,
      milestone_id: milestone.id,
      milestone: milestone.name,
      due: milestone.dueAt.toISOString(),
      trigger: "milestone",
    },
  };
}

/**
 * The commit an intermediate review grades: last student (non-bot) push on a
 * selected branch received before the milestone — same server-receipt
 * legality as the GR-14 freeze.
 */
export async function milestoneShaForRepo(
  app: FastifyInstance,
  studentRepoId: string,
  branches: string[],
  before: Date,
): Promise<string | null> {
  const [row] = await app.db
    .select({ sha: pushReceipts.headSha })
    .from(pushReceipts)
    .where(
      and(
        eq(pushReceipts.studentRepoId, studentRepoId),
        eq(pushReceipts.isBot, false),
        inArray(pushReceipts.branch, branches),
        lte(pushReceipts.receivedAt, before),
      ),
    )
    .orderBy(desc(pushReceipts.receivedAt))
    .limit(1);
  return row?.sha ?? null;
}

export function makeGradeDispatchHandler(app: FastifyInstance, config: AppConfig) {
  return async ({ assignmentId, milestoneId }: GradeDispatchJob) => {
    if (milestoneId) return dispatchMilestone(app, config, assignmentId, milestoneId);
    const [row] = await app.db
      .select({
        assignment: assignments,
        classroomId: classrooms.id,
        installationId: organizations.installationId,
      })
      .from(assignments)
      .innerJoin(classrooms, eq(assignments.classroomId, classrooms.id))
      .innerJoin(organizations, eq(classrooms.orgId, organizations.id))
      .where(eq(assignments.id, assignmentId))
      .limit(1);
    if (!row || row.assignment.archivedAt) return;
    const a = row.assignment;
    // Re-read the condition (ADR-006): dispatch only after the definitive
    // freeze, exactly once per assignment.
    if (!a.frozenAt || a.llmDispatchedAt) return;
    if (row.installationId === null) return;

    const repos = await app.db
      .select({
        repo: studentRepos,
        frozenSha: gradeRuns.headSha,
      })
      .from(studentRepos)
      .leftJoin(gradeRuns, eq(gradeRuns.id, studentRepos.frozenGradeRunId))
      .where(
        and(
          eq(studentRepos.assignmentId, a.id),
          eq(studentRepos.provisionStatus, "ok"),
          isNotNull(studentRepos.fullName),
        ),
      );

    const client = await installationClient(config, row.installationId);
    const failures: string[] = [];
    let dispatched = 0;
    let skipped = 0;

    for (const { repo, frozenSha } of repos) {
      const plan = planDispatch(a, frozenSha);
      if (!plan) {
        skipped += 1;
        continue;
      }
      try {
        // Claim before the API call; a pre-existing row already dispatched
        // means another pass (or worker) did the job.
        const claimed = await app.db
          .insert(gradeDispatches)
          .values({
            id: randomUUID(),
            studentRepoId: repo.id,
            trigger: "deadline",
            sha: plan.sha,
          })
          .onConflictDoNothing()
          .returning({ id: gradeDispatches.id });
        let dispatchId = claimed[0]?.id ?? null;
        if (!dispatchId) {
          const [existing] = await app.db
            .select({ id: gradeDispatches.id, dispatchedAt: gradeDispatches.dispatchedAt })
            .from(gradeDispatches)
            .where(
              and(
                eq(gradeDispatches.studentRepoId, repo.id),
                eq(gradeDispatches.trigger, "deadline"),
                isNull(gradeDispatches.milestoneId),
              ),
            )
            .limit(1);
          if (!existing || existing.dispatchedAt) continue; // already fired
          dispatchId = existing.id; // crash between claim and call: retry
        }

        const [owner, repoName] = repo.fullName!.split("/") as [string, string];
        await client.octokit.request("POST /repos/{owner}/{repo}/dispatches", {
          owner,
          repo: repoName,
          event_type: plan.eventType,
          client_payload: plan.clientPayload,
        });
        await app.db
          .update(gradeDispatches)
          .set({ dispatchedAt: new Date() })
          .where(eq(gradeDispatches.id, dispatchId));
        dispatched += 1;
      } catch (err) {
        app.log.error({ err, repo: repo.fullName }, "grade dispatch failed for repo");
        failures.push(repo.fullName!);
      }
    }

    await audit(app.db, {
      actorType: "system",
      action: "assignment.llm_review_dispatched",
      subjectType: "assignment",
      subjectId: a.id,
      payload: { repos: repos.length, dispatched, skipped, failures },
    });
    publish("assignments", [`classroom:${row.classroomId}`], {
      kind: "llm_review_dispatched",
      message: `LLM review requested on “${a.name}” (${dispatched}/${repos.length} repositories)`,
    });

    // Failed repositories retry via pg-boss; already-dispatched ones are
    // skipped by the ledger on the next pass.
    if (failures.length > 0) {
      throw new Error(`grade dispatch incomplete: ${failures.join(", ")}`);
    }
    await app.db
      .update(assignments)
      .set({ llmDispatchedAt: new Date() })
      .where(and(eq(assignments.id, a.id), isNull(assignments.llmDispatchedAt)));
  };
}

/**
 * Intermediate review at a milestone: same claim-then-call ledger as the
 * deadline flow, keyed (repo, milestone, `milestone` trigger). The resulting
 * llm run is trace-only: ingestion never lets it claim `llm_grade_run_id`
 * before the assignment is frozen (see ingestCompletedRun).
 */
async function dispatchMilestone(
  app: FastifyInstance,
  config: AppConfig,
  assignmentId: string,
  milestoneId: string,
) {
  const [row] = await app.db
    .select({
      assignment: assignments,
      classroomId: classrooms.id,
      installationId: organizations.installationId,
    })
    .from(assignments)
    .innerJoin(classrooms, eq(assignments.classroomId, classrooms.id))
    .innerJoin(organizations, eq(classrooms.orgId, organizations.id))
    .where(eq(assignments.id, assignmentId))
    .limit(1);
  if (!row || row.assignment.archivedAt) return;
  const a = row.assignment;
  const [milestone] = await app.db
    .select()
    .from(assignmentMilestones)
    .where(
      and(eq(assignmentMilestones.id, milestoneId), eq(assignmentMilestones.assignmentId, a.id)),
    )
    .limit(1);
  if (!milestone || milestone.dispatchedAt) return;
  // Re-read the condition (ADR-006): the milestone may have been moved
  // between the ticker sweep and the execution.
  if (milestone.dueAt.getTime() > Date.now()) return;
  // Past the freeze the authoritative grade-final review owns the field: a
  // late milestone (deadline moved earlier than an absolute date) never fires.
  if (a.frozenAt) return;
  if (row.installationId === null) return;

  const repos = await app.db
    .select()
    .from(studentRepos)
    .where(
      and(
        eq(studentRepos.assignmentId, a.id),
        eq(studentRepos.provisionStatus, "ok"),
        isNotNull(studentRepos.fullName),
      ),
    );

  const client = await installationClient(config, row.installationId);
  const failures: string[] = [];
  let dispatched = 0;
  let skipped = 0;

  for (const repo of repos) {
    const sha = await milestoneShaForRepo(app, repo.id, a.branches, milestone.dueAt);
    const plan = planMilestoneDispatch(a.id, milestone, sha);
    if (!plan) {
      skipped += 1;
      continue;
    }
    try {
      const claimed = await app.db
        .insert(gradeDispatches)
        .values({
          id: randomUUID(),
          studentRepoId: repo.id,
          trigger: "milestone",
          milestoneId: milestone.id,
          sha: plan.sha,
        })
        .onConflictDoNothing()
        .returning({ id: gradeDispatches.id });
      let dispatchId = claimed[0]?.id ?? null;
      if (!dispatchId) {
        const [existing] = await app.db
          .select({ id: gradeDispatches.id, dispatchedAt: gradeDispatches.dispatchedAt })
          .from(gradeDispatches)
          .where(
            and(
              eq(gradeDispatches.studentRepoId, repo.id),
              eq(gradeDispatches.trigger, "milestone"),
              eq(gradeDispatches.milestoneId, milestone.id),
            ),
          )
          .limit(1);
        if (!existing || existing.dispatchedAt) continue; // already fired
        dispatchId = existing.id; // crash between claim and call: retry
      }

      const [owner, repoName] = repo.fullName!.split("/") as [string, string];
      await client.octokit.request("POST /repos/{owner}/{repo}/dispatches", {
        owner,
        repo: repoName,
        event_type: plan.eventType,
        client_payload: plan.clientPayload,
      });
      await app.db
        .update(gradeDispatches)
        .set({ dispatchedAt: new Date() })
        .where(eq(gradeDispatches.id, dispatchId));
      dispatched += 1;
    } catch (err) {
      app.log.error({ err, repo: repo.fullName }, "milestone dispatch failed for repo");
      failures.push(repo.fullName!);
    }
  }

  await audit(app.db, {
    actorType: "system",
    action: "assignment.milestone_dispatched",
    subjectType: "assignment",
    subjectId: a.id,
    payload: { milestone: milestone.name, repos: repos.length, dispatched, skipped, failures },
  });
  publish("assignments", [`classroom:${row.classroomId}`], {
    kind: "llm_review_dispatched",
    message: `Milestone “${milestone.name}” review requested on “${a.name}” (${dispatched}/${repos.length} repositories)`,
  });

  // Failed repositories retry via pg-boss; the ledger skips the others.
  if (failures.length > 0) {
    throw new Error(`milestone dispatch incomplete: ${failures.join(", ")}`);
  }
  await app.db
    .update(assignmentMilestones)
    .set({ dispatchedAt: new Date() })
    .where(and(eq(assignmentMilestones.id, milestone.id), isNull(assignmentMilestones.dispatchedAt)));
}
