/**
 * Deadline application (M4, GH-40..44, ADR-006/012). The ticker enqueues
 * `deadline.apply` per due assignment; this handler is idempotent: every
 * repository already handled is skipped, an individual failure leaves the
 * job in retry without blocking the others (GH-43).
 */
import type { FastifyInstance } from "fastify";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { audit } from "./audit.js";
import type { AppConfig } from "./config.js";
import { assignments, botCommits, classrooms, organizations, studentRepos } from "./db/schema.js";
import { publish } from "./events.js";
import { installationClient } from "./github/app.js";
import { pushEmptyCommit, zurichIso } from "./github/commit.js";
import { lockStudentRepo } from "./github/lock.js";
import { selectGradeRun } from "./grading.js";

export interface DeadlineJob {
  assignmentId: string;
  [key: string]: unknown;
}

export function makeDeadlineHandler(app: FastifyInstance, config: AppConfig) {
  return async ({ assignmentId }: DeadlineJob) => {
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
    // Rescheduling (US-08): the deadline may have been pushed back between
    // the ticker sweep and the execution, so the condition is re-read here.
    if (a.deadlineAt.getTime() > Date.now()) return;
    if (a.state === "draft") return;

    // Atomic claim: `deadline_applied_at` is set only once, but processing
    // continues even without the claim (resuming repositories that failed).
    await app.db
      .update(assignments)
      .set({ deadlineAppliedAt: new Date(), state: "locked" })
      .where(and(eq(assignments.id, a.id), isNull(assignments.deadlineAppliedAt)));

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

    // Provisional freeze (GR-12): the current grade at deadline time.
    // During the grace period, runs on commits received before the deadline
    // can still improve it (GR-14.4, via refreshGradeSelection); `frozen_at`
    // makes it definitively immutable.
    if (!a.frozenAt) {
      for (const repo of repos) {
        const selected = await selectGradeRun(app, repo.id);
        await app.db
          .update(studentRepos)
          .set({ frozenGradeRunId: selected })
          .where(eq(studentRepos.id, repo.id));
      }
    }

    if (repos.length === 0 || row.installationId === null) {
      publish("assignments", [`classroom:${row.classroomId}`]);
      return;
    }

    const client = await installationClient(config, row.installationId);
    const message = `chore(deadline): deadline reached — ${a.name} (${zurichIso(a.deadlineAt)})`;
    const failures: string[] = [];

    for (const repo of repos) {
      const [org, repoName] = repo.fullName!.split("/") as [string, string];
      try {
        if (a.deadlineStrategy === "lock") {
          if (repo.lockedAt) continue; // already locked, idempotent
          let rulesetId: number | null = null;
          try {
            rulesetId = await lockStudentRepo(client.octokit, org, repoName);
          } catch (err) {
            // Fallback H8: rulesets unavailable → archive (degraded mode,
            // also removes write access from the bot and the teacher, GH-41).
            app.log.warn({ err, repo: repo.fullName }, "ruleset lock failed, archiving");
            await client.octokit.request("PATCH /repos/{owner}/{repo}", {
              owner: org,
              repo: repoName,
              archived: true,
            });
            await audit(app.db, {
              actorType: "system",
              action: "repo.deadline_archived",
              subjectType: "student_repo",
              subjectId: repo.id,
              payload: { assignmentId: a.id },
            });
          }
          await app.db
            .update(studentRepos)
            .set({ lockedAt: new Date(), rulesetId })
            .where(eq(studentRepos.id, repo.id));
        } else {
          // Commit strategy: one empty bot commit per selected branch.
          const done = await app.db
            .select({ sha: botCommits.sha })
            .from(botCommits)
            .where(
              and(
                eq(botCommits.studentRepoId, repo.id),
                eq(botCommits.kind, "deadline"),
                sql`${botCommits.createdAt} >= ${a.deadlineAt}`,
              ),
            )
            .limit(1);
          if (done.length > 0) continue; // already marked, idempotent
          for (const branch of a.branches) {
            const sha = await pushEmptyCommit({
              octokit: client.octokit,
              org,
              repo: repoName,
              branch,
              message,
            });
            if (sha) {
              await app.db
                .insert(botCommits)
                .values({ studentRepoId: repo.id, sha, kind: "deadline" })
                .onConflictDoNothing();
            }
          }
        }
      } catch (err) {
        app.log.error({ err, repo: repo.fullName }, "deadline apply failed for repo");
        failures.push(repo.fullName!);
      }
    }

    await audit(app.db, {
      actorType: "system",
      action: "assignment.deadline_applied",
      subjectType: "assignment",
      subjectId: a.id,
      payload: {
        strategy: a.deadlineStrategy,
        repos: repos.length,
        failures,
      },
    });
    publish("assignments", [`classroom:${row.classroomId}`]);
    publish(
      "repos",
      repos.map((r) => `user:${r.userId}`).concat(`classroom:${row.classroomId}`),
    );
    // Failed repositories still need handling: pg-boss retries, and repos
    // already locked/marked are skipped on the next pass.
    if (failures.length > 0) {
      throw new Error(`deadline apply incomplete: ${failures.join(", ")}`);
    }
  };
}

/**
 * Definitive freeze (GR-12/14.4, ADR-012): at `deadline + grace_minutes` the
 * frozen grade becomes immutable. In M4 the milestone sets `frozen_at` (the
 * assignment no longer moves); selecting the frozen GradeRun comes with M5.
 */
export async function freezeDueAssignments(app: FastifyInstance): Promise<number> {
  const frozen = await app.db
    .update(assignments)
    .set({ frozenAt: new Date() })
    .where(
      and(
        isNotNull(assignments.deadlineAppliedAt),
        isNull(assignments.frozenAt),
        sql`${assignments.deadlineAt} + make_interval(mins => ${assignments.graceMinutes}) <= now()`,
      ),
    )
    .returning({ id: assignments.id, classroomId: assignments.classroomId });
  for (const a of frozen) {
    await audit(app.db, {
      actorType: "system",
      action: "assignment.frozen",
      subjectType: "assignment",
      subjectId: a.id,
    });
    publish("assignments", [`classroom:${a.classroomId}`]);
  }
  return frozen.length;
}
