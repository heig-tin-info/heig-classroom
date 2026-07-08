/**
 * Application de la deadline (M4, GH-40..44, ADR-006/012). Le ticker enfile
 * `deadline.apply` par assignment échu ; ce handler est idempotent : chaque
 * dépôt déjà traité est sauté, un échec individuel laisse le job en retry
 * sans bloquer les autres (GH-43).
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
    // Replanification (US-08) : la deadline a pu être repoussée entre le
    // sweep du ticker et l'exécution — la condition est relue ici.
    if (a.deadlineAt.getTime() > Date.now()) return;
    if (a.state === "draft") return;

    // Claim atomique : `deadline_applied_at` n'est posé qu'une fois, mais le
    // traitement continue même sans claim (reprise des dépôts en échec).
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

    // Gel provisoire (GR-12) : la note courante au moment de la deadline.
    // Pendant la grâce, les runs sur commits reçus avant la deadline peuvent
    // encore l'améliorer (GR-14.4, via refreshGradeSelection) ; `frozen_at`
    // la fige définitivement.
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
          if (repo.lockedAt) continue; // déjà verrouillé — idempotent
          let rulesetId: number | null = null;
          try {
            rulesetId = await lockStudentRepo(client.octokit, org, repoName);
          } catch (err) {
            // Fallback H8 : rulesets indisponibles → archivage (mode dégradé,
            // retire aussi l'écriture au bot et au teacher — GH-41).
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
          // Stratégie commit : un commit vide bot par branche sélectionnée.
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
          if (done.length > 0) continue; // déjà marqué — idempotent
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
    // Les dépôts en échec restent à traiter : retry pg-boss, les dépôts déjà
    // verrouillés/marqués sont sautés au passage suivant.
    if (failures.length > 0) {
      throw new Error(`deadline apply incomplete: ${failures.join(", ")}`);
    }
  };
}

/**
 * Gel définitif (GR-12/14.4, ADR-012) : à `deadline + grace_minutes`, la note
 * gelée devient immuable. En M4 le jalon pose `frozen_at` (l'assignment ne
 * bouge plus) ; la sélection du GradeRun gelé arrive avec M5.
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
