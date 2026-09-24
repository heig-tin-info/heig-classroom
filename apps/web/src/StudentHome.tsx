import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  GitCommitHorizontal,
  LayoutGrid,
  List,
  Loader2,
  Lock,
  MonitorPlay,
  Play,
  SearchX,
  UsersRound,
} from "lucide-react";
import { useState } from "react";

import type { GradeView, Me, StudentAssignment, StudentClassroom, StudentRepo } from "@hgc/contracts";
import { resolveFinalGrade } from "@hgc/domain";

import { api, ApiError, apiErrorMessage } from "./api";
import { GradeScale, gradeToSix, TestDonut } from "./charts";
import { fuzzyFilter } from "./fuzzy";
import { HelpIcon } from "./help";
import { formatDuration, useT } from "./i18n";
import {
  Alert,
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  GithubIcon,
  isoDateTime,
  LinkButton,
  OrgAvatar,
  PageHeader,
  QueryError,
  SearchInput,
  Segmented,
  Skeleton,
  SortHeader,
  T,
  Tip,
  useNow,
  useSortableTable,
} from "./ui";

/** Live countdown to (or since) the deadline, refreshed every 30 s. */
function Countdown({ deadline, className = "" }: { deadline: string; className?: string }) {
  const t = useT();
  const now = useNow(30_000);
  const ms = new Date(deadline).getTime() - now;
  const dur = formatDuration(Math.abs(ms), t);
  const soon = ms > 0 && ms < 2 * 86_400_000;
  return (
    <span className={cx(ms < 0 ? "text-fg-faint" : soon ? "font-semibold text-warning" : "font-medium text-fg", className)}>
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

/**
 * The indicative GRADE worth showing, or null. The score pipeline's
 * per-push mark only covers build and tests: every criterion the LLM review
 * scores counts as 0 until the review runs, so 22/22 tests read "2.8/6".
 * When the CI publishes its TESTS counter (score >= 0.7.2), the donut is the
 * honest feedback and the grade waits for the review. A plain workflow with
 * no counter grades everything itself: its GRADE stays.
 */
export function indicativeGrade(repo: StudentRepo): GradeView | null {
  const grade = repo.grade;
  if (!grade || grade.parseStatus !== "ok") return null;
  return grade.testsTotal ? null : grade;
}

/** Test counters for the donut: real TESTS counters beat check-run counts. */
function testCounts(repo: StudentRepo): { passed: number; total: number } | null {
  if (repo.grade?.testsTotal) return { passed: repo.grade.testsPassed ?? 0, total: repo.grade.testsTotal };
  if (repo.checksTotal) return { passed: repo.checksPassed ?? 0, total: repo.checksTotal };
  return null;
}

/** The tests donut, set right before the row action where the eye lands. */
function RepoTests({ repo, size = 52 }: { repo: StudentRepo; size?: number }) {
  const t = useT();
  const counts = testCounts(repo);
  if (counts) {
    return (
      <Tip label={t("student.testsPassing", counts)}>
        <span className="inline-flex" aria-label={t("student.testsPassing", counts)}>
          <TestDonut passed={counts.passed} total={counts.total} size={size} />
        </span>
      </Tip>
    );
  }
  if (repo.ciStatus === "pending") {
    return (
      <Badge tone="amber" icon={Loader2}>
        {t("student.ciRunning")}
      </Badge>
    );
  }
  return null;
}

/** Metrics row for an accepted repository: commits and grade. */
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
  const indicative = indicativeGrade(repo);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {repo.commitCount !== null ? (
        <span className="inline-flex items-center gap-1 text-[13px] text-fg-muted">
          <GitCommitHorizontal className="size-3.5 text-fg-faint" />
          {t(repo.commitCount === 1 ? "student.commits.one" : "student.commits", {
            n: repo.commitCount,
          })}
        </span>
      ) : null}
      {!showGrades ? null : validated && finalGrade(repo) ? (
        <Tip label={t("student.finalTip")}>
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="size-3.5 text-success" />
            <GradeScale points={finalGrade(repo)!.points} max={finalGrade(repo)!.max} />
            <span className="text-xs text-fg-faint">{t("student.final")}</span>
          </span>
        </Tip>
      ) : repo.llmGrade && repo.llmGrade.parseStatus === "ok" ? (
        // GR-16: the authoritative LLM review replaces the indicative grade.
        <Tip label={t("student.reviewedTip")}>
          <span className="inline-flex items-center gap-1.5">
            <Bot className="size-3.5 text-accent" />
            <GradeScale points={repo.llmGrade.points!} max={repo.llmGrade.max!} />
            <span className="text-xs text-fg-faint">{t("student.reviewed")}</span>
          </span>
        </Tip>
      ) : (
        <>
          {indicative ? (
            <span className="inline-flex items-center gap-1.5">
              {repo.gradeFrozen ? <Lock className="size-3.5 text-fg-faint" /> : null}
              <GradeScale points={indicative.points!} max={indicative.max!} />
              <span className="text-xs text-fg-faint">{t("student.indicative")}</span>
            </span>
          ) : testCounts(repo) ? null : repo.ciStatus === "pass" ? (
            <Badge tone="green">{t("student.ciPass")}</Badge>
          ) : repo.ciStatus === "fail" ? (
            <Badge tone="red">{t("student.ciFail")}</Badge>
          ) : null}
          {repo.gradeFrozen ? (
            // Countdown to deadline + grace, then "running" until the
            // authoritative review lands (llmGrade above takes over).
            <Tip label={t("student.reviewPendingTip")}>
              <span className="inline-flex items-center gap-1 text-xs text-warning">
                <Bot className={`size-3.5 ${now >= reviewAt ? "animate-pulse" : ""}`} />
                {now < reviewAt
                  ? t("student.reviewIn", { t: formatDuration(reviewAt - now, t) })
                  : t("student.reviewRunning")}
              </span>
            </Tip>
          ) : null}
        </>
      )}
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
    <span className="inline-flex items-center gap-1 text-xs font-normal text-fg-muted">
      <MonitorPlay className="size-3 shrink-0" />
      {t(note)}
    </span>
  );
}

