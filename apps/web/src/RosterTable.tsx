import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  Clock,
  GraduationCap,
  Mail,
  Pencil,
  Trash2,
  UserRoundX,
  Users,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { RosterEntry } from "@hgc/contracts";

import { api, ApiError } from "./api";
import { Badge, EmptyState, GithubIcon, IconButton, isoDateTime } from "./ui";

const cell = "px-3 py-2";

function StudentAvatar({ entry }: { entry: RosterEntry }) {
  const [failed, setFailed] = useState(false);
  if (entry.avatarUrl && !failed) {
    return (
      <img
        src={entry.avatarUrl}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="size-7 shrink-0 rounded-full object-cover"
      />
    );
  }
  const initials = `${entry.prenom.charAt(0)}${entry.nom.charAt(0)}`.toUpperCase();
  return (
    <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-medium text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
      {initials}
    </span>
  );
}
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
      <td className={`${cell} font-medium`}>
        <span className="flex items-center gap-2">
          <StudentAvatar entry={entry} />
          {entry.nom}
        </span>
      </td>
      <td className={cell}>{entry.prenom}</td>
      <td className={`${cell} text-zinc-500 dark:text-zinc-400`}>
        <a
          href={`mailto:${entry.email}`}
          title={`Write to ${entry.prenom} ${entry.nom}`}
          className="inline-flex items-center gap-1.5 hover:text-accent hover:underline"
        >
          <Mail className="size-3.5 text-zinc-300 dark:text-zinc-600" />
          {entry.email}
        </a>
      </td>
      <td className={cell}>
        <span className="inline-flex items-center gap-1">
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
          {entry.staff ? (
            <Badge tone="zinc" icon={GraduationCap}>
              staff
            </Badge>
          ) : null}
        </span>
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

type SortKey = "nom" | "prenom" | "email" | "status" | "githubLogin" | "lastLoginAt";

export function RosterTable({
  classroomId,
  roster,
}: {
  classroomId: string;
  roster: RosterEntry[];
}) {
  const [sortKey, setSortKey] = useState<SortKey>("nom");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const sorted = useMemo(() => {
    const data = [...roster];
    data.sort((a, b) => {
      const x = a[sortKey] ?? "";
      const y = b[sortKey] ?? "";
      return String(x).localeCompare(String(y), undefined, { sensitivity: "base" }) * sortDir;
    });
    return data;
  }, [roster, sortKey, sortDir]);

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
            sortDir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
          ) : null}
        </button>
      </th>
    );
  }

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
          <tr className="text-left text-xs text-zinc-500 dark:text-zinc-400">
            <SortHeader k="nom">Last name</SortHeader>
            <SortHeader k="prenom">First name</SortHeader>
            <SortHeader k="email">E-mail</SortHeader>
            <SortHeader k="status">Status</SortHeader>
            <SortHeader k="githubLogin">GitHub</SortHeader>
            <SortHeader k="lastLoginAt">Last sign-in</SortHeader>
            <th className={cell} aria-label="Actions" />
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {sorted.map((r) => (
            <Row key={r.id} classroomId={classroomId} entry={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
