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
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { audit } from "./audit.js";
import type { AppConfig } from "./config.js";
import {
  assignments,
  classrooms,
  gradeDispatches,
  gradeRuns,
  organizations,
  studentRepos,
} from "./db/schema.js";
import { publish } from "./events.js";
import { installationClient } from "./github/app.js";

export interface GradeDispatchJob {
  assignmentId: string;
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

export function makeGradeDispatchHandler(app: FastifyInstance, config: AppConfig) {
  return async ({ assignmentId }: GradeDispatchJob) => {
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
