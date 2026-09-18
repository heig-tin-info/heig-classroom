import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  Building2,
  CheckCircle2,
  ClipboardList,
  GitCommitHorizontal,
  LayoutGrid,
  List,
  Loader2,
  Lock,
  MonitorPlay,
  Play,
  Search,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { Me, StudentAssignment, StudentClassroom, StudentRepo } from "@hgc/contracts";
import { resolveFinalGrade } from "@hgc/domain";

import { api, ApiError, apiErrorMessage } from "./api";
import { GradeScale, TestDonut } from "./charts";
import { fuzzyFilter } from "./fuzzy";
import { HelpIcon } from "./help";
import { formatDuration, useT } from "./i18n";
import { Badge, Button, Card, EmptyState, GithubIcon, isoDateTime, OrgAvatar, SortHeader, Spinner, Tip, useNow, useSortableTable } from "./ui";

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

/** Validation flow: the grade a student sees once the teacher signed off —
    same rule as everywhere else (@hgc/domain), on a default /6 scale. */
function finalGrade(repo: StudentRepo): { points: number; max: number } | null {
  const final = resolveFinalGrade(repo);
  return final ? { points: final.points, max: final.max ?? 6 } : null;
}

/** Metrics row for an accepted repository: commits, CI donut, grade scale. */
function RepoMetrics({
  repo,
  reviewAt,
  showGrades,
  validated,
}: {
  repo: StudentRepo;
  reviewAt: number;
  /** Grading mode `none`: commits and CI feedback stay, points/review go. */
  showGrades: boolean;
  /** Grades signed off by the teacher: show the final grade, nothing else. */
  validated: boolean;
}) {
  const t = useT();
  const now = useNow(15_000);
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
      {!showGrades ? null : validated && finalGrade(repo) ? (
        <Tip label={t("student.finalTip")}>
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="size-3.5 text-emerald-500" />
            <GradeScale points={finalGrade(repo)!.points} max={finalGrade(repo)!.max} />
            <span className="text-xs text-zinc-400">{t("student.final")}</span>
          </span>
        </Tip>
      ) : repo.llmGrade && repo.llmGrade.parseStatus === "ok" ? (
        // GR-16: the authoritative LLM review replaces the indicative grade.
        <Tip label={t("student.reviewedTip")}>
          <span className="inline-flex items-center gap-1.5">
            <Bot className="size-3.5 text-accent" />
            <GradeScale points={repo.llmGrade.points!} max={repo.llmGrade.max!} />
            <span className="text-xs text-zinc-400">{t("student.reviewed")}</span>
          </span>
        </Tip>
      ) : repo.grade && repo.grade.parseStatus === "ok" ? (
        <span className="inline-flex items-center gap-1.5">
          {repo.gradeFrozen ? <Lock className="size-3.5 text-zinc-400" /> : null}
          <GradeScale points={repo.grade.points!} max={repo.grade.max!} />
          <span className="text-xs text-zinc-400">{t("student.indicative")}</span>
          {repo.gradeFrozen ? (
            // Countdown to deadline + grace, then "running" until the
            // authoritative review lands (llmGrade above takes over).
            <Tip label={t("student.reviewPendingTip")}>
              <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                <Bot className={`size-3.5 ${now >= reviewAt ? "animate-pulse" : ""}`} />
                {now < reviewAt
                  ? t("student.reviewIn", { t: formatDuration(reviewAt - now, t) })
                  : t("student.reviewRunning")}
              </span>
            </Tip>
          ) : null}
        </span>
      ) : repo.ciStatus === "pass" ? (
        <Badge tone="green">{t("student.ciPass")}</Badge>
      ) : repo.ciStatus === "fail" ? (
        <Badge tone="red">{t("student.ciFail")}</Badge>
      ) : null}
    </div>
  );
}

/**
 * What one assignment row offers, by work mode. Pure on purpose: the rules
 * are the same in the card view and in the list view, and they are what the
 * test asserts.
 *
 * ADR-013 and the 2026-09-18 feedback on the real student view:
 *
 *  - `free` — unchanged: the name links to the repository and the "open your
 *    repository" button sits with the actions;
 *  - `online` — the student only reads that repository, so the button goes;
 *    the name keeps its discreet link, and `Start` is the one action;
 *  - `online_seb` — no access to the repository at all, so no link either.
 *
 * In both online modes the mode itself is said under the name rather than on
 * the name line, where a badge crowded the title.
 */
