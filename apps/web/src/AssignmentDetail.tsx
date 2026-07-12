import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
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

import { api, ApiError } from "./api";
import { fuzzyFilter } from "./fuzzy";
import { HelpIcon } from "./help";
import { useT } from "./i18n";
import { Badge, Button, GithubIcon, isoDateTime, Modal } from "./ui";

export interface GradeView {
  points: number | null;
  max: number | null;
  testsPassed: number | null;
  testsTotal: number | null;
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

function CiBadge({ s, tests }: { s: DetailStudent["repo"]; tests?: GradeView | null }) {
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
      <span className="pointer-events-none absolute left-0 top-full z-30 mt-1 hidden whitespace-nowrap rounded-lg bg-white px-2.5 py-1.5 text-xs shadow-[0_4px_24px_rgb(0_0_0/0.15)] ring-1 ring-zinc-100 group-hover/pop:block dark:bg-zinc-900 dark:ring-zinc-800">
        {login ? (
          <span className="font-medium">{login}</span>
        ) : null}
        <span className="text-zinc-500 dark:text-zinc-400">{login ? " · " : ""}{fullName}</span>
      </span>
    </span>
  );
}

interface Commit {
  sha: string;
  message: string;
  author: string;
  date: string | null;
  parents: string[];
}

interface ActivityData {
  commits: Commit[];
  branches: { name: string; headSha: string }[];
  tests: { date: string; passed: number | null; total: number | null }[];
}

/**
 * Git-graph lane layout (newest first). Each lane holds the sha it expects
 * next; a commit lands on the first lane waiting for it (extra waiting lanes
 * close — they converge here), or opens a lane. Extra parents of a merge get
 * their own expectation so the branch is visible until its tip.
 * Lane palette validated (dataviz six checks, light+dark; the commit list is
 * the table view covering the dark-contrast warning).
 */
const LANE_COLORS = ["#b41f24", "#1d4ed8", "#0d9488", "#b45309", "#7e22ce"];
const laneColor = (l: number) => LANE_COLORS[l % LANE_COLORS.length]!;

function buildGraph(commits: Commit[]) {
  const rowOf = new Map(commits.map((c, i) => [c.sha, i]));
  const laneOf = new Map<string, number>();
  const lanes: (string | null)[] = [];
  for (const c of commits) {
    const waiting = lanes.flatMap((s, i) => (s === c.sha ? [i] : []));
    let lane: number;
    if (waiting.length > 0) {
      lane = waiting[0]!;
      for (const l of waiting.slice(1)) lanes[l] = null;
    } else {
      const free = lanes.indexOf(null);
      lane = free >= 0 ? free : lanes.length;
      if (free < 0) lanes.push(null);
    }
    laneOf.set(c.sha, lane);
    const [first, ...rest] = c.parents;
    lanes[lane] = first && !laneOf.has(first) ? first : null;
    for (const p of rest) {
      if (laneOf.has(p) || lanes.includes(p)) continue;
      const free = lanes.indexOf(null);
      if (free >= 0) lanes[free] = p;
      else lanes.push(p);
    }
  }
  const edges: { r1: number; l1: number; r2: number; l2: number }[] = [];
  for (const c of commits) {
    for (const p of c.parents) {
      const r2 = rowOf.get(p);
      if (r2 === undefined) continue; // parent beyond the fetched window
      edges.push({ r1: rowOf.get(c.sha)!, l1: laneOf.get(c.sha)!, r2, l2: laneOf.get(p)! });
    }
  }
  return { laneOf, edges, laneCount: lanes.length };
}

/**
 * Commits over time, one thin accent column per bucket (day, or week when the
 * span exceeds ~10 weeks). Real timeline: empty buckets stay visible. Single
 * series — the caption names it, no legend; the commit list beside the chart
 * is the table view of the same data.
 */
function ActivityChart({ commits }: { commits: Commit[] }) {
  const t = useT();
  const dates = commits
    .filter((c) => c.date)
    .map((c) => new Date(c.date!).getTime())
    .sort((a, b) => a - b);
  if (dates.length === 0) return null;
  const DAY = 86_400_000;
  const first = Math.floor(dates[0]! / DAY);
  const last = Math.floor(dates[dates.length - 1]! / DAY);
  const spanDays = last - first + 1;
  const weekly = spanDays > 70;
  const bucketOf = (ts: number) =>
    weekly ? Math.floor((Math.floor(ts / DAY) - first) / 7) : Math.floor(ts / DAY) - first;
  const buckets = new Array<number>(bucketOf(dates[dates.length - 1]!) + 1).fill(0);
  for (const ts of dates) buckets[bucketOf(ts)]! += 1;
  const max = Math.max(...buckets);

  const STEP = 8; // 6px bar + 2px gap
  const H = 64;
  const width = buckets.length * STEP;
  const label = (i: number) =>
    new Date((first + i * (weekly ? 7 : 1)) * DAY).toISOString().slice(0, 10);
  return (
    <figure className="min-w-0">
      <svg
        viewBox={`0 0 ${width} ${H + 14}`}
        className="h-24 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${commits.length} commits, ${weekly ? t("assignment.activity.perWeek") : t("assignment.activity.perDay")}`}
      >
        {buckets.map((n, i) => {
          const h = n === 0 ? 0 : Math.max(3, (n / max) * H);
          return (
            <rect
              key={i}
              x={i * STEP + 1}
              y={H - h}
              width={STEP - 2}
              height={h}
              rx={1.5}
              fill="var(--color-accent)"
            >
              <title>{`${label(i)} — ${n} commit${n > 1 ? "s" : ""}`}</title>
            </rect>
          );
        })}
        <line x1={0} y1={H + 0.5} x2={width} y2={H + 0.5} className="stroke-zinc-200 dark:stroke-zinc-700" strokeWidth={1} />
      </svg>
      <figcaption className="mt-1 flex justify-between text-[10px] text-zinc-400">
        <span>{label(0)}</span>
        <span>
          max {max} · {weekly ? t("assignment.activity.perWeek") : t("assignment.activity.perDay")}
        </span>
        <span>{label(buckets.length - 1)}</span>
      </figcaption>
    </figure>
  );
}

