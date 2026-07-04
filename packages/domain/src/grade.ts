/**
 * Extraction de la note depuis les annotations GitHub Actions (GR-02, GR-17).
 *
 * Convention : le workflow `grading.yml` émet `::notice title=GRADE::<points>/<max>`.
 * Le backend lit les annotations des check-runs et applique ces règles :
 * - exactement UNE annotation `GRADE` doit être présente (plusieurs, même
 *   identiques, invalident la note — mitigation anti-falsification H5) ;
 * - le message doit respecter `points/max`, décimales à point, `max > 0`,
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

/** Parse le message d'une annotation GRADE (`"4.5/6"` → points/max). */
export function parseGradeMessage(message: string): GradeParse {
  const m = GRADE_MESSAGE_RE.exec(message);
  if (!m) return { status: "malformed", message };
  const points = Number(m[1]);
  const max = Number(m[2]);
  if (!(max > 0) || points > max) return { status: "malformed", message };
  return { status: "ok", points, max };
}

/** Applique GR-02 sur l'ensemble des annotations d'un run. */
export function extractGrade(annotations: readonly AnnotationLike[]): GradeParse {
  const grades = annotations.filter((a) => a.title === GRADE_ANNOTATION_TITLE);
  if (grades.length === 0) return { status: "no_annotation" };
  if (grades.length > 1) return { status: "multiple", count: grades.length };
  return parseGradeMessage(grades[0]?.message ?? "");
}
