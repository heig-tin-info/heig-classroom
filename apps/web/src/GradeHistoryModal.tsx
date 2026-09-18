import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, History, RefreshCw, Snowflake, XCircle } from "lucide-react";

import type { GradeRunHistory, GradeView } from "@hgc/contracts";

import { api, apiErrorMessage } from "./api";
import { Alert, Badge, Button, cx, EmptyState, isoDateTime, Modal, Spinner, T } from "./ui";

/**
 * Grade x/y (GR-11), frozen (snowflake) once the deadline is enforced. A
 * grade is a number, not a status, so it reads as plain tabular text — a
 * green pill around "0/10" said the opposite of what it meant. The badge is
 * kept for what really is a status: a grade the CI could not parse.
 */
export function GradeBadge({
  grade,
  frozen,
}: {
  grade: GradeView | null;
  frozen: boolean;
}) {
  if (!grade) return <span className="text-fg-faint">—</span>;
  if (grade.parseStatus === "ok") {
    return (
      <span className="inline-flex items-center gap-1 font-semibold tabular-nums">
        {grade.points}/{grade.max}
        {frozen ? <Snowflake className="size-3 text-fg-faint" /> : null}
      </span>
    );
  }
  if (grade.parseStatus === "fallback") return <span className="text-fg-faint">—</span>;
  return (
    <Badge tone="amber" icon={AlertTriangle}>
      {grade.parseStatus === "multiple" ? "multiple GRADE" : grade.parseStatus.replace("_", " ")}
    </Badge>
  );
}

/** History of a student's CI runs (GR-11/13). */
export function GradeHistoryModal({
  classroomId,
  assignmentId,
  repoId,
  fullName,
  student,
  onClose,
}: {
  classroomId: string;
  assignmentId: string;
  repoId: string;
  fullName: string | null;
  student: string;
  onClose: () => void;
}) {
  const history = useQuery<GradeRunHistory>({
    queryKey: ["grade-runs", repoId],
    queryFn: () =>
      api(
        `/app/api/classrooms/${classroomId}/assignments/${assignmentId}/repos/${repoId}/grade-runs`,
      ),
  });
  const d = history.data;
  return (
    <Modal title="Grade history" subtitle={student} size="lg" onClose={onClose}>
      {history.isLoading ? (
        <Spinner className="py-6" />
      ) : history.isError ? (
        <Alert
          tone="danger"
          icon={AlertTriangle}
          title="Could not load the grade history"
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void history.refetch()}
              loading={history.isFetching}
            >
              <RefreshCw /> Retry
            </Button>
          }
        >
          {apiErrorMessage(history.error, "The server did not answer.")}
        </Alert>
      ) : !d || d.runs.length === 0 ? (
        <EmptyState icon={History} title="No CI run captured yet" className="py-8">
          Runs appear here as soon as the grading workflow completes on a commit.
        </EmptyState>
      ) : (
        <div className="-mx-5 max-h-96 overflow-x-auto overflow-y-auto">
          <table className={cx(T.table, "min-w-150")}>
            <thead>
              <tr className={T.head}>
                <th className={`${T.th} pl-5`}>Run</th>
                <th className={T.th}>Commit</th>
                <th className={T.th}>Grade</th>
                <th className={T.th}>Conclusion</th>
                <th className={`${T.th} pr-5`} />
              </tr>
            </thead>
            <tbody>
              {d.runs.map((r) => (
                <tr key={r.id} className={T.row}>
                  <td className={`${T.td} whitespace-nowrap pl-5 text-fg-muted`}>
                    {isoDateTime(r.completedAt)}
                    {r.runAttempt > 1 ? (
                      <span className="ml-1 text-xs text-fg-faint">#{r.runAttempt}</span>
                    ) : null}
                  </td>
                  <td className={`${T.td} font-mono text-xs`}>
                    {fullName ? (
                      <a
                        href={`https://github.com/${fullName}/commit/${r.sha}`}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        {r.sha.slice(0, 7)}
                      </a>
                    ) : (
                      r.sha.slice(0, 7)
                    )}
                    <span className="ml-1.5 text-fg-faint">{r.branch}</span>
                  </td>
                  <td className={T.td}>
                    <GradeBadge grade={r} frozen={false} />
                  </td>
                  <td className={T.td}>
                    {r.conclusion === "success" ? (
                      <Badge tone="green" icon={CheckCircle2}>
                        success
                      </Badge>
                    ) : (
                      <Badge tone="red" icon={XCircle}>
                        {r.conclusion}
                      </Badge>
                    )}
                  </td>
                  <td className={`${T.td} whitespace-nowrap pr-5`}>
                    <span className="inline-flex gap-1">
                      {r.id === d.frozenGradeRunId ? (
                        <Badge tone="zinc" icon={Snowflake}>
                          frozen
                        </Badge>
                      ) : null}
                      {r.afterDeadline ? <Badge tone="amber">after deadline</Badge> : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
