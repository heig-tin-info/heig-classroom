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

import type { GradeView } from "@hgc/contracts";
import { extractGrade, GRADE_ANNOTATION_TITLE } from "@hgc/domain";
import type { AppConfig } from "./config.js";
import { assignments, botCommits, gradeRuns, pushReceipts, studentRepos } from "./db/schema.js";
import { publish } from "./events.js";
import { mailRecipient, queueEmail } from "./mailer.js";

export const GRADING_WORKFLOW_PATH = ".github/workflows/grading.yml";
/** Raw test counters notice published by score ≥ 0.7.2 ("passed/total"). */
export const TESTS_ANNOTATION_TITLE = "TESTS";

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
  /** Triggering event (`event` from the payload / the API), e.g. `push`. */
  event: string;
  checkSuiteId: number | null;
  completedAt: Date;
}

/**
 * GR-16: the grading workflow fired by the platform's repository_dispatch is
 * the authoritative LLM review; every other run is the indicative CI tier.
 */
export function runKind(run: Pick<CompletedRun, "event" | "path">): "ci" | "llm" {
  return run.event === "repository_dispatch" && run.path === GRADING_WORKFLOW_PATH
    ? "llm"
    : "ci";
}

/**
 * GR-05.1: selected branch and head commit not pushed by the bot. LLM review
 * runs (GR-16) skip the bot-commit filter: they execute on the default-branch
 * head, which may legitimately be a bot commit (deadline marker, GRADING.yml
 * of a previous review) while the reviewed commit is `client_payload.sha`.
 */
export async function isEligible(
  app: FastifyInstance,
  ctx: RepoCtx,
  headBranch: string | null | undefined,
  headSha: string | null | undefined,
  opts: { skipBotCheck?: boolean } = {},
): Promise<boolean> {
  if (!headBranch || !headSha) return false;
  if (!ctx.assignment.branches.includes(headBranch)) return false;
  if (opts.skipBotCheck) return true;
  const bot = await app.db
    .select({ sha: botCommits.sha })
    .from(botCommits)
    .where(and(eq(botCommits.studentRepoId, ctx.repo.id), eq(botCommits.sha, headSha)))
    .limit(1);
  return bot.length === 0;
}

/** GR-14: `after_deadline` based on the server receipt time of the commit. */
export async function isAfterDeadline(
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

/**
 * GR-09: the most recent (completed_at) non post-deadline run, parse
 * ok|fallback. CI runs only: the LLM review (GR-16) has its own slot
 * (`llm_grade_run_id`) and must never displace the frozen CI grade.
 */
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
        eq(gradeRuns.kind, "ci"),
        eq(gradeRuns.afterDeadline, false),
        inArray(gradeRuns.parseStatus, ["ok", "fallback"]),
      ),
    )
    .orderBy(desc(gradeRuns.completedAt))
    .limit(1);
  return row?.id ?? null;
}

export function gradeView(run: typeof gradeRuns.$inferSelect): GradeView {
  return {
    points: run.gradePoints,
    max: run.gradeMax,
    testsPassed: run.testsPassed,
    testsTotal: run.testsTotal,
    parseStatus: run.parseStatus,
    conclusion: run.conclusion,
    sha: run.headSha,
    branch: run.headBranch,
    kind: run.kind,
    afterDeadline: run.afterDeadline,
    // Wire format (GradeView contract): the timestamp travels as an ISO
    // string — identical to what JSON serialization produced before.
    completedAt: run.completedAt.toISOString(),
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
): Promise<{ grade: ReturnType<typeof extractGrade>; tests: { passed: number; total: number } | null }> {
  const [owner, repo] = fullName.split("/") as [string, string];
  const { data: checks } = await octokit.request(
    "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
    { owner, repo, ref: headSha, per_page: 100 },
  );
  const runs = checks.check_runs.filter(
    (c) => checkSuiteId === null || c.check_suite?.id === checkSuiteId,
  );
  const annotations: { title: string | null; message: string | null }[] = [];
  // Raw test counters published by score ≥ 0.7.2 alongside the mark.
  let tests: { passed: number; total: number } | null = null;
  for (const check of runs) {
    if (!check.output?.annotations_count) continue;
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations",
      { owner, repo, check_run_id: check.id, per_page: 100 },
    );
    for (const a of data) {
      if (a.annotation_level !== "notice") continue;
      if (a.title === GRADE_ANNOTATION_TITLE) {
        annotations.push({ title: a.title, message: a.message });
      } else if (a.title === TESTS_ANNOTATION_TITLE) {
        const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(a.message ?? "");
        if (m) tests = { passed: Number(m[1]), total: Number(m[2]) };
      }
    }
  }
  return { grade: extractGrade(annotations), tests };
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
  config: AppConfig,
): Promise<string | null> {
  const kind = runKind(run);
  if (!(await isEligible(app, ctx, run.headBranch, run.headSha, { skipBotCheck: kind === "llm" }))) {
    return null;
  }

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
  let tests: { passed: number; total: number } | null = null;
  if (run.path === GRADING_WORKFLOW_PATH) {
    const extracted = await extractGradeFromChecks(
      octokit,
      ctx.repo.fullName!,
      run.headSha,
      run.checkSuiteId,
    );
    parse = extracted.grade;
    tests = extracted.tests;
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
      testsPassed: tests?.passed ?? null,
      testsTotal: tests?.total ?? null,
      parseStatus:
        run.path === GRADING_WORKFLOW_PATH
          ? parse.status
          : ("fallback" as const),
      kind,
      afterDeadline,
      completedAt: run.completedAt,
    })
    .onConflictDoNothing()
    .returning({ id: gradeRuns.id });
  if (inserted.length === 0) return null; // race with another worker

  if (kind === "llm") {
    // GR-16: the review lands in its own slot; the frozen CI grade is
    // untouched (GR-09 selection only ever sees `ci` runs).
    // A failed workflow never becomes the authoritative review: score's
    // grading.yml falls back to "GRADE 1/6" when the LLM step dies (e.g.
    // missing ANTHROPIC_API_KEY), which is an infrastructure failure, not a
    // student grade. The run row above keeps the trace for debugging.
    // Milestone reviews (grade-milestone) also land here and are trace-only:
    // they run BEFORE the freeze while grade-final only fires after it, so
    // gating the slot (and the student email) on `frozen_at` keeps an
    // intermediate review from ever posing as the final grade.
    if (parse.status === "ok" && run.conclusion === "success" && ctx.assignment.frozenAt) {
      await app.db
        .update(studentRepos)
        .set({ llmGradeRunId: id })
        .where(eq(studentRepos.id, ctx.repo.id));
      publish("grades", [`classroom:${ctx.classroomId}`], {
        kind: "grade_captured",
        message: `LLM review ${parse.points}/${parse.max} captured on ${ctx.repo.fullName?.split("/")[1] ?? "repository"}`,
      });
      // The authoritative review is in: tell the student (GR-16).
      const student = await mailRecipient(app, ctx.repo.userId);
      if (student) {
        await queueEmail(app, config, student, "grade.final", {
          assignmentName: ctx.assignment.name,
          grade: `${parse.points}/${parse.max}`,
        });
      }
    }
    return id;
  }

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
