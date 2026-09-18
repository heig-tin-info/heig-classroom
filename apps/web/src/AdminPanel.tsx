import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ClipboardList, MonitorPlay, RefreshCw, School, Trash2, UserPlus } from "lucide-react";
import { Fragment, useEffect, useState } from "react";

import type { TeacherCodespaceGrant } from "@hgc/contracts";

import { api, ApiError, apiErrorMessage } from "./api";
import { useConfirm } from "./confirm";
import { ScheduledTasksCard } from "./ScheduledTasks";
import {
  Alert,
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  IconButton,
  inputClass,
  isoDateTime,
  PageHeader,
  SectionHeading,
  Skeleton,
  SortHeader,
  Switch,
  T,
  useSortableTable,
} from "./ui";

interface TeacherRow {
  id: string;
  email: string;
  grantedAt: string;
  givenName: string | null;
  familyName: string | null;
  lastLoginAt: string | null;
  signedUp: boolean;
  classrooms: number;
  assignments: number;
  /** Online workspace grant (ADR-013); null = no portal on this instance. */
  codespace: TeacherCodespaceGrant | null;
}

/**
 * Online workspace switch + session quota of one teacher (ADR-013). The
 * switch writes immediately; the quota writes on Enter or on the Save that
 * appears once the number changed — same shape as the task intervals.
 */
function CodespaceCell({
  row,
  onSave,
  saving,
}: {
  row: TeacherRow;
  onSave: (codespace: Partial<TeacherCodespaceGrant>) => void;
  saving: boolean;
}) {
  const grant = row.codespace!;
  const [quota, setQuota] = useState(String(grant.maxActiveSessions));
  useEffect(() => {
    setQuota(String(grant.maxActiveSessions));
  }, [grant.maxActiveSessions]);
  const parsed = Number(quota);
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 100;
  const dirty = valid && parsed !== grant.maxActiveSessions;
  return (
    <span className="inline-flex items-center gap-2.5">
      <Switch
        checked={grant.enabled}
        disabled={saving}
        onChange={(v) => onSave({ enabled: v })}
        label={`Online workspace for ${row.email}`}
      />
      {/* The width lives on the wrapper: `inputClass` carries `w-full`, and a
          `w-16` next to it is not guaranteed to win the cascade. */}
      <span className="inline-block w-16 shrink-0">
        <input
          type="number"
          min={0}
          max={100}
          value={quota}
          onChange={(e) => setQuota(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty) onSave({ maxActiveSessions: parsed });
          }}
          className={cx(inputClass, "px-1 text-center tabular-nums")}
          aria-label={`Concurrent sessions allowed for ${row.email}`}
          disabled={saving || !grant.enabled}
        />
      </span>
      {dirty ? (
        <Button size="sm" variant="secondary" onClick={() => onSave({ maxActiveSessions: parsed })} loading={saving}>
          Save
        </Button>
      ) : (
        <span className="text-xs text-fg-faint">sessions</span>
      )}
    </span>
  );
}

type SortKey = "email" | "name" | "lastLoginAt" | "classrooms" | "assignments";

