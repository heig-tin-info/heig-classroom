import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Snowflake, XCircle } from "lucide-react";

import type { GradeRunHistory, GradeView } from "@hgc/contracts";

import { api } from "./api";
import { Badge, isoDateTime, Modal, Spinner } from "./ui";

const cell = "px-3 py-1.5 whitespace-nowrap align-middle";

/** Grade x/y (GR-11): frozen (snowflake) once the deadline is enforced. */
export function GradeBadge({
  grade,
  frozen,
}: {
  grade: GradeView | null;
  frozen: boolean;
}) {
  if (!grade) return <span className="text-zinc-400">—</span>;
  if (grade.parseStatus === "ok") {
    return (
      <Badge tone={frozen ? "zinc" : "green"} icon={frozen ? Snowflake : undefined}>
        {grade.points}/{grade.max}
      </Badge>
    );
  }
  if (grade.parseStatus === "fallback") return <span className="text-zinc-400">—</span>;
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
    <Modal title={`Grade history — ${student}`} onClose={onClose}>
      {history.isLoading ? (
        <Spinner className="py-6" />
      ) : !d || d.runs.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
          No CI run captured yet.
        </p>
      ) : (
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                <th className={cell}>Run</th>
                <th className={cell}>Commit</th>
                <th className={cell}>Grade</th>
                <th className={cell}>Conclusion</th>
                <th className={cell} />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {d.runs.map((r) => (
                <tr key={r.id}>
                  <td className={`${cell} whitespace-nowrap text-zinc-500 dark:text-zinc-400`}>
                    {isoDateTime(r.completedAt)}
                    {r.runAttempt > 1 ? (
                      <span className="ml-1 text-xs text-zinc-400">#{r.runAttempt}</span>
                    ) : null}
                  </td>
                  <td className={`${cell} font-mono text-xs`}>
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
                    <span className="ml-1 text-zinc-400">{r.branch}</span>
                  </td>
                  <td className={cell}>
                    <GradeBadge grade={r} frozen={false} />
                  </td>
                  <td className={cell}>
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
                  <td className={`${cell} whitespace-nowrap`}>
                    {r.id === d.frozenGradeRunId ? (
                      <Badge tone="zinc" icon={Snowflake}>
                        frozen
                      </Badge>
                    ) : null}
                    {r.afterDeadline ? <Badge tone="amber">after deadline</Badge> : null}
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
