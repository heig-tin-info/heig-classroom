/**
 * Pipeline de grading (GR-04..09, GR-14) : capture des passes CI éligibles,
 * extraction de l'annotation GRADE, sélection de la note courante et gel.
 * UN SEUL code d'ingestion — le webhook `workflow_run` et la réconciliation
 * GR-07 passent tous deux par `ingestCompletedRun` (ADR-011).
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Octokit } from "octokit";

import { extractGrade, GRADE_ANNOTATION_TITLE } from "@hgc/domain";
import { assignments, botCommits, gradeRuns, pushReceipts, studentRepos } from "./db/schema.js";

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
  /** Chemin du workflow (`path` du payload / de l'API). */
  path: string;
  checkSuiteId: number | null;
  completedAt: Date;
}

/** GR-05.1 : branche sélectionnée et commit de tête non poussé par le bot. */
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

/** GR-14 : `after_deadline` d'après l'heure de réception serveur du commit. */
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
  // Réception inconnue (webhook perdu, réconcilié après coup) : conservateur
  // dès que la deadline est passée (GR-14.3).
  return Date.now() > deadline.getTime();
}

/** GR-09 : le plus récent (completed_at) non post-deadline, parse ok|fallback. */
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

/** Vue API d'un GradeRun (GR-10/11) — même forme côté student et teacher. */
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

/** Charge en une requête les GradeRuns référencés (note courante + gelée). */
export async function gradeViewsByIds(
  app: FastifyInstance,
  ids: (string | null)[],
): Promise<Map<string, GradeView>> {
  const wanted = [...new Set(ids.filter((i): i is string => i !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await app.db.select().from(gradeRuns).where(inArray(gradeRuns.id, wanted));
  return new Map(rows.map((r) => [r.id, gradeView(r)]));
}

/** Lit les annotations des check-runs du run et extrait la note (GR-05.2/3). */
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

/** GR-06 : agrégation pass/fail de tous les runs d'un commit (référence ci_status). */
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
 * Ingestion idempotente d'un run completed (GR-05). Retourne l'id du GradeRun
 * créé, ou null si le run n'est pas éligible ou déjà capturé — le test
 * d'existence évite aussi de relire les annotations à chaque réconciliation.
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
  if (existing.length > 0) return null; // déjà capturé — rien à refaire

  let parse: ReturnType<typeof extractGrade>;
  if (run.path === GRADING_WORKFLOW_PATH) {
    parse = await extractGradeFromChecks(
      octokit,
      ctx.repo.fullName!,
      run.headSha,
      run.checkSuiteId,
    );
  } else {
    // Dépôt/workflow hors convention grading.yml : GradeRun sans note (GR-06).
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
  if (inserted.length === 0) return null; // course avec un autre worker

  await refreshGradeSelection(app, ctx);

  // GR-06 : ci_status agrégé — seulement pour le dernier commit connu du dépôt.
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
 * Recalcule la note courante (GR-09) et, pendant le délai de grâce, améliore
 * la note gelée provisoire (GR-14.4) : les runs sur des commits reçus avant
 * la deadline comptent tant que `frozen_at` n'est pas posé.
 */
export async function refreshGradeSelection(app: FastifyInstance, ctx: RepoCtx): Promise<void> {
  const selected = await selectGradeRun(app, ctx.repo.id);
  const patch: Partial<typeof studentRepos.$inferInsert> = { currentGradeRunId: selected };
  if (ctx.assignment.deadlineAppliedAt && !ctx.assignment.frozenAt) {
    patch.frozenGradeRunId = selected;
  }
  await app.db.update(studentRepos).set(patch).where(eq(studentRepos.id, ctx.repo.id));
}