export type WorkModeOf = StudentAssignment["workMode"];

export interface RowAffordances {
  /** The assignment name is a link to the GitHub repository. */
  nameIsLink: boolean;
  /** The "open your repository" button, in the actions column. */
  repoButton: boolean;
  /** The "Start" button, the main action of an online assignment. */
  startButton: boolean;
  /** Translation key of the note under the name; null in free mode. */
  modeNote: "student.workspace" | "student.workspaceSeb" | null;
}

export function rowAffordances(a: {
  workMode: WorkModeOf;
  accepted: boolean;
  locked: boolean;
}): RowAffordances {
  const examOnly = a.workMode === "online_seb";
  const online = a.workMode !== "free";
  return {
    nameIsLink: a.accepted && !examOnly,
    repoButton: a.accepted && !online,
    startButton: online && !a.locked,
    modeNote: online ? (examOnly ? "student.workspaceSeb" : "student.workspace") : null,
  };
}

/** The mode said under the assignment name, discreetly. */
function ModeNote({ note }: { note: Exclude<RowAffordances["modeNote"], null> }) {
  const t = useT();
  return (
    <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-normal text-zinc-500 dark:text-zinc-400">
      <MonitorPlay className="size-3 shrink-0" />
      {t(note)}
    </span>
  );
}

