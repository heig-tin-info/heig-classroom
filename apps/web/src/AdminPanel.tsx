import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ClipboardList,
  Loader2,
  MonitorPlay,
  School,
  ShieldCheck,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { TeacherCodespaceGrant } from "@hgc/contracts";

import { api, ApiError, apiErrorMessage } from "./api";
import { ScheduledTasksCard } from "./ScheduledTasks";
import { Badge, Button, Card, EmptyState, Field, IconButton, isoDateTime, SortHeader, useSortableTable } from "./ui";

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
    <span className="inline-flex items-center gap-2">
      <label className="inline-flex cursor-pointer items-center gap-1.5">
        <input
          type="checkbox"
          className="accent-accent"
          checked={grant.enabled}
          disabled={saving}
          onChange={(e) => onSave({ enabled: e.target.checked })}
          aria-label={`Online workspace for ${row.email}`}
        />
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {grant.enabled ? "enabled" : "off"}
        </span>
      </label>
      <input
        type="number"
        min={0}
        max={100}
        value={quota}
        onChange={(e) => setQuota(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && dirty) onSave({ maxActiveSessions: parsed });
        }}
        className="w-16 rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm tabular-nums focus:border-accent focus:outline-none disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
        aria-label={`Concurrent sessions allowed for ${row.email}`}
        disabled={saving || !grant.enabled}
      />
      {dirty ? (
        <button
          type="button"
          onClick={() => onSave({ maxActiveSessions: parsed })}
          disabled={saving}
          className="rounded-md px-1.5 py-0.5 text-xs font-medium text-accent hover:bg-accent/10"
        >
          {saving ? <Loader2 className="size-3 animate-spin" /> : "Save"}
        </button>
      ) : (
        <span className="text-xs text-zinc-400">sessions</span>
      )}
    </span>
  );
}

type SortKey = "email" | "name" | "lastLoginAt" | "classrooms" | "assignments";

const cell = "px-3 py-2";

export function AdminPanel() {
  const qc = useQueryClient();
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

  const Th = ({ k, children }: { k: SortKey; children: React.ReactNode }) => (
    <SortHeader k={k} sort={sort} onToggle={toggle} className={`${cell} font-medium`}>
      {children}
    </SortHeader>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-6 text-accent" />
        <h1 className="text-2xl font-semibold tracking-tight">Administration</h1>
      </div>

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <UserPlus className="size-4 text-zinc-400" />
          <h2 className="font-medium">Add a teacher</h2>
          <span className="text-xs text-zinc-400">
            Name and profile are filled automatically on their first sign-in.
          </span>
        </div>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            grant.mutate();
          }}
        >
          <Field
            label="E-mail"
            type="email"
            placeholder="ada.lovelace@heig-vd.ch"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Button disabled={grant.isPending || email.trim() === ""}>
            {grant.isPending ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
            Grant teacher role
          </Button>
          {grantError ? (
            <span className="text-sm text-red-600 dark:text-red-400">{grantError}</span>
          ) : null}
        </form>
      </Card>

      <Card>
        {rows.length === 0 && !teachers.isLoading ? (
          <EmptyState icon={School} title="No teachers yet">
            Grant the teacher role by e-mail above; the account activates on first
            sign-in with Switch edu-ID.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500 dark:text-zinc-400">
                  <Th k="email">E-mail</Th>
                  <Th k="name">Name</Th>
                  <Th k="lastLoginAt">Last sign-in</Th>
                  <Th k="classrooms">Classrooms</Th>
                  <Th k="assignments">Assignments</Th>
                  {showCodespace ? (
                    <th className={`${cell} font-medium`}>
                      <span className="inline-flex items-center gap-1">
                        <MonitorPlay className="size-3.5 text-zinc-400" /> Online workspace
                      </span>
                    </th>
                  ) : null}
                  <th className={cell} aria-label="Actions" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                    <td className={`${cell} font-medium`}>{r.email}</td>
                    <td className={cell}>
                      {r.signedUp ? (
                        `${r.givenName ?? ""} ${r.familyName ?? ""}`.trim() || "—"
                      ) : (
                        <Badge tone="amber">not signed in yet</Badge>
                      )}
                    </td>
                    <td className={`${cell} text-zinc-500 dark:text-zinc-400`}>
                      {r.lastLoginAt ? isoDateTime(r.lastLoginAt) : "—"}
                    </td>
                    <td className={cell}>
                      <span className="inline-flex items-center gap-1">
                        <School className="size-3.5 text-zinc-400" /> {r.classrooms}
                      </span>
                    </td>
                    <td className={cell}>
                      <span className="inline-flex items-center gap-1">
                        <ClipboardList className="size-3.5 text-zinc-400" /> {r.assignments}
                      </span>
                    </td>
                    {showCodespace ? (
                      <td className={cell}>
                        {r.codespace ? (
                          <CodespaceCell
                            row={r}
                            saving={setCodespace.isPending}
                            onSave={(codespace) => setCodespace.mutate({ id: r.id, codespace })}
                          />
                        ) : null}
                      </td>
                    ) : null}
                    <td className={`${cell} text-right`}>
                      <IconButton
                        danger
                        label="Revoke teacher role"
                        onClick={() => {
                          const warning =
                            r.classrooms > 0
                              ? `Revoke ${r.email}? They own ${r.classrooms} classroom(s); the data stays but they lose access at once.`
                              : `Revoke ${r.email}?`;
                          if (window.confirm(warning)) revoke.mutate(r.id);
                        }}
                        disabled={revoke.isPending}
                      >
                        <Trash2 className="size-4" />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ScheduledTasksCard />
    </div>
  );
}
