/**
 * Grading pipeline (GR-04..09, GR-14): capture of eligible CI runs,
 * extraction of the GRADE annotation, selection of the current grade, and
 * freezing. ONE single ingestion path: the `workflow_run` webhook and the
 * GR-07 reconciliation both go through `ingestCompletedRun` (ADR-011).
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Octokit } from "octokit";

import { extractGrade, GRADE_ANNOTATION_TITLE } from "@hgc/domain";
import { assignments, botCommits, gradeRuns, pushReceipts, studentRepos } from "./db/schema.js";
import { publish } from "./events.js";

export const GRADING_WORKFLOW_PATH = ".github/workflows/grading.yml";

export interface RepoCtx {
  repo: typeof studentRepos.$inferSelect;
  assignment: typeof assignments.$inferSelect;
  classroomId: string;
}

export interface CompletedRun {
  workflowRunId: number;
  runAttempt: number;
  headBranch: string;
  headSha: string;
  conclusion: string;
  /** Workflow path (`path` from the payload / the API). */
  path: string;
  checkSuiteId: number | null;
  completedAt: Date;
}

/** GR-05.1: selected branch and head commit not pushed by the bot. */
export async function isEligible(
  app: FastifyInstance,
  ctx: RepoCtx,
  headBranch: string | null | undefined,
  headSha: string | null | undefined,
): Promise<boolean> {
  if (!headBranch || !headSha) return false;
  if (!ctx.assignment.branches.includes(headBranch)) return false;
  const bot = await app.db
    .select({ sha: botCommits.sha })
    .from(botCommits)
    .where(and(eq(botCommits.studentRepoId, ctx.repo.id), eq(botCommits.sha, headSha)))
    .limit(1);
  return bot.length === 0;
}

/** GR-14: `after_deadline` based on the server receipt time of the commit. */
async function isAfterDeadline(
  app: FastifyInstance,
  ctx: RepoCtx,
  headSha: string,
): Promise<boolean> {
  const deadline = ctx.assignment.deadlineAt;
  const [receipt] = await app.db
    .select({ receivedAt: pushReceipts.receivedAt })
    .from(pushReceipts)
    .where(and(eq(pushReceipts.studentRepoId, ctx.repo.id), eq(pushReceipts.headSha, headSha)))
    .limit(1);
  if (receipt) return receipt.receivedAt.getTime() > deadline.getTime();
  // Unknown receipt time (lost webhook, reconciled after the fact): be
  // conservative as soon as the deadline has passed (GR-14.3).
  return Date.now() > deadline.getTime();
}

/** GR-09: the most recent (completed_at) non post-deadline run, parse ok|fallback. */
export async function selectGradeRun(
  app: FastifyInstance,
  studentRepoId: string,
): Promise<string | null> {
  const [row] = await app.db
    .select({ id: gradeRuns.id })
    .from(gradeRuns)
    .where(
      and(
        eq(gradeRuns.studentRepoId, studentRepoId),
        eq(gradeRuns.afterDeadline, false),
        inArray(gradeRuns.parseStatus, ["ok", "fallback"]),
      ),
    )
    .orderBy(desc(gradeRuns.completedAt))
    .limit(1);
  return row?.id ?? null;
}

/** API view of a GradeRun (GR-10/11), same shape on the student and teacher sides. */
export interface GradeView {
  points: number | null;
  max: number | null;
  parseStatus: string;
  conclusion: string;
  sha: string;
  branch: string;
  afterDeadline: boolean;
  completedAt: Date;
}

export function gradeView(run: typeof gradeRuns.$inferSelect): GradeView {
  return {
    points: run.gradePoints,
    max: run.gradeMax,
    parseStatus: run.parseStatus,
    conclusion: run.conclusion,
    sha: run.headSha,
    branch: run.headBranch,
    afterDeadline: run.afterDeadline,
    completedAt: run.completedAt,
  };
}

/** Loads the referenced GradeRuns in one query (current + frozen grade). */
export async function gradeViewsByIds(
  app: FastifyInstance,
  ids: (string | null)[],
): Promise<Map<string, GradeView>> {
  const wanted = [...new Set(ids.filter((i): i is string => i !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await app.db.select().from(gradeRuns).where(inArray(gradeRuns.id, wanted));
  return new Map(rows.map((r) => [r.id, gradeView(r)]));
}

/** Reads the run's check-run annotations and extracts the grade (GR-05.2/3). */
async function extractGradeFromChecks(
  octokit: Octokit,
  fullName: string,
  headSha: string,
  checkSuiteId: number | null,
): Promise<ReturnType<typeof extractGrade>> {
  const [owner, repo] = fullName.split("/") as [string, string];
  const { data: checks } = await octokit.request(
    "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
    { owner, repo, ref: headSha, per_page: 100 },
  );
  const runs = checks.check_runs.filter(
    (c) => checkSuiteId === null || c.check_suite?.id === checkSuiteId,
  );
  const annotations: { title: string | null; message: string | null }[] = [];
  for (const check of runs) {
    if (!check.output?.annotations_count) continue;
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations",
      { owner, repo, check_run_id: check.id, per_page: 100 },
    );
    for (const a of data) {
      if (a.annotation_level === "notice" && a.title === GRADE_ANNOTATION_TITLE) {
        annotations.push({ title: a.title, message: a.message });
      }
    }
  }
  return extractGrade(annotations);
}

/** GR-06: pass/fail aggregation of all runs of a commit (ci_status reference). */
async function aggregateCiStatus(
  octokit: Octokit,
  fullName: string,
  headSha: string,
): Promise<"none" | "pending" | "pass" | "fail"> {
  const [owner, repo] = fullName.split("/") as [string, string];
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/actions/runs", {
    owner,
    repo,
    head_sha: headSha,
    per_page: 50,
  });
  const runs = data.workflow_runs;
  if (runs.length === 0) return "none";
  const completed = runs.filter((r) => r.status === "completed");
  if (completed.some((r) => r.conclusion && r.conclusion !== "success" && r.conclusion !== "skipped" && r.conclusion !== "neutral")) {
    return "fail";
  }
  if (completed.length < runs.length) return "pending";
  return "pass";
}

