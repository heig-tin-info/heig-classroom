import { useEffect, useRef, useState } from "react";
import {
  CalendarRange,
  ChevronDown,
  ChevronRight,
  Crosshair,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import type { ClassroomSummary } from "./api";
import { HelpIcon } from "./help";
import { Card, EmptyState, OrgAvatar } from "./ui";

/**
 * Assignment occupancy timeline: one row per classroom, and — when expanded —
 * one dedicated lane per non-archived assignment so overlapping date ranges no
 * longer stack on top of each other. The time axis is interactive: the wheel
 * and drag pan through past/future, ctrl/⌘+wheel (or the buttons) zoom, and the
 * crosshair re-focuses on whatever is in progress right now.
 *
 * Hand-rolled with CSS + pointer events: the gantt libraries around either drag
 * their own theme (frappe-gantt, vis-timeline) or are unmaintained; this stays
 * exactly on the design system and costs no bundle weight.
 */
const DAY = 86_400_000;
const MIN_SPAN = 3 * DAY;
const MAX_SPAN = 6 * 365 * DAY;

// Row heights, shared by the label column and the track column so the two stay
// pixel-aligned. Keep these in sync with the Tailwind classes below.
const AXIS_H = "h-6"; // 24px
const ROOM_H = "h-8"; // 32px
const LANE_H = "h-9"; // 36px

type View = { from: number; to: number };
type Tick = { t: number; label: boolean; text: string; major: boolean };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d;
};
const shortMon = (d: Date) => d.toLocaleDateString("en-US", { month: "short" });

/** Default window: frame the assignments in progress (or nearest to now), with
 *  a little margin, always keeping "now" inside the frame. */
function computeDefault(rooms: ClassroomSummary[]): View {
  const now = Date.now();
  const all = rooms.flatMap((r) => r.assignments);
  const span = (a: { startAt: string; deadlineAt: string }) => ({
    s: new Date(a.startAt).getTime(),
    d: new Date(a.deadlineAt).getTime(),
  });
  const ongoing = all.filter((a) => {
    const { s, d } = span(a);
    return s <= now && now <= d;
  });
  const near = all.filter((a) => {
    const { s, d } = span(a);
    return Math.abs(s - now) < 30 * DAY || Math.abs(d - now) < 30 * DAY;
  });
  const focus = ongoing.length ? ongoing : near;

  let lo: number;
  let hi: number;
  if (focus.length) {
    lo = Math.min(...focus.map((a) => span(a).s));
    hi = Math.max(...focus.map((a) => span(a).d));
  } else {
    lo = now - 21 * DAY;
    hi = now + 21 * DAY;
  }
  lo = Math.min(lo, now);
  hi = Math.max(hi, now);

  const pad = Math.max((hi - lo) * 0.12, 2 * DAY);
  let from = lo - pad;
  let to = hi + pad;
  if (to - from < MIN_SPAN) {
    const c = (from + to) / 2;
    from = c - MIN_SPAN / 2;
    to = c + MIN_SPAN / 2;
  }
  return { from, to };
}

/** Grid ticks whose granularity follows the zoom level: days when tight,
 *  months at medium range, years when zoomed far out. */
function buildTicks(from: number, to: number): Tick[] {
  const spanDays = (to - from) / DAY;
  const ticks: Tick[] = [];

  if (spanDays <= 75) {
    const dense = spanDays <= 16;
    const d = startOfDay(from);
    while (d.getTime() <= to) {
      const t = d.getTime();
      if (t >= from) {
        const firstOfMonth = d.getDate() === 1;
        const label = dense || d.getDay() === 1 || firstOfMonth;
        const text = dense && !firstOfMonth ? String(d.getDate()) : `${d.getDate()} ${shortMon(d)}`;
        ticks.push({ t, label, text, major: firstOfMonth });
      }
      d.setDate(d.getDate() + 1);
    }
  } else if (spanDays <= 730) {
    const d = new Date(from);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    while (d.getTime() <= to) {
      const t = d.getTime();
      if (t >= from) {
        const jan = d.getMonth() === 0;
        ticks.push({
          t,
          label: true,
          text: jan ? `${shortMon(d)} ${d.getFullYear()}` : shortMon(d),
          major: jan,
        });
      }
      d.setMonth(d.getMonth() + 1);
    }
  } else {
    const d = new Date(from.valueOf());
    d.setMonth(0, 1);
    d.setHours(0, 0, 0, 0);
    while (d.getTime() <= to) {
      const t = d.getTime();
      if (t >= from) ticks.push({ t, label: true, text: String(d.getFullYear()), major: true });
      d.setFullYear(d.getFullYear() + 1);
    }
  }
  return ticks;
}