function isLocked(a: StudentAssignment) {
  return a.state === "locked" || a.repo?.lockedAt != null;
}
function isAccepted(a: StudentAssignment) {
  return a.repo?.provisionStatus === "ok" && Boolean(a.repo.fullName);
}

/** Assignment name, linked to the repository when the mode allows it. */
function AssignmentName({ a, className = "" }: { a: StudentAssignment; className?: string }) {
  const { nameIsLink } = rowAffordances({ workMode: a.workMode, accepted: isAccepted(a), locked: isLocked(a) });
  return nameIsLink ? (
    <a
      href={`https://github.com/${a.repo!.fullName}`}
      target="_blank"
      rel="noreferrer"
      className={cx("hover:text-accent hover:underline", className)}
    >
      {a.name}
    </a>
  ) : (
    <span className={className}>{a.name}</span>
  );
}

/** The one action of a row: accept, open the repository, or start. */
function RowAction({
  a,
  githubLinked,
  codespaceHost,
  align = "end",
  emphasis = "secondary",
}: {
  a: StudentAssignment;
  githubLinked: boolean;
  /** Portal host, for the `sebs://` deep link; null = no portal configured. */
  codespaceHost: string | null;
  align?: "start" | "end";
  /** Accent fill only where the screen wants the eye: the "Up next" card.
      In the rows the same action stays secondary, so one red button leads. */
  emphasis?: "primary" | "secondary";
}) {
  const t = useT();
  const qc = useQueryClient();
  const accept = useMutation({
    mutationFn: () => api(`/app/api/student/assignments/${a.id}/accept`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["student-classrooms"] }),
  });
  const acceptError =
    accept.isError && accept.error instanceof ApiError
      ? // A groupmate is creating the same repository right now (issue #2).
        (accept.error.body as { error?: string } | null)?.error === "provision_in_progress"
        ? t("student.provisionInProgress")
        : apiErrorMessage(accept.error, "Acceptance failed")
      : null;
  const locked = isLocked(a);
  const accepted = isAccepted(a);
  const examOnly = a.workMode === "online_seb";
  const { repoButton, startButton } = rowAffordances({ workMode: a.workMode, accepted, locked });
  const wrap = cx("flex flex-col gap-1.5", align === "end" ? "items-end text-right" : "items-start");

  if (accepted) {
    return (
      <div className={wrap}>
        <div className={cx("flex flex-wrap items-center gap-2", align === "end" && "justify-end")}>
          {repoButton ? (
            <LinkButton href={`https://github.com/${a.repo!.fullName}`} target="_blank" rel="noreferrer">
              <GithubIcon /> {t("student.openRepo")}
            </LinkButton>
          ) : null}
          {startButton ? (
            // Plain navigation: this URL is also the SEB startURL, so it
            // must work as a link, not as a fetch.
            <LinkButton href={`/app/codespace/start/${a.id}`} variant={emphasis}>
              <Play /> {t("student.start")}
            </LinkButton>
          ) : null}
        </div>
        {a.repo!.invitationStatus === "pending" ? (
          <p className="max-w-xs text-xs text-warning">{t("student.acceptInvite")}</p>
        ) : null}
        {examOnly && codespaceHost ? (
          <>
            <a
              href={`sebs://${codespaceHost}/exam/${a.id}.seb`}
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-accent hover:underline"
            >
              <MonitorPlay className="size-4" /> {t("student.openSeb")}
            </a>
            <p className="max-w-xs text-xs text-fg-muted">{t("student.sebOnly")}</p>
          </>
        ) : null}
      </div>
    );
  }
  return (
    <div className={wrap}>
      <Tip label={githubLinked ? null : t("student.linkPrompt")}>
        <Button
          variant={emphasis}
          onClick={() => accept.mutate()}
          disabled={!githubLinked || locked}
          loading={accept.isPending}
        >
          {accept.isPending
            ? t("student.creating")
            : a.repo?.provisionStatus === "error"
              ? t("student.retry")
              : t("student.accept")}
        </Button>
      </Tip>
      {acceptError ? <p className="text-xs text-danger">{acceptError}</p> : null}
    </div>
  );
}

