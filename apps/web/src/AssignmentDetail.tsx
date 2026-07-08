import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Clock,
  ExternalLink,
  GitCommitHorizontal,
  GitPullRequest,
  History,
  Lock,
  LockOpen,
  Loader2,
  RefreshCw,
  Snowflake,
  XCircle,
} from "lucide-react";
import { useState } from "react";

import { api } from "./api";
import { Badge, Button, GithubIcon, isoDateTime, Modal } from "./ui";

export interface GradeView {
  points: number | null;
  max: number | null;
  parseStatus: "ok" | "no_annotation" | "malformed" | "multiple" | "fallback";
  conclusion: string;
  sha: string;
  branch: string;
  afterDeadline: boolean;
  completedAt: string;
}

interface DetailStudent {
  enrollmentId: string;
  nom: string;
  prenom: string;
  email: string;
  claimStatus: "pending" | "claimed";
  githubLogin: string | null;
  repo: {
    id: string;
    fullName: string | null;
    provisionStatus: "pending" | "ok" | "error";
    invitationStatus: "none" | "pending" | "accepted";
    acceptedAt: string;
    lockedAt: string | null;
    syncPr: { number: number; state: "open" | "merged" | "closed" | null } | null;
    grade: GradeView | null;
    frozenGrade: GradeView | null;
    lastCommitSha: string | null;
    lastCommitAt: string | null;
    commitCount: number | null;
    checksPassed: number | null;
    checksTotal: number | null;
    ciStatus: "none" | "pending" | "pass" | "fail";
    missing?: boolean;
  } | null;
}

interface Detail {
  assignment: {
    id: string;
    name: string;
    state: "draft" | "published" | "locked";
    startAt: string;
    deadlineAt: string;
    sourceAheadSha: string | null;
    sourcePushedAt: string | null;
    syncedAt: string | null;
  };
  students: DetailStudent[];
}

function CiBadge({ s }: { s: DetailStudent["repo"] }) {
  if (!s || s.ciStatus === "none") return <span className="text-zinc-400">—</span>;
  const checks =
    s.checksPassed !== null && s.checksTotal !== null ? ` ${s.checksPassed}/${s.checksTotal}` : "";
  if (s.ciStatus === "pass")
    return (
      <Badge tone="green" icon={CheckCircle2}>
        pass{checks}
      </Badge>
    );
  if (s.ciStatus === "fail")
    return (
      <Badge tone="red" icon={XCircle}>
        fail{checks}
      </Badge>
    );
  return (
    <Badge tone="amber" icon={Clock}>
      running
    </Badge>
  );
}

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

interface HistoryRun extends GradeView {
  id: string;
  workflowRunId: number;
  runAttempt: number;
}

