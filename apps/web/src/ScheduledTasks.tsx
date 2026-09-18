import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Pause, Play, RefreshCw, TimerReset, Zap } from "lucide-react";
import { Fragment, useState } from "react";

import { api, apiErrorMessage } from "./api";
import {
  Alert,
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  IconButton,
  inputClass,
  isoDateTime,
  SectionHeading,
  Skeleton,
  T,
  Tip,
} from "./ui";

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
    <span className="inline-flex items-center gap-2">
      {/* The width lives on the wrapper: `inputClass` carries `w-full`, and a
          `w-20` next to it is not guaranteed to win the cascade. */}
      <span className="inline-block w-20 shrink-0">
        <input
          type="number"
          min={5}
          max={7 * 24 * 60}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty) onSave(parsed);
          }}
          className={cx(inputClass, "tabular-nums")}
          aria-label="Interval in minutes"
          disabled={saving}
        />
      </span>
      <span className="text-xs text-fg-faint">min</span>
      {dirty ? (
        <Button size="sm" variant="secondary" onClick={() => onSave(parsed)} loading={saving}>
          Save
        </Button>
      ) : (
        <span className="text-xs text-fg-faint">({formatInterval(task.intervalMinutes)})</span>
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

  /** Failure of the last edit or manual run, under the row it came from. */
  const rowError = (key: string): string | null => {
    if (patch.isError && patch.variables?.key === key) {
      return apiErrorMessage(patch.error, "Could not save this schedule.");
    }
    if (runNow.isError && runNow.variables === key) {
      return apiErrorMessage(runNow.error, "Could not start this task.");
    }
    return null;
  };

  return (
    <section className="space-y-3">
      <SectionHeading
        icon={TimerReset}
        title="Scheduled tasks"
        help="scheduled-tasks"
        description="Safety-net reconciliation. Webhook events are processed immediately, without waiting for these schedules."
      />
      <Card className="overflow-hidden">
        {tasks.isLoading ? (
          <div className="space-y-3 p-5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : tasks.isError ? (
          <div className="p-4">
            <Alert
              tone="danger"
              icon={AlertTriangle}
              title="Could not load the scheduled tasks"
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void tasks.refetch()}
                  loading={tasks.isFetching}
                >
                  <RefreshCw /> Retry
                </Button>
              }
            >
              {apiErrorMessage(tasks.error, "The server did not answer.")}
            </Alert>
          </div>
        ) : (tasks.data ?? []).length === 0 ? (
          <EmptyState icon={TimerReset} title="No scheduled task">
            This instance runs no background reconciliation; webhook events are all there is.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className={cx(T.table, "min-w-200")}>
              <thead>
                <tr className={T.head}>
                  <th className={T.th}>Task</th>
                  <th className={T.th}>Every</th>
                  <th className={T.th}>Last run</th>
                  <th className={T.th}>Status</th>
                  <th className={T.th} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {(tasks.data ?? []).map((t) => (
                  <Fragment key={t.key}>
                    <tr className={cx(T.row, T.rowHover, !t.enabled && "opacity-50")}>
                      <td className={`${T.td} max-w-md`}>
                        <div className="flex items-center gap-2 font-mono text-xs font-medium">
                          {t.key}
                          {t.webhookWoken ? (
                            <Tip label="Webhooks also trigger this work immediately; the schedule is only the fallback.">
                              <span className="inline-flex items-center gap-0.5 font-sans text-[10px] text-fg-faint">
                                <Zap className="size-3" /> webhook-woken
                              </span>
                            </Tip>
                          ) : null}
                        </div>
                        <p className="mt-0.5 text-xs text-fg-muted">{t.description}</p>
                      </td>
                      <td className={T.td}>
                        <IntervalEditor
                          task={t}
                          saving={patch.isPending}
                          onSave={(minutes) =>
                            patch.mutate({ key: t.key, body: { intervalMinutes: minutes } })
                          }
                        />
                      </td>
                      <td className={`${T.td} whitespace-nowrap text-fg-muted`}>
                        {t.lastRunAt ? isoDateTime(t.lastRunAt) : "—"}
                        {t.lastDurationMs !== null && t.lastStatus !== "running" ? (
                          <span className="ml-1 text-xs text-fg-faint">
                            ({(t.lastDurationMs / 1000).toFixed(1)} s)
                          </span>
                        ) : null}
                      </td>
                      <td className={T.td}>
                        <StatusBadge t={t} />
                        {t.lastError ? (
                          <Tip label={t.lastError} className="block">
                            <p
                              className={cx(
                                "mt-0.5 max-w-xs truncate text-xs",
                                t.lastStatus === "error" ? "text-danger" : "text-fg-faint",
                              )}
                            >
                              {t.lastError}
                            </p>
                          </Tip>
                        ) : null}
                      </td>
                      <td className={`${T.td} whitespace-nowrap text-right`}>
                        <IconButton
                          label={t.enabled ? "Disable task" : "Enable task"}
                          onClick={() => patch.mutate({ key: t.key, body: { enabled: !t.enabled } })}
                          disabled={patch.isPending}
                        >
                          {t.enabled ? <Pause /> : <Play />}
                        </IconButton>
                        <IconButton
                          label="Run now"
                          onClick={() => runNow.mutate(t.key)}
                          disabled={runNow.isPending || t.lastStatus === "running"}
                        >
                          {runNow.isPending && runNow.variables === t.key ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <Zap />
                          )}
                        </IconButton>
                      </td>
                    </tr>
                    {rowError(t.key) ? (
                      <tr>
                        <td colSpan={5} className="px-3 pb-2 text-[13px] text-danger">
                          {rowError(t.key)}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </section>
  );
}
