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
import { Badge, EmptyState, GithubIcon } from "./ui";

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
        ? ((save.error.body as { message?: string })?.message ?? "Modification refusée")
        : null;
    return (
      <tr className="bg-zinc-50 dark:bg-zinc-800/50">
        <td className={cell}>
          <div className="flex gap-1">
            <input
              className={input}
              aria-label="Prénom"
              value={form.prenom}
              onChange={(e) => setForm({ ...form, prenom: e.target.value })}
            />
            <input
              className={input}
              aria-label="Nom"
              value={form.nom}
              onChange={(e) => setForm({ ...form, nom: e.target.value })}
            />
          </div>
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
              Changer l'e-mail révoquera le rattachement de l'étudiant.
            </p>
          ) : null}
        </td>
        <td className={`${cell} text-right whitespace-nowrap`}>
          <IconButton label="Enregistrer" onClick={() => save.mutate()} disabled={save.isPending}>
            <Check className="size-4" />
          </IconButton>
          <IconButton
            label="Annuler"
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
        {entry.prenom} {entry.nom}
      </td>
      <td className={`${cell} text-zinc-500 dark:text-zinc-400`}>{entry.email}</td>
      <td className={cell}>
        {entry.conflictFlag ? (
          <Badge tone="red" icon={AlertTriangle}>
            conflit
          </Badge>
        ) : entry.status === "claimed" ? (
          <Badge tone="green" icon={CheckCircle2}>
            réclamé
          </Badge>
        ) : (
          <Badge tone="amber" icon={Clock}>
            en attente
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
        {entry.lastLoginAt ? new Date(entry.lastLoginAt).toLocaleString("fr-CH") : "—"}
      </td>
      <td className={`${cell} text-right whitespace-nowrap`}>
        <IconButton label="Modifier" onClick={() => setEditing(true)}>
          <Pencil className="size-4" />
        </IconButton>
        {entry.status === "claimed" || entry.conflictFlag ? (
          <IconButton
            label="Révoquer le rattachement"
            onClick={() => unclaim.mutate()}
            disabled={unclaim.isPending}
          >
            <UserRoundX className="size-4" />
          </IconButton>
        ) : null}
        <IconButton
          label="Supprimer l'étudiant"
          danger
          onClick={() => {
            if (window.confirm(`Supprimer ${entry.prenom} ${entry.nom} du roster ?`)) {
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
      <EmptyState icon={Users} title="Roster vide">
        Importe la liste des étudiants au format CSV ou Excel pour démarrer.
      </EmptyState>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            <th className={`${cell} font-medium`}>Étudiant</th>
            <th className={`${cell} font-medium`}>E-mail</th>
            <th className={`${cell} font-medium`}>Statut</th>
            <th className={`${cell} font-medium`}>GitHub</th>
            <th className={`${cell} font-medium`}>Dernière connexion</th>
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
