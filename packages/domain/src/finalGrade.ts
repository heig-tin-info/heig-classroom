/**
 * Final grade of a student repository (validation flow, GR-16): the teacher's
 * adjustment wins, else the authoritative LLM review, else the frozen CI
 * grade — and, while nothing is frozen yet, the current CI grade.
 *
 * Single source of truth: the assignment detail view, the student view, the
 * per-assignment export and the classroom grade sheet (server) all resolve
 * through this function. Only grades whose annotation parsed (`ok`) count;
 * a malformed or missing GRADE annotation is not a grade.
 */

export type FinalGradeSource = "teacher" | "llm" | "ci";

/** Structural shape of a GradeView (contracts) or of a grade_runs row. */
export interface GradeLike {
  points: number | null;
  max: number | null;
  parseStatus: string;
}

export interface FinalGradeInput {
  /** Teacher override (points on the assignment scale); null = none. */
  teacherPoints?: number | null;
  /** GR-16 authoritative review. */
  llmGrade?: GradeLike | null;
  /** CI grade frozen at the deadline (GR-12). */
  frozenGrade?: GradeLike | null;
  /** Current CI grade (GR-09), fallback while nothing is frozen. */
  grade?: GradeLike | null;
}

export interface FinalGrade {
  points: number;
  /** Scale of the grade the points come from; null when only an override exists. */
  max: number | null;
  source: FinalGradeSource;
}

function parsed(g: GradeLike | null | undefined): GradeLike | null {
  return g != null && g.parseStatus === "ok" && g.points != null ? g : null;
}

/** Resolves the final grade, or null when the student has none. */
export function resolveFinalGrade(repo: FinalGradeInput): FinalGrade | null {
  const llm = parsed(repo.llmGrade);
  const ci = parsed(repo.frozenGrade) ?? parsed(repo.grade);
  if (repo.teacherPoints != null) {
    return { points: repo.teacherPoints, max: llm?.max ?? ci?.max ?? null, source: "teacher" };
  }
  if (llm) return { points: llm.points!, max: llm.max, source: "llm" };
  if (ci) return { points: ci.points!, max: ci.max, source: "ci" };
  return null;
}

/** Final points alone (exports, sorting); null when the student has no grade. */
export function finalPoints(repo: FinalGradeInput): number | null {
  return resolveFinalGrade(repo)?.points ?? null;
}