/**
 * Commit history with a git graph rail on the left. The rail only appears
 * when the history actually branches (more than one lane); the textual rows
 * are the table view of the same data.
 */
function CommitList({
  commits,
  branches,
  fullName,
}: {
  commits: Commit[];
  branches: ActivityData["branches"];
  fullName: string | null;
}) {
  const ROW = 26;
  const LANE_W = 12;
  const { laneOf, edges, laneCount } = buildGraph(commits);
  const showGraph = laneCount > 1;
  const width = laneCount * LANE_W;
  const x = (l: number) => l * LANE_W + LANE_W / 2;
  const y = (r: number) => r * ROW + ROW / 2;
  const headsOf = (sha: string) => branches.filter((b) => b.headSha === sha);

  return (
    <div className="flex max-h-72 overflow-y-auto text-sm">
      {showGraph ? (
        <svg
          width={width}
          height={commits.length * ROW}
          className="shrink-0"
          aria-hidden="true"
        >
          {edges.map((e, i) => {
            const [x1, y1, x2, y2] = [x(e.l1), y(e.r1), x(e.l2), y(e.r2)];
            const color = laneColor(e.l1 === e.l2 ? e.l1 : Math.max(e.l1, e.l2));
            const d =
              e.l1 === e.l2
                ? `M ${x1} ${y1} L ${x2} ${y2}`
                : `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;
            return <path key={i} d={d} fill="none" stroke={color} strokeWidth={2} />;
          })}
          {commits.map((c, r) => (
            <circle
              key={c.sha}
              cx={x(laneOf.get(c.sha)!)}
              cy={y(r)}
              r={3.5}
              fill={laneColor(laneOf.get(c.sha)!)}
              className="stroke-white dark:stroke-zinc-900"
              strokeWidth={2}
            />
          ))}
        </svg>
      ) : null}
      <ol className="min-w-0 flex-1">
        {commits.map((c) => (
          <li key={c.sha} className="flex items-center gap-2 pr-2" style={{ height: ROW }}>
            {fullName ? (
              <a
                href={`https://github.com/${fullName}/commit/${c.sha}`}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 font-mono text-xs text-zinc-400 hover:text-accent hover:underline"
              >
                {c.sha.slice(0, 7)}
              </a>
            ) : (
              <span className="shrink-0 font-mono text-xs text-zinc-400">{c.sha.slice(0, 7)}</span>
            )}
            {headsOf(c.sha).map((b) => (
              <span
                key={b.name}
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
              >
                <span
                  className="inline-block size-1.5 rounded-full"
                  style={{ background: laneColor(laneOf.get(c.sha) ?? 0) }}
                />
                {b.name}
              </span>
            ))}
            <span className="min-w-0 flex-1 truncate" title={c.message}>
              {c.message}
            </span>
            <span className="shrink-0 text-xs text-zinc-400">
              {c.date ? isoDateTime(c.date) : ""}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Test counters over time (TESTS annotation): step line of passed tests plus
 * a muted dashed line for the total, so a growing suite reads honestly. Two
 * series → inline legend; per-point hover via <title>.
 */
function TestsChart({ tests }: { tests: ActivityData["tests"] }) {
  const t = useT();
  const pts = tests
    .filter((r) => r.total !== null)
    .map((r) => ({ ts: new Date(r.date).getTime(), passed: r.passed ?? 0, total: r.total! }));
  if (pts.length === 0) {
    return <p className="text-xs text-zinc-400">{t("assignment.activity.noTests")}</p>;
  }
  const W = 320;
  const H = 78;
  const PAD = 6;
  const t0 = pts[0]!.ts;
  const t1 = pts[pts.length - 1]!.ts;
  const maxY = Math.max(...pts.map((p) => p.total), 1);
  const px = (ts: number) => (t1 === t0 ? W / 2 : PAD + ((ts - t0) / (t1 - t0)) * (W - 2 * PAD));
  const py = (v: number) => H - (v / maxY) * (H - 8);
  // Step-after paths: a run's value holds until the next run.
  const step = (get: (p: (typeof pts)[number]) => number) => {
    let d = `M ${px(pts[0]!.ts)} ${py(get(pts[0]!))}`;
    for (let i = 1; i < pts.length; i += 1) {
      d += ` H ${px(pts[i]!.ts)} V ${py(get(pts[i]!))}`;
    }
    return d;
  };
  return (
    <figure className="min-w-0">
      <svg viewBox={`0 0 ${W} ${H + 14}`} className="h-24 w-full" role="img"
        aria-label={t("assignment.activity.testsOverTime")}>
        <line x1={0} y1={H + 0.5} x2={W} y2={H + 0.5} className="stroke-zinc-200 dark:stroke-zinc-700" strokeWidth={1} />
        <path d={step((p) => p.total)} fill="none" strokeWidth={2} strokeDasharray="4 3"
          className="stroke-zinc-300 dark:stroke-zinc-600" />
        <path d={step((p) => p.passed)} fill="none" stroke="var(--color-accent)" strokeWidth={2} />
        {pts.map((p, i) => (
          <circle key={i} cx={px(p.ts)} cy={py(p.passed)} r={3.5} fill="var(--color-accent)"
            className="stroke-white dark:stroke-zinc-900" strokeWidth={1.5}>
            <title>{`${new Date(p.ts).toISOString().slice(0, 16).replace("T", " ")} — ${p.passed}/${p.total}`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="mt-1 flex items-center justify-between text-[10px] text-zinc-400">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0.5 w-3 rounded bg-accent" /> {t("assignment.activity.passed")}
          <span className="ml-2 inline-block h-0.5 w-3 rounded border-t border-dashed border-zinc-400" />{" "}
          {t("assignment.activity.total")}
        </span>
        <span>max {maxY}</span>
      </figcaption>
    </figure>
  );
}

/** Expanded row: full-width commit history (git graph when branched), then
 *  commits-per-day and tests-over-time side by side. */
function ActivityPanel({
  classroomId,
  assignmentId,
  repoId,
  fullName,
}: {
  classroomId: string;
  assignmentId: string;
  repoId: string;
  fullName: string | null;
}) {
  const t = useT();
  const activity = useQuery<ActivityData>({
    queryKey: ["repo-activity", repoId],
    queryFn: () =>
      api(`/app/api/classrooms/${classroomId}/assignments/${assignmentId}/repos/${repoId}/activity`),
    staleTime: 60_000,
  });
  if (activity.isLoading) {
    return (
      <p className="flex items-center gap-2 px-4 py-4 text-sm text-zinc-500 dark:text-zinc-400">
        <Loader2 className="size-4 animate-spin" /> Loading activity…
      </p>
    );
  }
  const commits = activity.data?.commits ?? [];
  const tests = activity.data?.tests ?? [];
  if (commits.length === 0 && tests.length === 0) {
    return (
      <p className="px-4 py-4 text-sm text-zinc-500 dark:text-zinc-400">
        {t("assignment.activity.empty")}
      </p>
    );
  }
  const sub = "rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/40";
  return (
    <div className="space-y-3 px-4 py-3">
      {commits.length ? (
        <div className={sub}>
          <CommitList commits={commits} branches={activity.data?.branches ?? []} fullName={fullName} />
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className={sub}>
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
            {t("assignment.activity.commitsOverTime")}
          </h4>
          {commits.length ? <ActivityChart commits={commits} /> : (
            <p className="text-xs text-zinc-400">{t("assignment.activity.empty")}</p>
          )}
        </div>
        <div className={sub}>
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
            {t("assignment.activity.testsOverTime")}
          </h4>
          <TestsChart tests={tests} />
        </div>
      </div>
    </div>
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
  s: DetailStudent;
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
          <Badge tone="red" icon={XCircle}>
            {t("status.provisionError")}
          </Badge>
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
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [dir, setDir] = useState<1 | -1>(1);
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

  const sortVal = (s: DetailStudent): string | number => {
    switch (sortKey) {
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
  const shown = fuzzyFilter(
    query,
    students,
    (s) => `${s.nom} ${s.prenom} ${s.githubLogin ?? ""} ${s.email}`,
  );
  const rows =
    query.trim() !== ""
      ? shown // la recherche trie déjà par pertinence
      : [...shown].sort((x, y) => {
          const vx = sortVal(x);
          const vy = sortVal(y);
          return (
            (typeof vx === "number" && typeof vy === "number"
              ? vx - vy
              : String(vx).localeCompare(String(vy))) * dir
          );
        });

  function Th({ k, children, right }: { k: SortKey; children: React.ReactNode; right?: boolean }) {
    const active = sortKey === k;
    return (
      <th className={`${cell} font-medium ${right ? "text-right" : ""}`}>
        <button
          className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-zinc-900 dark:hover:text-zinc-100"
          onClick={() => {
            if (active) setDir((d) => (d === 1 ? -1 : 1));
            else {
              setSortKey(k);
              setDir(1);
            }
          }}
        >
          {children}
          {active ? (dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : null}
        </button>
      </th>
    );
  }

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