/**
 * Idempotent ingestion of a completed run (GR-05). Returns the id of the
 * created GradeRun, or null if the run is not eligible or already captured.
 * The existence check also avoids re-reading annotations on every
 * reconciliation.
 */
export async function ingestCompletedRun(
  app: FastifyInstance,
  octokit: Octokit,
  ctx: RepoCtx,
  run: CompletedRun,
): Promise<string | null> {
  if (!(await isEligible(app, ctx, run.headBranch, run.headSha))) return null;

  const existing = await app.db
    .select({ id: gradeRuns.id })
    .from(gradeRuns)
    .where(
      and(
        eq(gradeRuns.studentRepoId, ctx.repo.id),
        eq(gradeRuns.workflowRunId, run.workflowRunId),
        eq(gradeRuns.runAttempt, run.runAttempt),
      ),
    )
    .limit(1);
  if (existing.length > 0) return null; // already captured, nothing to redo

  let parse: ReturnType<typeof extractGrade>;
  if (run.path === GRADING_WORKFLOW_PATH) {
    parse = await extractGradeFromChecks(
      octokit,
      ctx.repo.fullName!,
      run.headSha,
      run.checkSuiteId,
    );
  } else {
    // Repo/workflow outside the grading.yml convention: GradeRun without a grade (GR-06).
    parse = { status: "no_annotation" };
  }
  const afterDeadline = await isAfterDeadline(app, ctx, run.headSha);

  const id = randomUUID();
  const inserted = await app.db
    .insert(gradeRuns)
    .values({
      id,
      studentRepoId: ctx.repo.id,
      workflowRunId: run.workflowRunId,
      runAttempt: run.runAttempt,
      headBranch: run.headBranch,
      headSha: run.headSha,
      conclusion: run.conclusion,
      gradePoints: parse.status === "ok" ? parse.points : null,
      gradeMax: parse.status === "ok" ? parse.max : null,
      parseStatus:
        run.path === GRADING_WORKFLOW_PATH
          ? parse.status
          : ("fallback" as const),
      afterDeadline,
      completedAt: run.completedAt,
    })
    .onConflictDoNothing()
    .returning({ id: gradeRuns.id });
  if (inserted.length === 0) return null; // race with another worker

  await refreshGradeSelection(app, ctx);
  if (parse.status === "ok") {
    publish("grades", [`classroom:${ctx.classroomId}`], {
      kind: "grade_captured",
      message: `Grade ${parse.points}/${parse.max} captured on ${ctx.repo.fullName?.split("/")[1] ?? "repository"}`,
    });
  }

  // GR-06: aggregated ci_status, only for the repository's last known commit.
  if (!ctx.repo.lastCommitSha || ctx.repo.lastCommitSha === run.headSha) {
    try {
      const ciStatus = await aggregateCiStatus(octokit, ctx.repo.fullName!, run.headSha);
      await app.db
        .update(studentRepos)
        .set({ ciStatus })
        .where(eq(studentRepos.id, ctx.repo.id));
    } catch (err) {
      app.log.warn({ err, repo: ctx.repo.fullName }, "ci aggregation failed");
    }
  }
  return id;
}

/**
 * Recomputes the current grade (GR-09) and, during the grace period,
 * improves the provisional frozen grade (GR-14.4): runs on commits received
 * before the deadline count as long as `frozen_at` is not set.
 */
export async function refreshGradeSelection(app: FastifyInstance, ctx: RepoCtx): Promise<void> {
  const selected = await selectGradeRun(app, ctx.repo.id);
  const patch: Partial<typeof studentRepos.$inferInsert> = { currentGradeRunId: selected };
  if (ctx.assignment.deadlineAppliedAt && !ctx.assignment.frozenAt) {
    patch.frozenGradeRunId = selected;
  }
  await app.db.update(studentRepos).set(patch).where(eq(studentRepos.id, ctx.repo.id));
}
