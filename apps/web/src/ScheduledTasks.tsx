import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pause, Play, TimerReset, Zap } from "lucide-react";
import { useState } from "react";

import { api } from "./api";
import { HelpIcon } from "./help";
import { Badge, Card, IconButton, isoDateTime, Tip } from "./ui";

interface TaskRow {
  key: string;
  description: string;
  webhookWoken: boolean;
  enabled: boolean;
  intervalMinutes: number;
  defaultIntervalMinutes: number;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | "running" | null;
  lastError: string | null;
  lastDurationMs: number | null;
}

const cell = "px-3 py-2";

function formatInterval(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

function StatusBadge({ t }: { t: TaskRow }) {
  if (!t.lastStatus) return <Badge tone="zinc">never ran</Badge>;
  if (t.lastStatus === "running") return <Badge tone="amber">running</Badge>;
  if (t.lastStatus === "error") return <Badge tone="red">error</Badge>;
  return <Badge tone="green">ok</Badge>;
}

function IntervalEditor({
  task,
  onSave,
  saving,
}: {
  task: TaskRow;
  onSave: (minutes: number) => void;
  saving: boolean;
}) {
  const [value, setValue] = useState(String(task.intervalMinutes));
  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && parsed >= 5 && parsed <= 7 * 24 * 60;
  const dirty = valid && parsed !== task.intervalMinutes;
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        type="number"
        min={5}
        max={7 * 24 * 60}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && dirty) onSave(parsed);
        }}
        className="w-20 rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm tabular-nums focus:border-accent focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
        aria-label="Interval in minutes"
        disabled={saving}
      />
      <span className="text-xs text-zinc-400">min</span>
      {dirty ? (
        <button
          onClick={() => onSave(parsed)}
          disabled={saving}
          className="rounded-md px-1.5 py-0.5 text-xs font-medium text-accent hover:bg-accent/10"
        >
          {saving ? <Loader2 className="size-3 animate-spin" /> : "Save"}
        </button>
      ) : (
        <span className="text-xs text-zinc-400">({formatInterval(task.intervalMinutes)})</span>
      )}
    </span>
  );
}

export function ScheduledTasksCard() {
  const qc = useQueryClient();
  const tasks = useQuery<TaskRow[]>({
    queryKey: ["admin-tasks"],
    queryFn: () => api("/app/api/admin/tasks"),
    refetchInterval: 15_000,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin-tasks"] });

  const patch = useMutation({
    mutationFn: ({ key, body }: { key: string; body: object }) =>
      api(`/app/api/admin/tasks/${key}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });
  const runNow = useMutation({
    mutationFn: (key: string) => api(`/app/api/admin/tasks/${key}/run`, { method: "POST" }),
    onSuccess: invalidate,
  });

  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <TimerReset className="size-4 text-zinc-400" />
        <h2 className="font-medium">Scheduled tasks</h2>
        <HelpIcon topic="scheduled-tasks" />
        <span className="text-xs text-zinc-400">
          Safety-net reconciliation. Webhook events are processed immediately, without waiting
          for these schedules.
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              <th className={`${cell} font-medium`}>Task</th>
              <th className={`${cell} font-medium`}>Every</th>
              <th className={`${cell} font-medium`}>Last run</th>
              <th className={`${cell} font-medium`}>Status</th>
              <th className={cell} aria-label="Actions" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {(tasks.data ?? []).map((t) => (
              <tr
                key={t.key}
                className={`hover:bg-zinc-50 dark:hover:bg-zinc-800/50 ${t.enabled ? "" : "opacity-50"}`}
              >
                <td className={`${cell} max-w-md`}>
                  <div className="flex items-center gap-2 font-mono text-xs font-medium">
                    {t.key}
                    {t.webhookWoken ? (
                      <Tip label="Webhooks also trigger this work immediately; the schedule is only the fallback.">
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-sans text-zinc-400">
                          <Zap className="size-3" /> webhook-woken
                        </span>
                      </Tip>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{t.description}</p>
                </td>
                <td className={cell}>
                  <IntervalEditor
                    task={t}
                    saving={patch.isPending}
                    onSave={(minutes) =>
                      patch.mutate({ key: t.key, body: { intervalMinutes: minutes } })
                    }
                  />
                </td>
                <td className={`${cell} whitespace-nowrap text-zinc-500 dark:text-zinc-400`}>
                  {t.lastRunAt ? isoDateTime(t.lastRunAt) : "—"}
                  {t.lastDurationMs !== null && t.lastStatus !== "running" ? (
                    <span className="ml-1 text-xs text-zinc-400">
                      ({(t.lastDurationMs / 1000).toFixed(1)} s)
                    </span>
                  ) : null}
                </td>
                <td className={cell}>
                  <StatusBadge t={t} />
                  {t.lastError ? (
                    <Tip label={t.lastError} className="block">
                      <p
                        className={`mt-0.5 max-w-xs truncate text-xs ${
                          t.lastStatus === "error"
                            ? "text-red-600 dark:text-red-400"
                            : "text-zinc-400"
                        }`}
                      >
                        {t.lastError}
                      </p>
                    </Tip>
                  ) : null}
                </td>
                <td className={`${cell} whitespace-nowrap text-right`}>
                  <IconButton
                    label={t.enabled ? "Disable task" : "Enable task"}
                    onClick={() => patch.mutate({ key: t.key, body: { enabled: !t.enabled } })}
                    disabled={patch.isPending}
                  >
                    {t.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
                  </IconButton>
                  <Tip label="Run now">
                    <button
                      aria-label="Run now"
                      onClick={() => runNow.mutate(t.key)}
                      disabled={runNow.isPending || t.lastStatus === "running"}
                      className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-accent/10 hover:text-accent disabled:pointer-events-none disabled:opacity-40"
                    >
                      {runNow.isPending && runNow.variables === t.key ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Zap className="size-4" />
                      )}
                    </button>
                  </Tip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