function StatusBadge({ a }: { a: StudentAssignment }) {
  const t = useT();
  if (isLocked(a)) return <Badge tone="zinc" icon={Lock}>{t("student.locked")}</Badge>;
  if (isAccepted(a)) {
    return (
      <Badge tone="green" icon={CheckCircle2}>
        {t("status.accepted")}
      </Badge>
    );
  }
  return <Badge tone="amber">{t("status.notAccepted")}</Badge>;
}

/** Group assignment (issue #2): the group, and who the repository is shared with. */
function GroupLine({ group }: { group: NonNullable<StudentAssignment["group"]> }) {
  const t = useT();
  return (
    <Tip label={t("student.groupTip")}>
      <p className="mt-1 flex items-center gap-x-2 text-[13px] text-fg-muted">
        <UsersRound className="size-3.5 shrink-0 text-fg-faint" />
        <span>
          {group.teammates.length > 0
            ? t("student.groupWith", { group: group.name, names: group.teammates.join(", ") })
            : group.name}
        </span>
      </p>
    </Tip>
  );
}

/** One assignment as a row of the classroom card. */
function StudentAssignmentRow({
  a,
  githubLinked,
  codespaceHost,
}: {
  a: StudentAssignment;
  githubLinked: boolean;
  codespaceHost: string | null;
}) {
  const locked = isLocked(a);
  const { modeNote } = rowAffordances({ workMode: a.workMode, accepted: isAccepted(a), locked });
  return (
    <li className={cx("flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4", locked && "opacity-70")}>
      <div className="min-w-56 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <AssignmentName a={a} className="text-[15px] font-semibold tracking-tight" />
          <StatusBadge a={a} />
          {modeNote ? <ModeNote note={modeNote} /> : null}
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] text-fg-muted">
          <CalendarClock className="size-3.5 text-fg-faint" />
          <span className="whitespace-nowrap">{isoDateTime(a.deadlineAt)}</span>
          <Countdown deadline={a.deadlineAt} />
        </p>
        {a.group ? <GroupLine group={a.group} /> : null}
      </div>
      {isAccepted(a) ? (
        <div className="flex-1">
          <RepoMetrics
            repo={a.repo!}
            reviewAt={new Date(a.deadlineAt).getTime() + a.graceMinutes * 60_000}
            showGrades={a.gradingMode !== "none"}
            validated={a.gradesValidatedAt != null}
          />
        </div>
      ) : null}
      <div className="flex items-center gap-4">
        {isAccepted(a) ? <RepoTests repo={a.repo!} /> : null}
        <RowAction a={a} githubLinked={githubLinked} codespaceHost={codespaceHost} />
      </div>
    </li>
  );
}

