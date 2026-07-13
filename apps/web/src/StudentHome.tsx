import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Building2,
  CheckCircle2,
  ClipboardList,
  GitCommitHorizontal,
  LayoutGrid,
  List,
  Loader2,
  Lock,
  Search,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { Me, StudentAssignment, StudentClassroom, StudentRepo } from "@hgc/contracts";

import { api, ApiError, apiErrorMessage } from "./api";
import { GradeScale, TestDonut } from "./charts";
import { fuzzyFilter } from "./fuzzy";
import { HelpIcon } from "./help";
import { formatDuration, useT } from "./i18n";
import { Badge, Button, Card, EmptyState, GithubIcon, isoDateTime, OrgAvatar } from "./ui";

/** Live countdown to (or since) the deadline, refreshed every 30 s. */
function Countdown({ deadline }: { deadline: string }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const ms = new Date(deadline).getTime() - now;
  const dur = formatDuration(Math.abs(ms), t);
  return (
    <span className={ms < 0 ? "text-zinc-400" : "font-medium text-zinc-600 dark:text-zinc-300"}>
      {ms < 0 ? t("student.overdue", { duration: dur }) : t("student.until", { duration: dur })}
    </span>
  );
}

/** Metrics row for an accepted repository: commits, CI donut, grade scale. */
function RepoMetrics({ repo }: { repo: StudentRepo }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-3">
      {repo.commitCount !== null ? (
        <span className="inline-flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
          <GitCommitHorizontal className="size-3.5" />
          {t(repo.commitCount === 1 ? "student.commits.one" : "student.commits", {
            n: repo.commitCount,
          })}
        </span>
      ) : null}
      {repo.grade?.testsTotal ? (
        // Real test counters (TESTS annotation) beat check-run counts.
        <span className="inline-flex items-center gap-1.5">
          <TestDonut passed={repo.grade.testsPassed ?? 0} total={repo.grade.testsTotal} size={40} />
          <span className="text-xs text-zinc-400">{t("student.tests")}</span>
        </span>
      ) : repo.checksTotal ? (
        <span className="inline-flex items-center gap-1.5">
          <TestDonut passed={repo.checksPassed ?? 0} total={repo.checksTotal} size={40} />
          <span className="text-xs text-zinc-400">{t("student.tests")}</span>
        </span>
      ) : repo.ciStatus === "pending" ? (
        <Badge tone="amber" icon={Loader2}>
          {t("student.ciRunning")}
        </Badge>
      ) : null}
      {repo.grade && repo.grade.parseStatus === "ok" ? (
        <span className="inline-flex items-center gap-1.5">
          {repo.gradeFrozen ? <Lock className="size-3.5 text-zinc-400" /> : null}
          <GradeScale points={repo.grade.points!} max={repo.grade.max!} />
          <span className="text-xs text-zinc-400">{t("student.indicative")}</span>
        </span>
      ) : repo.ciStatus === "pass" ? (
        <Badge tone="green">{t("student.ciPass")}</Badge>
      ) : repo.ciStatus === "fail" ? (
        <Badge tone="red">{t("student.ciFail")}</Badge>
      ) : null}
    </div>
  );
}

