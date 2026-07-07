import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Clock,
  ExternalLink,
  GitCommitHorizontal,
  Lock,
  LockOpen,
  RefreshCw,
  XCircle,
} from "lucide-react";

import { api } from "./api";
import { Badge, Button, GithubIcon, isoDateTime } from "./ui";

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

const cell = "px-3 py-2";

function StudentRow({
  classroomId,
  assignmentId,
  s,
}: {
  classroomId: string;
  assignmentId: string;
  s: DetailStudent;
}) {
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
              <th className={cell} aria-label="Actions" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {students.map((s) => (
              <StudentRow
                key={s.enrollmentId}
                classroomId={classroomId}
                assignmentId={assignmentId}
                s={s}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