/** One assignment as a table row; the action (accept / open repo) sits right. */
function StudentAssignmentRow({
  a,
  githubLinked,
  codespaceHost,
}: {
  a: StudentAssignment;
  githubLinked: boolean;
  /** Portal host, for the `sebs://` deep link; null = no portal configured. */
  codespaceHost: string | null;
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
  const examOnly = a.workMode === "online_seb";
  const { nameIsLink, repoButton, startButton, modeNote } = rowAffordances({
    workMode: a.workMode,
    accepted: Boolean(accepted),
    locked,
  });

  return (
    <tr className={`text-sm ${locked ? "opacity-60" : ""}`}>
      <td className={`${cell} font-medium`}>
        <span className="flex flex-col">
          <span className="inline-flex items-center gap-1.5">
            {locked ? <Lock className="size-3.5 shrink-0 text-zinc-400" /> : null}
            {nameIsLink ? (
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
          {modeNote ? <ModeNote note={modeNote} /> : null}
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
        {accepted ? (
          <RepoMetrics
            repo={a.repo!}
            reviewAt={new Date(a.deadlineAt).getTime() + a.graceMinutes * 60_000}
            showGrades={a.gradingMode !== "none"}
            validated={a.gradesValidatedAt != null}
          />
        ) : (
          <span className="text-zinc-400">—</span>
        )}
      </td>
      <td className={`${cell} text-right`}>
        {accepted ? (
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex flex-wrap items-center justify-end gap-2">
              {repoButton ? (
                <a
                  href={`https://github.com/${a.repo!.fullName}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-800 transition-all duration-150 hover:-translate-y-px hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                >
                  <GithubIcon className="size-4" /> {t("student.openRepo")}
                </a>
              ) : null}
              {startButton ? (
                // Plain navigation: this URL is also the SEB startURL, so it
                // must work as a link, not as a fetch.
                <a
                  href={`/app/codespace/start/${a.id}`}
                  className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-all duration-150 hover:-translate-y-px hover:bg-accent-hover"
                >
                  <Play className="size-4" /> {t("student.start")}
                </a>
              ) : null}
            </div>
            {examOnly && codespaceHost ? (
              <>
                <a
                  href={`sebs://${codespaceHost}/exam/${a.id}.seb`}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
                >
                  <MonitorPlay className="size-4" /> {t("student.openSeb")}
                </a>
                <p className="max-w-xs text-right text-xs text-zinc-500 dark:text-zinc-400">
                  {t("student.sebOnly")}
                </p>
              </>
            ) : null}
          </div>
        ) : (
          <>
            <Tip label={githubLinked ? null : t("student.linkPrompt")}>
            <Button
              onClick={() => accept.mutate()}
              disabled={accept.isPending || !githubLinked || locked}
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
            </Tip>
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
  codespaceHost,
}: {
  room: StudentClassroom;
  githubLinked: boolean;
  query: string;
  codespaceHost: string | null;
}) {
  const t = useT();
  const roomHit = query === "" || fuzzyFilter(query, [room], (r) => r.name).length > 0;
  const visible = roomHit ? room.assignments : fuzzyFilter(query, room.assignments, (a) => a.name);

  const ranks: Record<StudentSortKey, (a: StudentAssignment) => string | number> = {
    name: (a) => a.name.toLowerCase(),
    deadline: (a) => new Date(a.deadlineAt).getTime(),
    status: (a) => (a.repo?.provisionStatus === "ok" ? 1 : 0),
    grade: (a) =>
      a.repo?.grade && a.repo.grade.parseStatus === "ok"
        ? a.repo.grade.points! / (a.repo.grade.max! || 1)
        : -1,
  };
  const { sorted, sort, toggle } = useSortableTable(
    visible,
    (a, key: StudentSortKey) => ranks[key](a),
    { key: "deadline", dir: 1 },
    (va, vb) => (va < vb ? -1 : va > vb ? 1 : 0),
  );
  if (query !== "" && visible.length === 0) return null;

  const Th = ({ k, children }: { k: StudentSortKey; children: React.ReactNode }) => (
    <SortHeader
      k={k}
      sort={sort}
      onToggle={toggle}
      className="px-4 py-2"
      buttonClassName="hover:text-zinc-700 dark:hover:text-zinc-200"
    >
      {children}
    </SortHeader>
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
                <StudentAssignmentRow
                  key={a.id}
                  a={a}
                  githubLinked={githubLinked}
                  codespaceHost={codespaceHost}
                />
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

  if (rooms.isLoading) return <Spinner className="py-16" />;
  const linked = me.githubLogin != null;

  // Flat, searchable list of (classroom, assignment) pairs.
  const flat = (rooms.data ?? []).flatMap((room) =>
    room.assignments.map((a) => ({ room, a })),
  );
  const filteredFlat = fuzzyFilter(query, flat, ({ room, a }) => `${a.name} ${room.name}`);
  const cell = "px-3 py-2";

  const toggle = (v: StudentView, Icon: typeof LayoutGrid, label: string) => (
    <Tip label={label}>
    <button
      aria-label={label}
      onClick={() => setStudentView(v)}
      className={`rounded-md p-1.5 transition-colors ${
        view === v
          ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100"
          : "text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
      }`}
    >
      <Icon className="size-4" />
    </button>
    </Tip>
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
                        <span className="flex flex-col">
                          <span className="inline-flex items-center gap-1.5">
                            {locked ? <Lock className="size-3.5 text-zinc-400" /> : null}
                            {rowAffordances({
                              workMode: a.workMode,
                              accepted: a.repo?.provisionStatus === "ok" && Boolean(a.repo.fullName),
                              locked,
                            }).nameIsLink ? (
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
                          {a.workMode !== "free" ? (
                            <ModeNote
                              note={
                                a.workMode === "online_seb"
                                  ? "student.workspaceSeb"
                                  : "student.workspace"
                              }
                            />
                          ) : null}
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
                        {a.gradingMode === "none" ? (
                          <span className="text-zinc-400">—</span>
                        ) : a.gradesValidatedAt && a.repo && finalGrade(a.repo) ? (
                          <span className="inline-flex items-center gap-1">
                            <CheckCircle2 className="size-3.5 text-emerald-500" />
                            <GradeScale
                              points={finalGrade(a.repo)!.points}
                              max={finalGrade(a.repo)!.max}
                            />
                          </span>
                        ) : a.repo?.llmGrade && a.repo.llmGrade.parseStatus === "ok" ? (
                          <span className="inline-flex items-center gap-1">
                            <Bot className="size-3.5 text-accent" />
                            <GradeScale points={a.repo.llmGrade.points!} max={a.repo.llmGrade.max!} />
                          </span>
                        ) : a.repo?.grade && a.repo.grade.parseStatus === "ok" ? (
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
            <StudentClassroomCard
              key={room.id}
              room={room}
              githubLinked={linked}
              query={query}
              codespaceHost={me.codespaceHost}
            />
          ))}
        </div>
      )}
    </div>
  );
}
