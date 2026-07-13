import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  GitCommitHorizontal,
  GitPullRequest,
  History,
  Lock,
  LockOpen,
  Loader2,
  Play,
  RefreshCw,
  Search as SearchIcon,
  Snowflake,
  XCircle,
} from "lucide-react";
import { useState } from "react";

import type {
  AssignmentDetailPayload,
  AssignmentDetailStudent,
  GradeView,
} from "@hgc/contracts";

import { ActivityPanel } from "./activity/ActivityPanel";
import { api, ApiError } from "./api";
import { GradeHistoryModal } from "./GradeHistoryModal";
import { fuzzyFilter } from "./fuzzy";
import { HelpIcon } from "./help";
import { useT } from "./i18n";
import { Badge, Button, GithubIcon, isoDateTime, SortHeader, useSortableTable, Z } from "./ui";

function CiBadge({ s, tests }: { s: AssignmentDetailStudent["repo"]; tests?: GradeView | null }) {
  // Real test counters (TESTS annotation, score ≥ 0.7.2) beat check-run
  // counts: "2/10 tests" says more than "pass 1/1".
  if (tests?.testsTotal) {
    const p = tests.testsPassed ?? 0;
    const t = tests.testsTotal;
    return (
      <Badge
        tone={p === t ? "green" : p === 0 ? "red" : "amber"}
        icon={p === t ? CheckCircle2 : XCircle}
      >
        {p}/{t} tests
      </Badge>
    );
  }
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

const cell = "px-3 py-1.5 whitespace-nowrap align-middle";

/** Plain mark (e.g. "4.5"): the number is the information, no badge chrome. */
function GradeText({ grade, frozen }: { grade: GradeView | null; frozen: boolean }) {
  if (!grade) return <span className="text-zinc-400">—</span>;
  if (grade.parseStatus === "ok" && grade.points !== null) {
    return (
      <span className="inline-flex items-center gap-1 font-medium tabular-nums">
        {grade.points.toFixed(1)}
        {frozen ? <Snowflake className="size-3 text-zinc-400" /> : null}
      </span>
    );
  }
  if (grade.parseStatus === "fallback") return <span className="text-zinc-400">—</span>;
  return (
    <Badge tone="amber" icon={AlertTriangle}>
      {grade.parseStatus === "multiple" ? "multiple GRADE" : grade.parseStatus.replace("_", " ")}
    </Badge>
  );
}

/** GitHub-repo link; the student's login shows in a hover popover. */
function RepoLink({ fullName, login }: { fullName: string; login: string | null }) {
  return (
    <span className="group/pop relative inline-flex">
      <a
        href={`https://github.com/${fullName}`}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        aria-label={`Open ${fullName} on GitHub`}
        className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      >
        <GithubIcon className="size-4" />
      </a>
      <span className={`pointer-events-none absolute left-0 top-full ${Z.popover} mt-1 hidden whitespace-nowrap rounded-lg bg-white px-2.5 py-1.5 text-xs shadow-[0_4px_24px_rgb(0_0_0/0.15)] ring-1 ring-zinc-100 group-hover/pop:block dark:bg-zinc-900 dark:ring-zinc-800`}>
        {login ? (
          <span className="font-medium">{login}</span>
        ) : null}
        <span className="text-zinc-500 dark:text-zinc-400">{login ? " · " : ""}{fullName}</span>
      </span>
    </span>
  );
}

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
  s: AssignmentDetailStudent;
}) {
  const t = useT();
  const [showHistory, setShowHistory] = useState(false);
  const [expanded, setExpanded] = useState(false);
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
  const gradeNow = useMutation({
    mutationFn: () =>
      api(
        `/app/api/classrooms/${classroomId}/assignments/${assignmentId}/repos/${s.repo!.id}/grade-now`,
        { method: "POST" },
      ),
  });
  const gradeNowError =
    gradeNow.isError && gradeNow.error instanceof ApiError && gradeNow.error.status === 409;

  const r = s.repo;
  const locked = r?.lockedAt != null;
  const canExpand = r?.provisionStatus === "ok";
  return (
    <>
    <tr
      onClick={() => canExpand && setExpanded((e) => !e)}
      className={`${canExpand ? "cursor-pointer" : ""} hover:bg-zinc-50 dark:hover:bg-zinc-800/50 ${locked ? "opacity-55" : ""}`}
    >
      <td className={`${cell} font-medium`}>
        <span className="inline-flex items-center gap-1.5">
          {canExpand ? (
            expanded ? (
              <ChevronDown className="size-3.5 shrink-0 text-zinc-400" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-zinc-400" />
            )
          ) : (
            <span className="w-3.5" />
          )}
          {`${s.prenom} ${s.nom}`.trim()}
        </span>
      </td>
      <td className={cell}>
        {r?.provisionStatus === "ok" && r.fullName ? (
          <RepoLink fullName={r.fullName} login={s.githubLogin} />
        ) : s.githubLogin ? (
          <span className="inline-flex items-center gap-1 text-zinc-400">
            <GithubIcon className="size-3.5" /> {s.githubLogin}
          </span>
        ) : (
          <span className="text-zinc-400">—</span>
        )}
      </td>
      <td className={cell}>
        {r?.provisionStatus === "ok" ? (
          <span className="inline-flex items-center gap-1.5">
            <Badge tone="green" icon={CheckCircle2}>
              {t("status.accepted")}
            </Badge>
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
                {t("status.repoMissing")}
              </Badge>
            ) : null}
          </span>
        ) : r?.provisionStatus === "error" ? (
          <span title={r.provisionError ?? undefined} className="cursor-help">
            <Badge tone="red" icon={XCircle}>
              {t("status.provisionError")}
            </Badge>
          </span>
        ) : s.claimStatus === "claimed" ? (
          <Badge tone="amber" icon={Clock}>
            {t("status.notAccepted")}
          </Badge>
        ) : (
          <Badge tone="zinc">{t("status.notClaimed")}</Badge>
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
        <CiBadge s={r} tests={frozen ? (r?.frozenGrade ?? r?.grade) : r?.grade} />
      </td>
      <td className={`${cell} whitespace-nowrap`}>
        <span className="inline-flex items-center gap-1">
          <GradeText grade={frozen ? (r?.frozenGrade ?? null) : (r?.grade ?? null)} frozen={frozen} />
          {r?.provisionStatus === "ok" ? (
            <button
              aria-label="Grade history"
              title="Grade history"
              onClick={(e) => {
                e.stopPropagation();
                setShowHistory(true);
              }}
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
          <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <button
              aria-label={t("assignment.gradeNow")}
              title={
                gradeNowError
                  ? t("assignment.gradeNowUnsupported")
                  : gradeNow.isSuccess
                    ? t("assignment.gradeNowStarted")
                    : t("assignment.gradeNow")
              }
              onClick={() => gradeNow.mutate()}
              disabled={gradeNow.isPending || locked}
              className={`rounded-md p-1.5 transition-colors disabled:opacity-40 ${
                gradeNowError
                  ? "text-amber-500"
                  : gradeNow.isSuccess
                    ? "text-emerald-500"
                    : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              {gradeNow.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : gradeNowError ? (
                <AlertTriangle className="size-4" />
              ) : gradeNow.isSuccess ? (
                <CheckCircle2 className="size-4" />
              ) : (
                <Play className="size-4" />
              )}
            </button>
            {/* Padlock shows the STATE: closed red when locked, open otherwise. */}
            <button
              aria-label={locked ? t("assignment.unlockRepo") : t("assignment.lockRepo")}
              title={locked ? t("assignment.unlockRepo") : t("assignment.lockRepo")}
              onClick={() => toggleLock.mutate(locked ? "unlock" : "lock")}
              disabled={toggleLock.isPending}
              className={`rounded-md p-1.5 transition-colors ${
                locked
                  ? "text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10"
                  : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              {toggleLock.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : locked ? (
                <Lock className="size-4" />
              ) : (
                <LockOpen className="size-4" />
              )}
            </button>
          </span>
        ) : null}
      </td>
    </tr>
    {expanded && r ? (
      <tr className="bg-zinc-50/60 dark:bg-zinc-800/30">
        <td colSpan={9} className="p-0">
          <ActivityPanel
            classroomId={classroomId}
            assignmentId={assignmentId}
            repoId={r.id}
            fullName={r.fullName}
          />
        </td>
      </tr>
    ) : null}
    </>
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
  a: AssignmentDetailPayload["assignment"];
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

type SortKey = "name" | "lastCommitAt" | "commitCount" | "grade" | "status";

export function AssignmentDetail({
  classroomId,
  assignmentId,
}: {
  classroomId: string;
  assignmentId: string;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const detail = useQuery<AssignmentDetailPayload>({
    queryKey: ["assignment-detail", assignmentId],
    queryFn: () =>
      api(`/app/api/classrooms/${classroomId}/assignments/${assignmentId}/detail`),
  });

  const rank = (s: AssignmentDetailStudent, key: SortKey): string | number => {
    switch (key) {
      case "name":
        return `${s.nom} ${s.prenom}`;
      case "lastCommitAt":
        return s.repo?.lastCommitAt ?? "";
      case "commitCount":
        return s.repo?.commitCount ?? -1;
      case "grade":
        return s.repo?.grade?.points ?? -1;
      case "status":
        return s.repo?.provisionStatus === "ok" ? 2 : s.claimStatus === "claimed" ? 1 : 0;
    }
  };
  const students = detail.data?.students ?? [];
  const shown = fuzzyFilter(
    query,
    students,
    (s) => `${s.nom} ${s.prenom} ${s.githubLogin ?? ""} ${s.email}`,
  );
  const { sorted, sort, toggle } = useSortableTable(shown, rank, { key: "name", dir: 1 });

  if (detail.isLoading) {
    return (
      <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
        Fetching repository states from GitHub…
      </p>
    );
  }
  if (!detail.data) return null;
  const a = detail.data.assignment;
  const accepted = students.filter((s) => s.repo?.provisionStatus === "ok").length;

  // La recherche trie déjà par pertinence.
  const rows = query.trim() !== "" ? shown : sorted;

  const Th = ({ k, children, right }: { k: SortKey; children: React.ReactNode; right?: boolean }) => (
    <SortHeader k={k} sort={sort} onToggle={toggle} className={`${cell} font-medium ${right ? "text-right" : ""}`}>
      {children}
    </SortHeader>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{a.name}</span>
        <HelpIcon topic="assignment-detail" />
        <Badge tone={a.state === "published" ? "green" : a.state === "locked" ? "red" : "zinc"}>
          {t(`state.${a.state}` as Parameters<typeof t>[0])}
        </Badge>
        <span className="inline-flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
          <CalendarClock className="size-3.5" />
          {isoDateTime(a.startAt)} → {isoDateTime(a.deadlineAt)}
        </span>
        <Badge tone="zinc" icon={GitCommitHorizontal}>
          {t("assignment.accepted", { n: accepted, total: students.length })}
        </Badge>
        <span className="flex-1" />
        <label className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            type="search"
            placeholder={t("assignment.searchStudents")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-44 rounded-lg border border-zinc-200 bg-white py-1.5 pl-8 pr-3 text-sm shadow-sm focus:border-accent focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
            aria-label={t("assignment.searchStudents")}
          />
        </label>
        <Button variant="ghost" onClick={() => detail.refetch()} disabled={detail.isFetching}>
          <RefreshCw className={`size-4 ${detail.isFetching ? "animate-spin" : ""}`} /> {t("common.refresh")}
        </Button>
      </div>

      <SyncBanner classroomId={classroomId} a={a} />

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-zinc-500 dark:text-zinc-400">
              <Th k="name">{t("assignment.col.student")}</Th>
              <th className={`${cell} font-medium uppercase tracking-wide`}>{t("assignment.col.repo")}</th>
              <Th k="status">{t("assignment.col.status")}</Th>
              <th className={`${cell} font-medium uppercase tracking-wide`}>{t("assignment.col.lastCommit")}</th>
              <Th k="lastCommitAt">{t("assignment.col.date")}</Th>
              <Th k="commitCount" right>
                {t("assignment.col.commits")}
              </Th>
              <th className={`${cell} font-medium uppercase tracking-wide`}>{t("assignment.col.checks")}</th>
              <Th k="grade">{t("assignment.col.grade")}</Th>
              <th className={cell} aria-label="Actions" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map((s) => (
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
