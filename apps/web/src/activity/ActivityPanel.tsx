import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

import type { ActivityData, Commit } from "@hgc/contracts";

import { api, apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { Alert, Button, isoDateTime } from "../ui";
import { buildGraph, laneColor } from "./graph";

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
              fill="var(--accent)"
            >
              <title>{`${label(i)} — ${n} commit${n > 1 ? "s" : ""}`}</title>
            </rect>
          );
        })}
        <line x1={0} y1={H + 0.5} x2={width} y2={H + 0.5} className="stroke-line-strong" strokeWidth={1} />
      </svg>
      <figcaption className="mt-1 flex justify-between text-[10px] text-fg-faint">
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
    <div className="flex max-h-72 overflow-y-auto text-[13px]">
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
              className="stroke-surface"
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
                className="shrink-0 font-mono text-xs text-fg-faint hover:text-accent hover:underline"
              >
                {c.sha.slice(0, 7)}
              </a>
            ) : (
              <span className="shrink-0 font-mono text-xs text-fg-faint">{c.sha.slice(0, 7)}</span>
            )}
            {headsOf(c.sha).map((b) => (
              <span
                key={b.name}
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-fg-muted"
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
            <span className="shrink-0 text-xs text-fg-faint">
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
    return <p className="text-xs text-fg-faint">{t("assignment.activity.noTests")}</p>;
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
        <line x1={0} y1={H + 0.5} x2={W} y2={H + 0.5} className="stroke-line-strong" strokeWidth={1} />
        <path d={step((p) => p.total)} fill="none" strokeWidth={2} strokeDasharray="4 3"
          className="stroke-line-strong" />
        <path d={step((p) => p.passed)} fill="none" stroke="var(--accent)" strokeWidth={2} />
        {pts.map((p, i) => (
          <circle key={i} cx={px(p.ts)} cy={py(p.passed)} r={3.5} fill="var(--accent)"
            className="stroke-surface" strokeWidth={1.5}>
            <title>{`${new Date(p.ts).toISOString().slice(0, 16).replace("T", " ")} — ${p.passed}/${p.total}`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="mt-1 flex items-center justify-between text-[10px] text-fg-faint">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0.5 w-3 rounded bg-accent" /> {t("assignment.activity.passed")}
          <span className="ml-2 inline-block h-0.5 w-3 rounded border-t border-dashed border-fg-faint" />{" "}
          {t("assignment.activity.total")}
        </span>
        <span>max {maxY}</span>
      </figcaption>
    </figure>
  );
}

/** Expanded row: full-width commit history (git graph when branched), then
 *  commits-per-day and tests-over-time side by side. */
export function ActivityPanel({
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
      <p className="flex items-center gap-2 px-5 py-4 text-sm text-fg-muted">
        <Loader2 className="size-4 animate-spin" /> Loading activity…
      </p>
    );
  }
  if (activity.isError) {
    return (
      <div className="p-4">
        <Alert
          tone="danger"
          icon={AlertTriangle}
          title="Could not load this repository's activity"
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void activity.refetch()}
              loading={activity.isFetching}
            >
              <RefreshCw /> Retry
            </Button>
          }
        >
          {apiErrorMessage(activity.error, "The server did not answer.")}
        </Alert>
      </div>
    );
  }
  const commits = activity.data?.commits ?? [];
  const tests = activity.data?.tests ?? [];
  if (commits.length === 0 && tests.length === 0) {
    return (
      <p className="px-5 py-4 text-sm text-fg-muted">{t("assignment.activity.empty")}</p>
    );
  }
  const sub = "rounded-field border border-line bg-surface p-3";
  const heading = "mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-faint";
  return (
    <div className="space-y-3 px-5 py-4">
      {commits.length ? (
        <div className={sub}>
          <CommitList commits={commits} branches={activity.data?.branches ?? []} fullName={fullName} />
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className={sub}>
          <h4 className={heading}>{t("assignment.activity.commitsOverTime")}</h4>
          {commits.length ? <ActivityChart commits={commits} /> : (
            <p className="text-xs text-fg-faint">{t("assignment.activity.empty")}</p>
          )}
        </div>
        <div className={sub}>
          <h4 className={heading}>{t("assignment.activity.testsOverTime")}</h4>
          <TestsChart tests={tests} />
        </div>
      </div>
    </div>
  );
}
