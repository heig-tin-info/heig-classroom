/** Assignment read views: detail table, grade-run history, repo activity. */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

import type { AppConfig } from "../../config.js";
import { enrollments, gradeRuns, studentRepos, users } from "../../db/schema.js";
import { installationClient } from "../../github/app.js";
import { fetchRepoLiveState, type RepoLiveState } from "../../github/metrics.js";
import { gradeView, gradeViewsByIds } from "../../grading.js";
import { ownedAssignment, ownedStudentRepo, teacherGuard } from "../guards.js";

export async function assignmentDetailRoutes(
  app: FastifyInstance,
  opts: { config: AppConfig },
) {
  const { config } = opts;
  const requireTeacher = teacherGuard(app);

  // --- Detail: roster x acceptances, live state of repositories (US-13/GR-15) ---
  // Without webhooks (M3), the state is fetched from GitHub on open then
  // cached in student_repos; same logic as the future reconciliation.
  app.get(
    "/app/api/classrooms/:id/assignments/:aid/detail",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedAssignment(app, req, reply);
      if (!owned) return reply;
      const a = owned.assignment;

      const roster = await app.db
        .select({
          enrollmentId: enrollments.id,
          nom: enrollments.nom,
          prenom: enrollments.prenom,
          email: enrollments.email,
          status: enrollments.status,
          userId: enrollments.userId,
          githubLogin: users.githubLogin,
        })
        .from(enrollments)
        .leftJoin(users, eq(enrollments.userId, users.id))
        .where(eq(enrollments.classroomId, a.classroomId))
        .orderBy(enrollments.nom, enrollments.prenom);

      const repos = await app.db
        .select()
        .from(studentRepos)
        .where(eq(studentRepos.assignmentId, a.id));

      // Current and frozen grades (GR-11) in a single query.
      const grades = await gradeViewsByIds(
        app,
        repos.flatMap((r) => [r.currentGradeRunId, r.frozenGradeRunId, r.llmGradeRunId]),
      );

      const live = new Map<string, RepoLiveState>();

      const provisioned = repos.filter((r) => r.provisionStatus === "ok" && r.fullName);
      if (provisioned.length > 0 && owned.org.installationId !== null) {
        const client = await installationClient(config, owned.org.installationId);
        await Promise.all(
          provisioned.map(async (r) => {
            try {
              const state = await fetchRepoLiveState(client.octokit, r.fullName!);
              if (!state) return;
              live.set(r.id, state);
              if (state.lastCommitSha) {
                await app.db
                  .update(studentRepos)
                  .set({
                    lastCommitSha: state.lastCommitSha,
                    lastCommitAt: state.lastCommitAt ? new Date(state.lastCommitAt) : null,
                    ciStatus: state.ciStatus,
                  })
                  .where(eq(studentRepos.id, r.id));
              }
            } catch (err) {
              req.log.warn({ err, repo: r.fullName }, "live state fetch failed");
            }
          }),
        );
      }

      return {
        assignment: a,
        students: roster.map((s) => {
          const repo = s.userId ? repos.find((r) => r.userId === s.userId) : undefined;
          return {
            enrollmentId: s.enrollmentId,
            nom: s.nom,
            prenom: s.prenom,
            email: s.email,
            claimStatus: s.status,
            githubLogin: s.githubLogin,
            repo: repo
              ? {
                  id: repo.id,
                  fullName: repo.fullName,
                  provisionStatus: repo.provisionStatus,
                  provisionError: repo.provisionError,
                  invitationStatus: repo.invitationStatus,
                  acceptedAt: repo.acceptedAt,
                  lockedAt: repo.lockedAt,
                  syncPr:
                    repo.syncPrNumber !== null
                      ? { number: repo.syncPrNumber, state: repo.syncPrState }
                      : null,
                  grade: repo.currentGradeRunId
                    ? (grades.get(repo.currentGradeRunId) ?? null)
                    : null,
                  frozenGrade: repo.frozenGradeRunId
                    ? (grades.get(repo.frozenGradeRunId) ?? null)
                    : null,
                  llmGrade: repo.llmGradeRunId
                    ? (grades.get(repo.llmGradeRunId) ?? null)
                    : null,
                  ...(live.get(repo.id) ?? {
                    lastCommitSha: repo.lastCommitSha,
                    lastCommitAt: repo.lastCommitAt,
                    commitCount: null,
                    checksPassed: null,
                    checksTotal: null,
                    ciStatus: repo.ciStatus,
                  }),
                }
              : null,
          };
        }),
      };
    },
  );

  // --- GradeRun history of a repository (GR-11/13, after-deadline badge) ---
  app.get(
    "/app/api/classrooms/:id/assignments/:aid/repos/:rid/grade-runs",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedAssignment(app, req, reply);
      if (!owned) return reply;
      const params = z.object({ rid: z.uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const [repo] = await app.db
        .select()
        .from(studentRepos)
        .where(
          and(
            eq(studentRepos.id, params.data.rid),
            eq(studentRepos.assignmentId, owned.assignment.id),
          ),
        )
        .limit(1);
      if (!repo) return reply.code(404).send({ error: "not_found" });
      const runs = await app.db
        .select()
        .from(gradeRuns)
        .where(eq(gradeRuns.studentRepoId, repo.id))
        .orderBy(desc(gradeRuns.completedAt))
        .limit(100);
      return {
        currentGradeRunId: repo.currentGradeRunId,
        frozenGradeRunId: repo.frozenGradeRunId,
        llmGradeRunId: repo.llmGradeRunId,
        runs: runs.map((r) => ({
          id: r.id,
          workflowRunId: r.workflowRunId,
          runAttempt: r.runAttempt,
          ...gradeView(r),
        })),
      };
    },
  );

  // --- Repository activity for the expandable row: commits across every
  //     branch (with parents, so the client can draw a git graph), the branch
  //     heads, and the test counters of every captured grading run. ---
  app.get(
    "/app/api/classrooms/:id/assignments/:aid/repos/:rid/activity",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedStudentRepo(app, req, reply);
      if (!owned) return reply;
      const empty = { commits: [], branches: [], tests: [] };
      if (owned.org.installationId === null) return empty;
      const client = await installationClient(config, owned.org.installationId);
      const repoName = owned.repo.fullName!.split("/")[1]!;

      // Test counters over time (TESTS annotation, score ≥ 0.7.2).
      const tests = await app.db
        .select({
          date: gradeRuns.completedAt,
          passed: gradeRuns.testsPassed,
          total: gradeRuns.testsTotal,
        })
        .from(gradeRuns)
        .where(and(eq(gradeRuns.studentRepoId, owned.repo.id), isNotNull(gradeRuns.testsTotal)))
        .orderBy(gradeRuns.completedAt);

      try {
        const { data: branchData } = await client.octokit.request(
          "GET /repos/{owner}/{repo}/branches",
          { owner: owned.org.login, repo: repoName, per_page: 10 },
        );
        const branches = branchData.map((b) => ({ name: b.name, headSha: b.commit.sha }));
        // One listing per branch (capped), merged by sha: enough to draw the
        // graph without walking the whole object database.
        const bySha = new Map<
          string,
          { sha: string; message: string; author: string; date: string | null; parents: string[] }
        >();
        for (const branch of branches.slice(0, 6)) {
          const { data } = await client.octokit.request("GET /repos/{owner}/{repo}/commits", {
            owner: owned.org.login,
            repo: repoName,
            sha: branch.name,
            per_page: 100,
          });
          for (const c of data) {
            if (bySha.has(c.sha)) continue;
            bySha.set(c.sha, {
              sha: c.sha,
              message: (c.commit.message ?? "").split("\n")[0]!,
              author: c.commit.author?.name ?? c.author?.login ?? "",
              date: c.commit.author?.date ?? null,
              parents: (c.parents ?? []).map((p) => p.sha),
            });
          }
        }
        const commits = [...bySha.values()]
          .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
          .slice(0, 150);
        return { commits, branches, tests };
      } catch (err) {
        // 409: empty git repository — legitimate for a fresh assignment.
        if ((err as { status?: number }).status === 409) return { ...empty, tests };
        throw err;
      }
    },
  );
}
