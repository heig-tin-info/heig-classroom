import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Pencil,
  Trash2,
  UserRoundX,
  Users,
  X,
} from "lucide-react";
import { useState } from "react";

import { api, ApiError, type RosterEntry } from "./api";
import { Badge, EmptyState, GithubIcon, isoDateTime } from "./ui";

function IconButton({
  label,
  danger,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; danger?: boolean }) {
  return (
    <button
      {...props}
      aria-label={label}
      title={label}
      className={`rounded-md p-1.5 transition-colors ${
        danger
          ? "text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
          : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      }`}
    />
  );
}

const cell = "px-3 py-2";
const input =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30 dark:border-zinc-700 dark:bg-zinc-950";

function Row({ classroomId, entry }: { classroomId: string; entry: RosterEntry }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ nom: entry.nom, prenom: entry.prenom, email: entry.email });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["classroom", classroomId] });
  const base = `/app/api/classrooms/${classroomId}/roster/${entry.id}`;

  const save = useMutation({
    mutationFn: () => api(base, { method: "PATCH", body: JSON.stringify(form) }),
    onSuccess: () => {
      setEditing(false);
      invalidate();
    },
  });
  const unclaim = useMutation({
    mutationFn: () => api(`${base}/unclaim`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => api(base, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  if (editing) {
    const err =
      save.isError && save.error instanceof ApiError
        ? ((save.error.body as { message?: string })?.message ?? "Update failed")
        : null;
    return (
      <tr className="bg-zinc-50 dark:bg-zinc-800/50">
        <td className={cell}>
          <input
            className={input}
            aria-label="Last name"
            value={form.nom}
            onChange={(e) => setForm({ ...form, nom: e.target.value })}
          />
        </td>
        <td className={cell}>
          <input
            className={input}
            aria-label="First name"
            value={form.prenom}
            onChange={(e) => setForm({ ...form, prenom: e.target.value })}
          />
        </td>
        <td className={cell} colSpan={3}>
          <input
            className={input}
            aria-label="E-mail"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          {err ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{err}</p> : null}
          {form.email !== entry.email && entry.status === "claimed" ? (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              Changing the e-mail will revoke the student's claim.
            </p>
          ) : null}
        </td>
        <td className={`${cell} text-right whitespace-nowrap`}>
          <IconButton label="Save" onClick={() => save.mutate()} disabled={save.isPending}>
            <Check className="size-4" />
          </IconButton>
          <IconButton
            label="Cancel"
            onClick={() => {
              setEditing(false);
              setForm({ nom: entry.nom, prenom: entry.prenom, email: entry.email });
            }}
          >
            <X className="size-4" />
          </IconButton>
        </td>
      </tr>
    );
  }

  return (
    <tr className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
      <td className={`${cell} font-medium`}>{entry.nom}</td>
      <td className={cell}>{entry.prenom}</td>
      <td className={`${cell} text-zinc-500 dark:text-zinc-400`}>{entry.email}</td>
      <td className={cell}>
        {entry.conflictFlag ? (
          <Badge tone="red" icon={AlertTriangle}>
            conflict
          </Badge>
        ) : entry.status === "claimed" ? (
          <Badge tone="green" icon={CheckCircle2}>
            claimed
          </Badge>
        ) : (
          <Badge tone="amber" icon={Clock}>
            pending
          </Badge>
        )}
      </td>
      <td className={cell}>
        {entry.githubLogin ? (
          <span className="inline-flex items-center gap-1">
            <GithubIcon className="size-3.5" /> {entry.githubLogin}
          </span>
        ) : (
          <span className="text-zinc-400">—</span>
        )}
      </td>
      <td className={`${cell} text-zinc-500 dark:text-zinc-400`}>
        {entry.lastLoginAt ? isoDateTime(entry.lastLoginAt) : "—"}
      </td>
      <td className={`${cell} text-right whitespace-nowrap`}>
        <IconButton label="Edit" onClick={() => setEditing(true)}>
          <Pencil className="size-4" />
        </IconButton>
        {entry.status === "claimed" || entry.conflictFlag ? (
          <IconButton
            label="Revoke claim"
            onClick={() => unclaim.mutate()}
            disabled={unclaim.isPending}
          >
            <UserRoundX className="size-4" />
          </IconButton>
        ) : null}
        <IconButton
          label="Remove student"
          danger
          onClick={() => {
            if (window.confirm(`Remove ${entry.prenom} ${entry.nom} from the roster?`)) {
              remove.mutate();
            }
          }}
          disabled={remove.isPending}
        >
          <Trash2 className="size-4" />
        </IconButton>
      </td>
    </tr>
  );
}

export function RosterTable({
  classroomId,
  roster,
}: {
  classroomId: string;
  roster: RosterEntry[];
}) {
  if (roster.length === 0) {
    return (
      <EmptyState icon={Users} title="Empty roster">
        Import the student list from a CSV or Excel file to get started.
      </EmptyState>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            <th className={`${cell} font-medium`}>Last name</th>
            <th className={`${cell} font-medium`}>First name</th>
            <th className={`${cell} font-medium`}>E-mail</th>
            <th className={`${cell} font-medium`}>Status</th>
            <th className={`${cell} font-medium`}>GitHub</th>
            <th className={`${cell} font-medium`}>Last sign-in</th>
            <th className={cell} aria-label="Actions" />
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {roster.map((r) => (
            <Row key={r.id} classroomId={classroomId} entry={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