/** One assignment as a table row; the action (accept / open repo) sits right. */
function StudentAssignmentRow({
  a,
  githubLinked,
}: {
  a: StudentAssignment;
  githubLinked: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const accept = useMutation({
    mutationFn: () => api(`/app/api/student/assignments/${a.id}/accept`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["student-classrooms"] }),
  });
  const acceptError =
    accept.isError && accept.error instanceof ApiError
      ? apiErrorMessage(accept.error, "Acceptance failed")
      : null;
  const locked = a.state === "locked" || a.repo?.lockedAt != null;
  const accepted = a.repo?.provisionStatus === "ok" && a.repo.fullName;
  const cell = "px-4 py-2.5 align-middle";

  return (
    <tr className={`text-sm ${locked ? "opacity-60" : ""}`}>
      <td className={`${cell} font-medium`}>
        <span className="inline-flex items-center gap-1.5">
          {locked ? <Lock className="size-3.5 shrink-0 text-zinc-400" /> : null}
          {accepted ? (
            <a
              href={`https://github.com/${a.repo!.fullName}`}
              target="_blank"
              rel="noreferrer"
              className="hover:text-accent hover:underline"
            >
              {a.name}
            </a>
          ) : (
            a.name
          )}
        </span>
      </td>
      <td className={cell}>
        <div className="flex flex-col">
          <span className="whitespace-nowrap text-zinc-500 dark:text-zinc-400">
            {isoDateTime(a.deadlineAt)}
          </span>
          <span className="text-xs">
            <Countdown deadline={a.deadlineAt} />
          </span>
        </div>
      </td>
      <td className={cell}>
        {locked ? (
          <Badge tone="red">{t("student.locked")}</Badge>
        ) : accepted ? (
          <Badge tone="green" icon={CheckCircle2}>
            {t("status.accepted")}
          </Badge>
        ) : (
          <Badge tone="zinc">{t("status.notAccepted")}</Badge>
        )}
        {accepted && a.repo!.invitationStatus === "pending" ? (
          <p className="mt-0.5 text-xs text-amber-600 dark:text-amber-400">
            {t("student.acceptInvite")}
          </p>
        ) : null}
      </td>
      <td className={cell}>
        {accepted ? <RepoMetrics repo={a.repo!} /> : <span className="text-zinc-400">—</span>}
      </td>
      <td className={`${cell} text-right`}>
        {accepted ? (
          <a
            href={`https://github.com/${a.repo!.fullName}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-800 transition-all duration-150 hover:-translate-y-px hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
          >
            <GithubIcon className="size-4" /> {t("student.openRepo")}
          </a>
        ) : (
          <>
            <Button
              onClick={() => accept.mutate()}
              disabled={accept.isPending || !githubLinked || locked}
              title={githubLinked ? undefined : t("student.linkPrompt")}
            >
              {accept.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> {t("student.creating")}
                </>
              ) : a.repo?.provisionStatus === "error" ? (
                t("student.retry")
              ) : (
                t("student.accept")
              )}
            </Button>
            {acceptError ? (
              <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{acceptError}</p>
            ) : null}
          </>
        )}
      </td>
    </tr>
  );
}

type StudentSortKey = "name" | "deadline" | "status" | "grade";

/**
 * One classroom as a full-width card holding a sortable assignment table.
 * The global search filters the rows (a hit on the classroom name keeps
 * everything); a classroom with no match disappears entirely.
 */
function StudentClassroomCard({
  room,
  githubLinked,
  query,
}: {
  room: StudentClassroom;
  githubLinked: boolean;
  query: string;
}) {
  const t = useT();
  const [sort, setSort] = useState<{ key: StudentSortKey; dir: 1 | -1 }>({
    key: "deadline",
    dir: 1,
  });

  const roomHit = query === "" || fuzzyFilter(query, [room], (r) => r.name).length > 0;
  const visible = roomHit ? room.assignments : fuzzyFilter(query, room.assignments, (a) => a.name);
  if (query !== "" && visible.length === 0) return null;

  const rank = {
    name: (a: StudentAssignment) => a.name.toLowerCase(),
    deadline: (a: StudentAssignment) => new Date(a.deadlineAt).getTime(),
    status: (a: StudentAssignment) => (a.repo?.provisionStatus === "ok" ? 1 : 0),
    grade: (a: StudentAssignment) =>
      a.repo?.grade && a.repo.grade.parseStatus === "ok"
        ? a.repo.grade.points! / (a.repo.grade.max! || 1)
        : -1,
  }[sort.key];
  const sorted = [...visible].sort((a, b) => {
    const va = rank(a);
    const vb = rank(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
  });

  const Th = ({
    k,
    children,
    className = "",
  }: {
    k: StudentSortKey;
    children: React.ReactNode;
    className?: string;
  }) => (
    <th className={`px-4 py-2 ${className}`}>
      <button
        onClick={() => setSort((s) => (s.key === k ? { key: k, dir: -s.dir as 1 | -1 } : { key: k, dir: 1 }))}
        className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-zinc-700 dark:hover:text-zinc-200"
      >
        {children}
        {sort.key === k ? (
          sort.dir === 1 ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : null}
      </button>
    </th>
  );

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100/80 px-4 py-3 dark:border-zinc-800/60">
        <OrgAvatar login={room.orgLogin} className="size-6" />
        <span className="font-medium">{room.name}</span>
        <span className="inline-flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <span className="inline-flex items-center gap-1">
            <Building2 className="size-3.5" /> {room.orgLogin}
          </span>
          <span>· {room.teacher}</span>
        </span>
      </div>
      {sorted.length ? (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left text-xs text-zinc-500 dark:text-zinc-400">
                <Th k="name">{t("nav.assignment")}</Th>
                <Th k="deadline">{t("student.deadlineCol")}</Th>
                <Th k="status">{t("assignment.col.status")}</Th>
                <Th k="grade">{t("assignment.col.grade")}</Th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {sorted.map((a) => (
                <StudentAssignmentRow key={a.id} a={a} githubLinked={githubLinked} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-4 py-3 text-sm text-zinc-400">{t("student.noAssignments")}</p>
      )}
    </Card>
  );
}

type StudentView = "cards" | "list";

export function StudentHome({ me }: { me: Me }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<StudentView>(
    () => (localStorage.getItem("hgc-student-view") as StudentView) || "cards",
  );
  const setStudentView = (v: StudentView) => {
    setView(v);
    localStorage.setItem("hgc-student-view", v);
  };
  const rooms = useQuery<StudentClassroom[]>({
    queryKey: ["student-classrooms"],
    queryFn: () => api("/app/api/student/classrooms"),
  });

  if (rooms.isLoading) return null;
  const linked = me.githubLogin != null;

  // Flat, searchable list of (classroom, assignment) pairs.
  const flat = (rooms.data ?? []).flatMap((room) =>
    room.assignments.map((a) => ({ room, a })),
  );
  const filteredFlat = fuzzyFilter(query, flat, ({ room, a }) => `${a.name} ${room.name}`);
  const cell = "px-3 py-2";

  const toggle = (v: StudentView, Icon: typeof LayoutGrid, label: string) => (
    <button
      aria-label={label}
      title={label}
      onClick={() => setStudentView(v)}
      className={`rounded-md p-1.5 transition-colors ${
        view === v
          ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100"
          : "text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
      }`}
    >
      <Icon className="size-4" />
    </button>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t("student.title")}</h1>
        <HelpIcon topic="student-home" />
        <span className="flex-1" />
        <label className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            type="search"
            placeholder={t("common.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-44 rounded-lg border border-zinc-200 bg-white py-1.5 pl-8 pr-3 text-sm shadow-sm focus:border-accent focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
            aria-label={t("common.search")}
          />
        </label>
        <span className="flex items-center gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
          {toggle("cards", LayoutGrid, t("view.cards"))}
          {toggle("list", List, t("view.list"))}
        </span>
      </div>

      {!linked ? (
        <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertTriangle className="size-4" />
          {t("student.linkPrompt")}
        </div>
      ) : null}

      {!rooms.data?.length ? (
        <Card>
          <EmptyState icon={ClipboardList} title={t("student.empty.title")}>
            {t("student.empty.body")}
          </EmptyState>
        </Card>
      ) : view === "list" ? (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  <th className={cell}>{t("nav.classrooms")}</th>
                  <th className={cell}>{t("nav.assignment")}</th>
                  <th className={cell}>{t("student.deadlineCol")}</th>
                  <th className={cell}>{t("assignment.col.status")}</th>
                  <th className={cell}>{t("assignment.col.grade")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {filteredFlat.map(({ room, a }) => {
                  const locked = a.state === "locked" || a.repo?.lockedAt != null;
                  return (
                    <tr key={a.id} className={locked ? "opacity-60" : ""}>
                      <td className={`${cell} text-zinc-500 dark:text-zinc-400`}>{room.name}</td>
                      <td className={`${cell} font-medium`}>
                        <span className="inline-flex items-center gap-1.5">
                          {locked ? <Lock className="size-3.5 text-zinc-400" /> : null}
                          {a.repo?.provisionStatus === "ok" && a.repo.fullName ? (
                            <a
                              href={`https://github.com/${a.repo.fullName}`}
                              target="_blank"
                              rel="noreferrer"
                              className="hover:text-accent hover:underline"
                            >
                              {a.name}
                            </a>
                          ) : (
                            a.name
                          )}
                        </span>
                      </td>
                      <td className={cell}>
                        <div className="flex flex-col">
                          <span className="text-zinc-500 dark:text-zinc-400">
                            {isoDateTime(a.deadlineAt)}
                          </span>
                          <span className="text-xs">
                            <Countdown deadline={a.deadlineAt} />
                          </span>
                        </div>
                      </td>
                      <td className={cell}>
                        {a.repo?.provisionStatus === "ok" ? (
                          <Badge tone="green" icon={CheckCircle2}>
                            {t("status.accepted")}
                          </Badge>
                        ) : (
                          <Badge tone="zinc">{t("status.notAccepted")}</Badge>
                        )}
                      </td>
                      <td className={cell}>
                        {a.repo?.grade && a.repo.grade.parseStatus === "ok" ? (
                          <GradeScale points={a.repo.grade.points!} max={a.repo.grade.max!} />
                        ) : (
                          <span className="text-zinc-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          {(rooms.data ?? []).map((room) => (
            <StudentClassroomCard key={room.id} room={room} githubLinked={linked} query={query} />
          ))}
        </div>
      )}
    </div>
  );
}