/** History of a student's CI runs (GR-11/13). */
function GradeHistoryModal({
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
  const history = useQuery<{
    currentGradeRunId: string | null;
    frozenGradeRunId: string | null;
    runs: HistoryRun[];
  }>({
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
        <p className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
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

const cell = "px-3 py-2";

function StudentRow({
  classroomId,
  assignmentId,
  frozen,
  s,
}: {
  classroomId: string;
  assignmentId: string;
  /** Deadline enforced (state locked): the displayed grade is the frozen one. */
  frozen: boolean;
  s: DetailStudent;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["assignment-detail", assignmentId] });
  const toggleLock = useMutation({
    mutationFn: (action: "lock" | "unlock") =>
      api(
        `/app/api/classrooms/${classroomId}/assignments/${assignmentId}/repos/${s.repo!.id}/${action}`,
        { method: "POST" },
      ),
    onSuccess: invalidate,
  });

  const r = s.repo;
  return (
    <tr className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
      <td className={`${cell} font-medium`}>{s.nom}</td>
      <td className={cell}>{s.prenom}</td>
      <td className={cell}>
        {s.githubLogin ? (
          <span className="inline-flex items-center gap-1">
            <GithubIcon className="size-3.5" /> {s.githubLogin}
          </span>
        ) : (
          <span className="text-zinc-400">—</span>
        )}
      </td>
      <td className={cell}>
        {r?.provisionStatus === "ok" ? (
          <span className="inline-flex items-center gap-2">
            <Badge tone="green" icon={CheckCircle2}>
              accepted
            </Badge>
            {r.lockedAt ? (
              <Badge tone="red" icon={Lock}>
                locked
              </Badge>
            ) : null}
            {r.syncPr && r.fullName ? (
              <a
                href={`https://github.com/${r.fullName}/pull/${r.syncPr.number}`}
                target="_blank"
                rel="noreferrer"
                title={`Sync pull request #${r.syncPr.number}`}
              >
                <Badge
                  tone={
                    r.syncPr.state === "merged"
                      ? "green"
                      : r.syncPr.state === "open"
                        ? "amber"
                        : "zinc"
                  }
                  icon={GitPullRequest}
                >
                  {r.syncPr.state === "merged"
                    ? "synced"
                    : r.syncPr.state === "open"
                      ? `sync PR #${r.syncPr.number}`
                      : "sync PR closed"}
                </Badge>
              </a>
            ) : null}
            {r.missing ? (
              <Badge tone="red" icon={XCircle}>
                repo missing
              </Badge>
            ) : null}
          </span>
        ) : r?.provisionStatus === "error" ? (
          <Badge tone="red" icon={XCircle}>
            provision error
          </Badge>
        ) : s.claimStatus === "claimed" ? (
          <Badge tone="amber" icon={Clock}>
            not accepted
          </Badge>
        ) : (
          <Badge tone="zinc">not claimed</Badge>
        )}
      </td>
      <td className={`${cell} font-mono text-xs`}>
        {r?.lastCommitSha ? (
          <span title={r.lastCommitSha}>{r.lastCommitSha.slice(0, 7)}</span>
        ) : (
          <span className="text-zinc-400">—</span>
        )}
      </td>
      <td className={`${cell} text-zinc-500 dark:text-zinc-400`}>
        {r?.lastCommitAt ? isoDateTime(r.lastCommitAt) : "—"}
      </td>
      <td className={`${cell} text-right`}>{r?.commitCount ?? "—"}</td>
      <td className={cell}>
        <CiBadge s={r} />
      </td>
      <td className={`${cell} whitespace-nowrap`}>
        <span className="inline-flex items-center gap-1">
          <GradeBadge grade={frozen ? (r?.frozenGrade ?? null) : (r?.grade ?? null)} frozen={frozen} />
          {r?.provisionStatus === "ok" ? (
            <button
              aria-label="Grade history"
              title="Grade history"
              onClick={() => setShowHistory(true)}
              className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <History className="size-3.5" />
            </button>
          ) : null}
        </span>
        {showHistory && r ? (
          <GradeHistoryModal
            classroomId={classroomId}
            assignmentId={assignmentId}
            repoId={r.id}
            fullName={r.fullName}
            student={`${s.prenom} ${s.nom}`.trim()}
            onClose={() => setShowHistory(false)}
          />
        ) : null}
      </td>
      <td className={`${cell} text-right whitespace-nowrap`}>
        {r?.provisionStatus === "ok" && r.fullName ? (
          <span className="inline-flex items-center gap-1">
            <a
              href={`https://github.com/${r.fullName}`}
              target="_blank"
              rel="noreferrer"
              title="Open repository on GitHub"
              className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <ExternalLink className="size-4" />
            </a>
            {r.lockedAt ? (
              <button
                aria-label="Unlock repository"
                title="Unlock repository (allow pushes again)"
                onClick={() => toggleLock.mutate("unlock")}
                disabled={toggleLock.isPending}
                className="rounded-md p-1.5 text-red-500 transition-colors hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-400"
              >
                <LockOpen className="size-4" />
              </button>
            ) : (
              <button
                aria-label="Lock repository"
                title="Lock repository (block pushes)"
                onClick={() => toggleLock.mutate("lock")}
                disabled={toggleLock.isPending}
                className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
              >
                <Lock className="size-4" />
              </button>
            )}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * GH-50: the source moved ahead of what students received. The teacher
 * triggers the propagation explicitly; the bot opens one PR per repository.
 */
function SyncBanner({
  classroomId,
  a,
}: {
  classroomId: string;
  a: Detail["assignment"];
}) {
  const sync = useMutation({
    mutationFn: () =>
      api(`/app/api/classrooms/${classroomId}/assignments/${a.id}/sync`, { method: "POST" }),
  });
  const ahead =
    a.sourcePushedAt !== null &&
    (a.syncedAt === null || new Date(a.sourcePushedAt) > new Date(a.syncedAt));
  const syncing = sync.isSuccess && !ahead ? false : sync.isSuccess;
  if (!ahead && !syncing) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
      <GitPullRequest className="size-4 shrink-0" />
      <span>
        The source repository has new commits
        {a.sourceAheadSha ? (
          <code className="mx-1 font-mono text-xs">{a.sourceAheadSha.slice(0, 7)}</code>
        ) : null}
        . Syncing opens a pull request on each student repository; students merge it themselves.
      </span>
      <span className="flex-1" />
      <Button onClick={() => sync.mutate()} disabled={sync.isPending || syncing}>
        {sync.isPending || syncing ? (
          <>
            <Loader2 className="size-4 animate-spin" /> Syncing…
          </>
        ) : (
          <>
            <GitPullRequest className="size-4" /> Sync student repositories
          </>
        )}
      </Button>
    </div>
  );
}

export function AssignmentDetail({
  classroomId,
  assignmentId,
  onBack,
}: {
  classroomId: string;
  assignmentId: string;
  onBack: () => void;
}) {
  const detail = useQuery<Detail>({
    queryKey: ["assignment-detail", assignmentId],
    queryFn: () =>
      api(`/app/api/classrooms/${classroomId}/assignments/${assignmentId}/detail`),
  });

  if (detail.isLoading) {
    return (
      <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
        Fetching repository states from GitHub…
      </p>
    );
  }
  if (!detail.data) return null;
  const { assignment: a, students } = detail.data;
  const accepted = students.filter((s) => s.repo?.provisionStatus === "ok").length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          <ArrowLeft className="size-4" /> Assignments
        </button>
        <span className="font-medium">{a.name}</span>
        <Badge tone={a.state === "published" ? "green" : a.state === "locked" ? "red" : "zinc"}>
          {a.state}
        </Badge>
        <span className="inline-flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
          <CalendarClock className="size-3.5" />
          {isoDateTime(a.startAt)} → {isoDateTime(a.deadlineAt)}
        </span>
        <Badge tone="zinc" icon={GitCommitHorizontal}>
          {accepted}/{students.length} accepted
        </Badge>
        <span className="flex-1" />
        <Button variant="ghost" onClick={() => detail.refetch()} disabled={detail.isFetching}>
          <RefreshCw className={`size-4 ${detail.isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <SyncBanner classroomId={classroomId} a={a} />

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              <th className={`${cell} font-medium`}>Last name</th>
              <th className={`${cell} font-medium`}>First name</th>
              <th className={`${cell} font-medium`}>GitHub</th>
              <th className={`${cell} font-medium`}>Status</th>
              <th className={`${cell} font-medium`}>Last commit</th>
              <th className={`${cell} font-medium`}>Date</th>
              <th className={`${cell} font-medium text-right`}>Commits</th>
              <th className={`${cell} font-medium`}>Checks</th>
              <th className={`${cell} font-medium`}>Grade</th>
              <th className={cell} aria-label="Actions" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {students.map((s) => (
              <StudentRow
                key={s.enrollmentId}
                classroomId={classroomId}
                assignmentId={assignmentId}
                frozen={a.state === "locked"}
                s={s}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
