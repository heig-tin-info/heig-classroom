import { CalendarRange } from "lucide-react";

import type { ClassroomSummary } from "./api";
import { Card, EmptyState, OrgAvatar } from "./ui";

/**
 * Assignment occupancy timeline (Gantt-like): one row per classroom, one bar
 * per assignment from start to deadline, month gridlines and a "now" marker.
 * Hand-rolled with CSS: the gantt libraries around either drag their own
 * theme (frappe-gantt, vis-timeline) or are unmaintained; this stays exactly
 * on the design system and costs no bundle weight.
 */
const DAY = 86_400_000;

function monthTicks(from: Date, to: Date): Date[] {
  const ticks: Date[] = [];
  const d = new Date(from.getFullYear(), from.getMonth(), 1);
  while (d <= to) {
    if (d >= from) ticks.push(new Date(d));
    d.setMonth(d.getMonth() + 1);
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

  // Window: a week of margin around the assignments, bounded to 3 months in
  // the past so an old classroom does not crush the scale.
  const now = Date.now();
  const minStart = Math.min(...all.map((a) => new Date(a.startAt).getTime()));
  const maxEnd = Math.max(...all.map((a) => new Date(a.deadlineAt).getTime()), now);
  const from = new Date(Math.max(minStart - 7 * DAY, now - 90 * DAY));
  const to = new Date(maxEnd + 7 * DAY);
  const span = to.getTime() - from.getTime();
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - from.getTime()) / span) * 100));
  const ticks = monthTicks(from, to);
  const nowVisible = now >= from.getTime() && now <= to.getTime();

  return (
    <Card className="p-4">
      <div className="flex gap-2">
        {/* Classroom labels */}
        <div className="w-40 shrink-0">
          <div className="h-6" />
          {rooms.map((room) => (
            <div key={room.id} className="flex h-10 items-center gap-1.5 truncate pr-1 text-sm font-medium">
              <OrgAvatar login={room.orgLogin} className="size-4" />
              <span className="truncate" title={room.name}>
                {room.name}
              </span>
            </div>
          ))}
        </div>

        {/* Tracks */}
        <div className="relative min-w-0 flex-1">
          <div className="relative h-6 text-[10px] uppercase tracking-wide text-zinc-400">
            {ticks.map((tick) => (
              <span
                key={tick.toISOString()}
                className="absolute top-1 -translate-x-1/2 whitespace-nowrap"
                style={{ left: `${pct(tick.getTime())}%` }}
              >
                {tick.toLocaleDateString("en-CA", { month: "short", year: "2-digit" })}
              </span>
            ))}
          </div>
          {rooms.map((room) => (
            <div key={room.id} className="flex h-10 items-center">
              <div className="relative h-8 w-full rounded-md bg-zinc-50 dark:bg-zinc-800/40">
                {ticks.map((tick) => (
                  <span
                    key={tick.toISOString()}
                    className="absolute inset-y-0 w-px bg-zinc-200/70 dark:bg-zinc-700/50"
                    style={{ left: `${pct(tick.getTime())}%` }}
                  />
                ))}
                {room.assignments.map((a) => {
                  const left = pct(new Date(a.startAt).getTime());
                  const width = Math.max(pct(new Date(a.deadlineAt).getTime()) - left, 1.5);
                  const past = new Date(a.deadlineAt).getTime() < now;
                  return (
                    <button
                      key={a.id}
                      onClick={() => onOpenAssignment(room.id, a.id)}
                      title={`${a.name} — ${a.startAt.slice(0, 10)} → ${a.deadlineAt.slice(0, 10)} (${a.state})`}
                      className={`absolute top-1 h-6 truncate rounded-md px-2 text-left text-xs font-medium leading-6 transition-all hover:-translate-y-px hover:shadow-md ${
                        a.state === "draft"
                          ? "border border-dashed border-zinc-400 bg-white/60 text-zinc-500 dark:border-zinc-500 dark:bg-zinc-900/40 dark:text-zinc-400"
                          : a.state === "locked" || past
                            ? "bg-zinc-300 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
                            : "bg-accent text-white"
                      }`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                    >
                      {a.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {nowVisible ? (
            <div
              className="pointer-events-none absolute bottom-0 top-6 w-px bg-red-500/70"
              style={{ left: `${pct(now)}%` }}
              title="Now"
            />
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-4 text-xs text-zinc-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-accent" /> published
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm border border-dashed border-zinc-400" />{" "}
          draft
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-zinc-300 dark:bg-zinc-700" /> past
          or locked
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-px bg-red-500/70" /> now
        </span>
      </div>
    </Card>
  );
}