type StudentSortKey = "name" | "deadline" | "status" | "grade";

/**
 * One classroom as a section holding its assignment rows. The global search
 * filters the rows (a hit on the classroom name keeps everything); a
 * classroom with no match disappears entirely.
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
  const sorted = [...visible].sort((x, y) => x.deadlineAt.localeCompare(y.deadlineAt));
  if (query !== "" && visible.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <OrgAvatar login={room.orgLogin} className="size-6 rounded-md" />
        <h2 className="text-base font-bold tracking-tight">{room.name}</h2>
        <span className="text-[13px] text-fg-muted">{t("student.teacher", { name: room.teacher })}</span>
      </div>
      <Card>
        {sorted.length ? (
          <ul className="divide-y divide-line">
            {sorted.map((a) => (
              <StudentAssignmentRow
                key={a.id}
                a={a}
                githubLinked={githubLinked}
                codespaceHost={codespaceHost}
              />
            ))}
          </ul>
        ) : (
          <p className="px-5 py-4 text-sm text-fg-muted">{t("student.noAssignments")}</p>
        )}
      </Card>
    </section>
  );
}

function GradeCell({ a }: { a: StudentAssignment }) {
  if (a.gradingMode === "none") return <span className="text-fg-faint">—</span>;
  if (a.gradesValidatedAt && a.repo && finalGrade(a.repo)) {
    return (
      <span className="inline-flex items-center gap-1">
        <CheckCircle2 className="size-3.5 text-success" />
        <GradeScale points={finalGrade(a.repo)!.points} max={finalGrade(a.repo)!.max} />
      </span>
    );
  }
  if (a.repo?.llmGrade && a.repo.llmGrade.parseStatus === "ok") {
    return (
      <span className="inline-flex items-center gap-1">
        <Bot className="size-3.5 text-accent" />
        <GradeScale points={a.repo.llmGrade.points!} max={a.repo.llmGrade.max!} />
      </span>
    );
  }
  const indicative = a.repo ? indicativeGrade(a.repo) : null;
  if (indicative) return <GradeScale points={indicative.points!} max={indicative.max!} />;
  // Score pipeline before the review: the tests are the feedback.
  if (a.repo && testCounts(a.repo)) return <RepoTests repo={a.repo} size={44} />;
  return <span className="text-fg-faint">—</span>;
}

/** Flat sortable table of every (classroom, assignment) pair. */
function StudentList({
  rows,
  githubLinked,
  codespaceHost,
}: {
  rows: { room: StudentClassroom; a: StudentAssignment }[];
  githubLinked: boolean;
  codespaceHost: string | null;
}) {
  const t = useT();
  const ranks: Record<StudentSortKey, (a: StudentAssignment) => string | number> = {
    name: (a) => a.name.toLowerCase(),
    deadline: (a) => new Date(a.deadlineAt).getTime(),
    status: (a) => (a.repo?.provisionStatus === "ok" ? 1 : 0),
    grade: (a) =>
      a.repo && indicativeGrade(a.repo)
        ? gradeToSix(a.repo.grade!.points!, a.repo.grade!.max!)
        : -1,
  };
  const { sorted, sort, toggle } = useSortableTable(
    rows,
    ({ a }, key: StudentSortKey) => ranks[key](a),
    { key: "deadline", dir: 1 },
    (va, vb) => (va < vb ? -1 : va > vb ? 1 : 0),
  );
  const Th = ({ k, children }: { k: StudentSortKey; children: React.ReactNode }) => (
    <SortHeader k={k} sort={sort} onToggle={toggle}>
      {children}
    </SortHeader>
  );
  return (
    <Card className="overflow-hidden">
      {/* Six columns never fit a phone: the table scrolls, the page does not. */}
      <div className="overflow-x-auto">
        <table className={cx(T.table, "min-w-200")}>
          <thead>
            <tr className={T.head}>
              <th className={T.th}>{t("nav.classrooms")}</th>
              <Th k="name">{t("nav.assignment")}</Th>
              <Th k="deadline">{t("student.deadlineCol")}</Th>
              <Th k="status">{t("assignment.col.status")}</Th>
              <Th k="grade">{t("assignment.col.grade")}</Th>
              <th className={T.th} />
            </tr>
          </thead>
          <tbody>
            {sorted.map(({ room, a }) => {
              const locked = isLocked(a);
              const { modeNote } = rowAffordances({ workMode: a.workMode, accepted: isAccepted(a), locked });
              return (
                <tr key={a.id} className={cx(T.row, locked && "opacity-70")}>
                  <td className={`${T.td} text-fg-muted`}>{room.name}</td>
                  <td className={`${T.td} font-semibold`}>
                    <span className="flex flex-col">
                      <AssignmentName a={a} />
                      {modeNote ? <ModeNote note={modeNote} /> : null}
                    </span>
                  </td>
                  <td className={`${T.td} whitespace-nowrap`}>
                    <span className="flex flex-col leading-tight">
                      <span className="text-fg-muted">{isoDateTime(a.deadlineAt)}</span>
                      <Countdown deadline={a.deadlineAt} className="text-xs" />
                    </span>
                  </td>
                  <td className={T.td}>
                    <StatusBadge a={a} />
                  </td>
                  <td className={T.td}>
                    <GradeCell a={a} />
                  </td>
                  <td className={`${T.td} text-right`}>
                    <RowAction a={a} githubLinked={githubLinked} codespaceHost={codespaceHost} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** Within this window an accepted assignment is still worth a reminder. */
const UP_NEXT_SOON_MS = 48 * 60 * 60 * 1000;

/**
 * The "Up next" card only earns its place when it asks for something: an
 * assignment still to accept, or a deadline within 48 hours. Otherwise it
 * repeats the row right below it (an assignment just accepted showed twice).
 */
export function pickUpNext<T extends { a: StudentAssignment }>(open: T[], now: number): T | null {
  return (
    [...open]
      .sort((x, y) => x.a.deadlineAt.localeCompare(y.a.deadlineAt))
      .find(
        ({ a }) => !isAccepted(a) || new Date(a.deadlineAt).getTime() - now < UP_NEXT_SOON_MS,
      ) ?? null
  );
}

/** What the student should look at first, when there is something to do. */
function UpNext({
  item,
  githubLinked,
  codespaceHost,
}: {
  item: { room: StudentClassroom; a: StudentAssignment };
  githubLinked: boolean;
  codespaceHost: string | null;
}) {
  const t = useT();
  const { a, room } = item;
  return (
    <Card className="flex flex-wrap items-center gap-x-6 gap-y-3 border-accent/25 bg-accent-soft/40 px-5 py-4">
      <div className="min-w-56 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-accent">{t("student.upNext")}</p>
        <p className="mt-1 text-[17px] font-bold tracking-tight">
          <AssignmentName a={a} />
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-fg-muted">
          <span>{room.name}</span>
          <span aria-hidden>·</span>
          <span>{isoDateTime(a.deadlineAt)}</span>
          <Countdown deadline={a.deadlineAt} />
        </p>
      </div>
      <RowAction a={a} githubLinked={githubLinked} codespaceHost={codespaceHost} emphasis="primary" />
    </Card>
  );
}

type StudentView = "cards" | "list";

export function StudentHome({ me }: { me: Me }) {
  const t = useT();
  const now = useNow(60_000);
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

  const linked = me.githubLogin != null;

  // Flat, searchable list of (classroom, assignment) pairs.
  const flat = (rooms.data ?? []).flatMap((room) =>
    room.assignments.map((a) => ({ room, a })),
  );
  const filteredFlat = fuzzyFilter(query, flat, ({ room, a }) => `${a.name} ${room.name}`);
  const open = flat.filter(({ a }) => !isLocked(a) && new Date(a.deadlineAt).getTime() > now);
  const upNext = pickUpNext(open, now);

  const viewOption = (value: StudentView, Icon: typeof LayoutGrid, label: string) => ({
    value,
    label: (
      <span className="inline-flex items-center gap-1.5" title={label}>
        <Icon className="size-4" />
        <span className="sr-only">{label}</span>
      </span>
    ),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            {t("student.title")}
            <HelpIcon topic="student-home" />
          </span>
        }
        description={
          rooms.data
            ? t(open.length === 1 ? "student.summary.one" : "student.summary", { n: open.length })
            : null
        }
      />

      {!linked ? (
        <Alert
          tone="warning"
          icon={AlertTriangle}
          action={
            <LinkButton href="/app/auth/github/link" size="sm" variant="primary">
              <GithubIcon /> {t("student.linkAction")}
            </LinkButton>
          }
        >
          {t("student.linkPrompt")}
        </Alert>
      ) : null}

      {rooms.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-20 w-full rounded-card" />
          <Skeleton className="h-40 w-full rounded-card" />
        </div>
      ) : rooms.isError ? (
        <QueryError
          title={t("student.loadFailed")}
          error={rooms.error}
          onRetry={() => void rooms.refetch()}
          retrying={rooms.isFetching}
          fallback={t("error.server")}
        />
      ) : !rooms.data?.length ? (
        <Card>
          <EmptyState icon={ClipboardList} title={t("student.empty.title")}>
            {t("student.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        <>
          {upNext && query === "" ? (
            <UpNext item={upNext} githubLinked={linked} codespaceHost={me.codespaceHost} />
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              placeholder={t("common.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t("common.search")}
              className="w-full sm:w-56"
            />
            <span className="hidden flex-1 sm:block" />
            <Segmented
              name="student-view"
              value={view}
              onChange={setStudentView}
              options={[
                viewOption("cards", LayoutGrid, t("view.cards")),
                viewOption("list", List, t("view.list")),
              ]}
            />
          </div>

          {query !== "" && filteredFlat.length === 0 ? (
            <Card>
              <EmptyState icon={SearchX} title={t("student.noMatch")} className="py-12">
                {t("student.noMatchBody")}
              </EmptyState>
            </Card>
          ) : view === "list" ? (
            <StudentList rows={filteredFlat} githubLinked={linked} codespaceHost={me.codespaceHost} />
          ) : (
            <div className="space-y-8">
              {rooms.data.map((room) => (
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
        </>
      )}
    </div>
  );
}
