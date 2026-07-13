import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ClipboardList,
  Loader2,
  School,
  ShieldCheck,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useMemo, useState } from "react";

import { api, ApiError, apiErrorMessage } from "./api";
import { ScheduledTasksCard } from "./ScheduledTasks";
import { Badge, Button, Card, EmptyState, Field, isoDateTime } from "./ui";

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
}

type SortKey = "email" | "name" | "lastLoginAt" | "classrooms" | "assignments";

const cell = "px-3 py-2";

export function AdminPanel() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("email");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

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

  const rows = useMemo(() => {
    const data = [...(teachers.data ?? [])];
    const val = (r: TeacherRow) => {
      switch (sortKey) {
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
    data.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y))) * sortDir;
    });
    return data;
  }, [teachers.data, sortKey, sortDir]);

  const grantError =
    grant.isError && grant.error instanceof ApiError
      ? apiErrorMessage(grant.error, "Request failed")
      : null;

  function SortHeader({ k, children }: { k: SortKey; children: React.ReactNode }) {
    const active = sortKey === k;
    return (
      <th className={`${cell} font-medium`}>
        <button
          className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-zinc-900 dark:hover:text-zinc-100"
          onClick={() => {
            if (active) setSortDir((d) => (d === 1 ? -1 : 1));
            else {
              setSortKey(k);
              setSortDir(1);
            }
          }}
        >
          {children}
          {active ? (
            sortDir === 1 ? (
              <ArrowUp className="size-3" />
            ) : (
              <ArrowDown className="size-3" />
            )
          ) : null}
        </button>
      </th>
    );
  }

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
                  <SortHeader k="email">E-mail</SortHeader>
                  <SortHeader k="name">Name</SortHeader>
                  <SortHeader k="lastLoginAt">Last sign-in</SortHeader>
                  <SortHeader k="classrooms">Classrooms</SortHeader>
                  <SortHeader k="assignments">Assignments</SortHeader>
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
                    <td className={`${cell} text-right`}>
                      <button
                        aria-label="Revoke teacher role"
                        title="Revoke teacher role"
                        onClick={() => {
                          const warning =
                            r.classrooms > 0
                              ? `Revoke ${r.email}? They own ${r.classrooms} classroom(s); the data stays but they lose access at once.`
                              : `Revoke ${r.email}?`;
                          if (window.confirm(warning)) revoke.mutate(r.id);
                        }}
                        disabled={revoke.isPending}
                        className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                      >
                        <Trash2 className="size-4" />
                      </button>
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
