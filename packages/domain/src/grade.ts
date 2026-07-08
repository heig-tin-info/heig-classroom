/**
 * Grade extraction from GitHub Actions annotations (GR-02, GR-17).
 *
 * Convention: the `grading.yml` workflow emits `::notice title=GRADE::<points>/<max>`.
 * The backend reads the check-run annotations and applies these rules:
 * - exactly ONE `GRADE` annotation must be present (several, even identical,
 *   invalidate the grade; anti-tampering mitigation H5);
 * - the message must follow `points/max`, dot decimals, `max > 0`,
 *   `points <= max`.
 */

export const GRADE_ANNOTATION_TITLE = "GRADE";

const GRADE_MESSAGE_RE = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/;

export type GradeParse =
  | { status: "ok"; points: number; max: number }
  | { status: "no_annotation" }
  | { status: "malformed"; message: string }
  | { status: "multiple"; count: number };

export interface AnnotationLike {
  title: string | null;
  message: string | null;
}

/** Parses the message of a GRADE annotation (`"4.5/6"` to points/max). */
export function parseGradeMessage(message: string): GradeParse {
  const m = GRADE_MESSAGE_RE.exec(message);
  if (!m) return { status: "malformed", message };
  const points = Number(m[1]);
  const max = Number(m[2]);
  if (!(max > 0) || points > max) return { status: "malformed", message };
  return { status: "ok", points, max };
}

/** Applies GR-02 to the full set of annotations of a run. */
export function extractGrade(annotations: readonly AnnotationLike[]): GradeParse {
  const grades = annotations.filter((a) => a.title === GRADE_ANNOTATION_TITLE);
  if (grades.length === 0) return { status: "no_annotation" };
  if (grades.length > 1) return { status: "multiple", count: grades.length };
  return parseGradeMessage(grades[0]?.message ?? "");
}