export function AdminPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [email, setEmail] = useState("");

  const teachers = useQuery<TeacherRow[]>({
    queryKey: ["admin-teachers"],
    queryFn: () => api("/app/api/admin/teachers"),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin-teachers"] });
  const grant = useMutation({
    mutationFn: () =>
      api("/app/api/admin/teachers", { method: "POST", body: JSON.stringify({ email }) }),
    onSuccess: () => {
      setEmail("");
      invalidate();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/app/api/admin/teachers/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
  // ADR-013: the column only exists when a portal is configured — the rows
  // then carry a grant, otherwise `codespace` is null everywhere.
  const setCodespace = useMutation({
    mutationFn: ({ id, codespace }: { id: string; codespace: Partial<TeacherCodespaceGrant> }) =>
      api(`/app/api/admin/teachers/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ codespace }),
      }),
    onSuccess: invalidate,
  });
  const showCodespace = (teachers.data ?? []).some((r) => r.codespace !== null);

  const rank = (r: TeacherRow, key: SortKey): string | number => {
    switch (key) {
      case "email":
        return r.email;
      case "name":
        return `${r.familyName ?? ""} ${r.givenName ?? ""}`.trim();
      case "lastLoginAt":
        return r.lastLoginAt ?? "";
      case "classrooms":
        return r.classrooms;
      case "assignments":
        return r.assignments;
    }
  };
  const { sorted: rows, sort, toggle } = useSortableTable(
    teachers.data ?? [],
    rank,
    { key: "email", dir: 1 },
  );

  const grantError =
    grant.isError && grant.error instanceof ApiError
      ? apiErrorMessage(grant.error, "Request failed")
      : null;

  /** Failure of the last revoke or grant change, under the row it came from. */
  const rowError = (id: string): string | null => {
    if (revoke.isError && revoke.variables === id) {
      return apiErrorMessage(revoke.error, "Could not revoke this teacher.");
    }
    if (setCodespace.isError && setCodespace.variables?.id === id) {
      return apiErrorMessage(setCodespace.error, "Could not save the online workspace grant.");
    }
    return null;
  };

  const Th = ({ k, children, right }: { k: SortKey; children: React.ReactNode; right?: boolean }) => (
    <SortHeader k={k} sort={sort} onToggle={toggle} right={right}>
      {children}
    </SortHeader>
  );

  return (
    <div className="space-y-8">
      <PageHeader title="Administration" description="Who may teach on this instance, and the background tasks that keep it in sync." />

      <section className="space-y-3">
        <SectionHeading
          icon={School}
          title="Teachers"
          count={teachers.data?.length}
          description="The account activates on first sign-in with Switch edu-ID; name and profile fill in then."
        />
        <Card className="overflow-hidden">
          <form
            className="flex flex-wrap items-end gap-3 border-b border-line bg-surface-2/50 px-5 py-4"
            onSubmit={(e) => {
              e.preventDefault();
              grant.mutate();
            }}
          >
            <div className="min-w-64 flex-1">
              <Field
                label="Grant the teacher role to"
                type="email"
                placeholder="ada.lovelace@heig-vd.ch"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                fullWidth
                required
              />
            </div>
            <Button type="submit" loading={grant.isPending} disabled={email.trim() === ""}>
              <UserPlus /> Add teacher
            </Button>
            {grantError ? <span className="w-full text-sm text-danger">{grantError}</span> : null}
          </form>
          {teachers.isLoading ? (
            <div className="space-y-3 p-5">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-4 w-full" />
              ))}
            </div>
          ) : teachers.isError ? (
            <div className="p-4">
              <Alert
                tone="danger"
                icon={AlertTriangle}
                title="Could not load the teachers"
                action={
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void teachers.refetch()}
                    loading={teachers.isFetching}
                  >
                    <RefreshCw /> Retry
                  </Button>
                }
              >
                {apiErrorMessage(teachers.error, "The server did not answer.")}
              </Alert>
            </div>
          ) : rows.length === 0 ? (
            <EmptyState icon={School} title="No teachers yet">
              Grant the teacher role by e-mail above.
            </EmptyState>
          ) : (
            /* Seven columns never fit a phone: the table scrolls, not the page. */
            <div className="overflow-x-auto">
              <table className={cx(T.table, "min-w-220")}>
                <thead>
                  <tr className={T.head}>
                    <Th k="email">E-mail</Th>
                    <Th k="name">Name</Th>
                    <Th k="lastLoginAt">Last sign-in</Th>
                    <Th k="classrooms" right>
                      Classrooms
                    </Th>
                    <Th k="assignments" right>
                      Assignments
                    </Th>
                    {showCodespace ? (
                      <th className={T.th}>
                        <span className="inline-flex items-center gap-1">
                          <MonitorPlay className="size-3.5 text-fg-faint" /> Online workspace
                        </span>
                      </th>
                    ) : null}
                    <th className={T.th} aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Fragment key={r.id}>
                      <tr className={cx(T.row, T.rowHover)}>
                        <td className={`${T.td} font-semibold`}>{r.email}</td>
                        <td className={T.td}>
                          {r.signedUp ? (
                            `${r.givenName ?? ""} ${r.familyName ?? ""}`.trim() || "—"
                          ) : (
                            <Badge tone="amber">not signed in yet</Badge>
                          )}
                        </td>
                        <td className={`${T.td} whitespace-nowrap text-fg-muted`}>
                          {r.lastLoginAt ? isoDateTime(r.lastLoginAt) : "—"}
                        </td>
                        <td className={`${T.td} text-right tabular-nums`}>{r.classrooms}</td>
                        <td className={`${T.td} text-right tabular-nums`}>
                          <span className="inline-flex items-center gap-1">
                            <ClipboardList className="size-3.5 text-fg-faint" /> {r.assignments}
                          </span>
                        </td>
                        {showCodespace ? (
                          <td className={T.td}>
                            {r.codespace ? (
                              <CodespaceCell
                                row={r}
                                saving={setCodespace.isPending}
                                onSave={(codespace) => setCodespace.mutate({ id: r.id, codespace })}
                              />
                            ) : null}
                          </td>
                        ) : null}
                        <td className={`${T.td} text-right`}>
                          <IconButton
                            danger
                            label="Revoke teacher role"
                            disabled={revoke.isPending}
                            onClick={async () => {
                              if (
                                await confirm({
                                  title: `Revoke ${r.email}?`,
                                  message:
                                    r.classrooms > 0
                                      ? `They own ${r.classrooms} classroom(s); the data stays but they lose access at once.`
                                      : "They lose access at once.",
                                  confirmLabel: "Revoke",
                                  danger: true,
                                })
                              ) {
                                revoke.mutate(r.id);
                              }
                            }}
                          >
                            <Trash2 />
                          </IconButton>
                        </td>
                      </tr>
                      {rowError(r.id) ? (
                        <tr>
                          <td colSpan={showCodespace ? 7 : 6} className="px-3 pb-2 text-[13px] text-danger">
                            {rowError(r.id)}
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

      <ScheduledTasksCard />
    </div>
  );
}