export function TimelineView({
  rooms,
  onOpenAssignment,
}: {
  rooms: ClassroomSummary[];
  onOpenAssignment: (classroomId: string, assignmentId: string) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(() => computeDefault(rooms));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [dragging, setDragging] = useState(false);

  // Wheel: pan by default (deltaX/deltaY → time), ctrl/⌘ to zoom under the
  // cursor. Registered natively so we can preventDefault (React's onWheel is
  // passive and cannot stop the page from scrolling).
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const frac = (e.clientX - rect.left) / rect.width;
        setView((v) => {
          const span = v.to - v.from;
          const next = clamp(span * Math.exp(e.deltaY * 0.002), MIN_SPAN, MAX_SPAN);
          const anchor = v.from + frac * span;
          const from = anchor - frac * next;
          return { from, to: from + next };
        });
      } else {
        const primary = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        setView((v) => {
          const shift = (primary * (v.to - v.from)) / rect.width;
          return { from: v.from + shift, to: v.to + shift };
        });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const all = rooms.flatMap((r) => r.assignments);
  if (all.length === 0) {
    return (
      <Card>
        <EmptyState icon={CalendarRange} title="Nothing scheduled">
          Assignments appear on the timeline once they have a start date and a deadline.
        </EmptyState>
      </Card>
    );
  }

  const now = Date.now();
  const span = view.to - view.from;
  const pct = (t: number) => ((t - view.from) / span) * 100;
  const ticks = buildTicks(view.from, view.to);
  const nowVisible = now >= view.from && now <= view.to;

  const zoomBy = (factor: number) =>
    setView((v) => {
      const s = v.to - v.from;
      const c = (v.from + v.to) / 2;
      const next = clamp(s * factor, MIN_SPAN, MAX_SPAN);
      return { from: c - next / 2, to: c + next / 2 };
    });

  // Drag to pan. Skip when the gesture starts on a bar/button so clicks still
  // open assignments; track via window listeners so a fast drag off the element
  // keeps following the pointer.
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const rect = trackRef.current!.getBoundingClientRect();
    const start = { x: e.clientX, from: view.from, to: view.to, w: rect.width };
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const shift = (-(ev.clientX - start.x) * (start.to - start.from)) / start.w;
      setView({ from: start.from + shift, to: start.to + shift });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const toggleRoom = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-end gap-1 text-zinc-500">
        <span className="mr-auto inline-flex items-center gap-1 text-xs text-zinc-400">
          Wheel / drag to pan · ⌘/Ctrl + wheel to zoom
          <HelpIcon topic="timeline" />
        </span>
        <IconButton label="Zoom out" onClick={() => zoomBy(1.6)} icon={ZoomOut} />
        <IconButton label="Zoom in" onClick={() => zoomBy(1 / 1.6)} icon={ZoomIn} />
        <IconButton
          label="Focus on what's in progress"
          onClick={() => setView(computeDefault(rooms))}
          icon={Crosshair}
        />
      </div>

      <div className="flex gap-2">
        {/* Label column */}
        <div className="w-52 shrink-0">
          <div className={AXIS_H} />
          {rooms.map((room) => {
            const isCollapsed = collapsed.has(room.id);
            return (
              <div key={room.id}>
                <button
                  onClick={() => toggleRoom(room.id)}
                  className={`flex ${ROOM_H} w-full items-center gap-1 truncate pr-1 text-left text-sm font-medium hover:text-accent`}
                >
                  {isCollapsed ? (
                    <ChevronRight className="size-3.5 shrink-0 text-zinc-400" />
                  ) : (
                    <ChevronDown className="size-3.5 shrink-0 text-zinc-400" />
                  )}
                  <OrgAvatar login={room.orgLogin} className="size-4 shrink-0" />
                  <span className="truncate" title={room.name}>
                    {room.name}
                  </span>
                  <span className="ml-auto shrink-0 text-xs font-normal text-zinc-400">
                    {room.assignments.length}
                  </span>
                </button>
                {!isCollapsed &&
                  room.assignments.map((a) => (
                    <div
                      key={a.id}
                      className={`flex ${LANE_H} items-center gap-1.5 truncate pl-5 pr-1 text-xs text-zinc-500 dark:text-zinc-400`}
                      title={a.name}
                    >
                      <StateDot state={a.state} deadlineAt={a.deadlineAt} now={now} />
                      <span className="truncate">{a.name}</span>
                    </div>
                  ))}
              </div>
            );
          })}
        </div>

        {/* Track column */}
        <div
          ref={trackRef}
          onPointerDown={onPointerDown}
          className={`relative min-w-0 flex-1 select-none touch-none ${
            dragging ? "cursor-grabbing" : "cursor-grab"
          }`}
        >
          {/* Axis */}
          <div className={`relative ${AXIS_H} text-[10px] uppercase tracking-wide text-zinc-400`}>
            {ticks.map((tick) =>
              tick.label ? (
                <span
                  key={tick.t}
                  className={`absolute top-1 -translate-x-1/2 whitespace-nowrap ${
                    tick.major ? "font-semibold text-zinc-500 dark:text-zinc-300" : ""
                  }`}
                  style={{ left: `${pct(tick.t)}%` }}
                >
                  {tick.text}
                </span>
              ) : null,
            )}
          </div>

          {/* Gridlines + now marker, behind the lanes */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 top-6">
            {ticks.map((tick) => (
              <span
                key={tick.t}
                className={`absolute inset-y-0 w-px ${
                  tick.major
                    ? "bg-zinc-300/70 dark:bg-zinc-600/50"
                    : "bg-zinc-200/60 dark:bg-zinc-700/40"
                }`}
                style={{ left: `${pct(tick.t)}%` }}
              />
            ))}
            {nowVisible ? (
              <div className="absolute inset-y-0 w-px bg-red-500/70" style={{ left: `${pct(now)}%` }} />
            ) : null}
          </div>

          {/* Lanes */}
          {rooms.map((room) => {
            const isCollapsed = collapsed.has(room.id);
            return (
              <div key={room.id}>
                {isCollapsed ? (
                  // Collapsed: keep the overview on a single track.
                  <div className={`relative ${ROOM_H}`}>
                    {room.assignments.map((a) => (
                      <AssignmentBar
                        key={a.id}
                        a={a}
                        pct={pct}
                        now={now}
                        compact
                        onClick={() => onOpenAssignment(room.id, a.id)}
                      />
                    ))}
                  </div>
                ) : (
                  <>
                    <div className={ROOM_H} />
                    {room.assignments.map((a) => (
                      <div key={a.id} className={`relative ${LANE_H}`}>
                        <AssignmentBar
                          a={a}
                          pct={pct}
                          now={now}
                          onClick={() => onOpenAssignment(room.id, a.id)}
                        />
                      </div>
                    ))}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-zinc-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-accent ring-2 ring-accent/30" /> in
          progress
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-accent" /> published
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm border border-dashed border-zinc-400" />{" "}
          draft
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-zinc-300 dark:bg-zinc-700" /> past or
          locked
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-px bg-red-500/70" /> now
        </span>
      </div>
    </Card>
  );
}

type Assignment = ClassroomSummary["assignments"][number];

function isOngoing(a: Assignment, now: number): boolean {
  const s = new Date(a.startAt).getTime();
  const d = new Date(a.deadlineAt).getTime();
  return a.state === "published" && s <= now && now <= d;
}

function StateDot({
  state,
  deadlineAt,
  now,
}: {
  state: Assignment["state"];
  deadlineAt: string;
  now: number;
}) {
  const past = new Date(deadlineAt).getTime() < now;
  const cls =
    state === "draft"
      ? "border border-dashed border-zinc-400"
      : state === "locked" || past
        ? "bg-zinc-300 dark:bg-zinc-600"
        : "bg-accent";
  return <span className={`inline-block size-2 shrink-0 rounded-full ${cls}`} />;
}

function AssignmentBar({
  a,
  pct,
  now,
  onClick,
  compact,
}: {
  a: Assignment;
  pct: (t: number) => number;
  now: number;
  onClick: () => void;
  compact?: boolean;
}) {
  const s = new Date(a.startAt).getTime();
  const d = new Date(a.deadlineAt).getTime();
  const l = pct(s);
  const r = pct(d);
  if (r <= 0 || l >= 100) return null; // fully outside the window

  const left = Math.max(l, 0);
  const width = Math.max(Math.min(r, 100) - left, 1.2);
  const past = d < now;
  const ongoing = isOngoing(a, now);

  return (
    <button
      onClick={onClick}
      title={`${a.name} — ${a.startAt.slice(0, 10)} → ${a.deadlineAt.slice(0, 10)} (${a.state})`}
      className={`absolute ${compact ? "top-1 h-6 leading-6" : "top-1.5 h-6 leading-6"} truncate rounded-md px-2 text-left text-xs font-medium transition-all hover:-translate-y-px hover:shadow-md ${
        a.state === "draft"
          ? "border border-dashed border-zinc-400 bg-white/60 text-zinc-500 dark:border-zinc-500 dark:bg-zinc-900/40 dark:text-zinc-400"
          : a.state === "locked" || past
            ? "bg-zinc-300 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
            : ongoing
              ? "bg-accent text-white ring-2 ring-accent/30"
              : "bg-accent text-white"
      }`}
      style={{ left: `${left}%`, width: `${width}%` }}
    >
      {a.name}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  icon: Icon,
}: {
  label: string;
  onClick: () => void;
  icon: typeof Crosshair;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-md p-1.5 hover:bg-zinc-100 hover:text-accent dark:hover:bg-zinc-800"
    >
      <Icon className="size-4" />
    </button>
  );
}
