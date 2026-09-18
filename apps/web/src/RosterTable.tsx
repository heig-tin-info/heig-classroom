import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  GraduationCap,
  Pencil,
  Trash2,
  UserRoundX,
  X,
} from "lucide-react";
import { useState } from "react";

import type { RosterEntry } from "@hgc/contracts";

import { api, ApiError, apiErrorMessage } from "./api";
import { useConfirm } from "./confirm";
import {
  Badge,
  cx,
  GithubIcon,
  IconButton,
  Initials,
  inputClass,
  isoDateTime,
  Menu,
  SortHeader,
  T,
  useSortableTable,
} from "./ui";

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
  return <Initials name={[entry.prenom, entry.nom]} />;
}

function Row({ classroomId, entry }: { classroomId: string; entry: RosterEntry }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
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
        ? apiErrorMessage(save.error, "Update failed")
        : null;
    const small = cx(inputClass, "h-8");
    return (
      <tr className={cx(T.row, "bg-surface-2/60")}>
        <td className={T.td}>
          <input
            className={small}
            aria-label="Last name"
            value={form.nom}
            onChange={(e) => setForm({ ...form, nom: e.target.value })}
            autoFocus
          />
        </td>
        <td className={T.td}>
          <input
            className={small}
            aria-label="First name"
            value={form.prenom}
            onChange={(e) => setForm({ ...form, prenom: e.target.value })}
          />
        </td>
        <td className={T.td} colSpan={3}>
          <input
            className={small}
            aria-label="E-mail"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          {err ? <p className="mt-1 text-xs text-danger">{err}</p> : null}
          {form.email !== entry.email && entry.status === "claimed" ? (
            <p className="mt-1 text-xs text-warning">
              Changing the e-mail will revoke the student's claim.
            </p>
          ) : null}
        </td>
        <td className={`${T.td} whitespace-nowrap text-right`}>
          <IconButton label="Save" onClick={() => save.mutate()} disabled={save.isPending}>
            <Check />
          </IconButton>
          <IconButton
            label="Cancel"
            onClick={() => {
              setEditing(false);
              setForm({ nom: entry.nom, prenom: entry.prenom, email: entry.email });
            }}
          >
            <X />
          </IconButton>
        </td>
      </tr>
    );
  }

  return (
    <tr className={cx(T.row, T.rowHover)}>
      <td className={`${T.td} font-semibold`}>
        <span className="flex items-center gap-2.5">
          <StudentAvatar entry={entry} />
          {entry.nom}
        </span>
      </td>
      <td className={T.td}>{entry.prenom}</td>
      <td className={`${T.td} text-fg-muted`}>
        <a href={`mailto:${entry.email}`} className="hover:text-fg hover:underline">
          {entry.email}
        </a>
      </td>
      <td className={T.td}>
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
      <td className={T.td}>
        {entry.githubLogin ? (
          <span className="inline-flex items-center gap-1.5 text-fg-muted">
            <GithubIcon className="size-3.5" /> {entry.githubLogin}
          </span>
        ) : (
          <span className="text-fg-faint">—</span>
        )}
      </td>
      <td className={`${T.td} whitespace-nowrap text-fg-muted`}>
        {entry.lastLoginAt ? isoDateTime(entry.lastLoginAt) : "—"}
      </td>
      <td className={`${T.td} whitespace-nowrap text-right`}>
        <Menu
          label={`Actions for ${entry.prenom} ${entry.nom}`}
          items={[
            { label: "Edit", icon: Pencil, onSelect: () => setEditing(true) },
            ...(entry.status === "claimed" || entry.conflictFlag
              ? [
                  {
                    label: "Revoke claim",
                    icon: UserRoundX,
                    onSelect: async () => {
                      if (
                        await confirm({
                          title: `Revoke ${entry.prenom} ${entry.nom}'s claim?`,
                          message: "The seat goes back to pending; the student claims it again on their next sign-in.",
                          confirmLabel: "Revoke",
                        })
                      ) {
                        unclaim.mutate();
                      }
                    },
                  },
                ]
              : []),
            {
              label: "Remove from roster",
              icon: Trash2,
              danger: true,
              separator: true,
              onSelect: async () => {
                if (
                  await confirm({
                    title: `Remove ${entry.prenom} ${entry.nom}?`,
                    message: "The student leaves the roster. Existing repositories on GitHub are not touched.",
                    confirmLabel: "Remove",
                    danger: true,
                  })
                ) {
                  remove.mutate();
                }
              },
            },
          ]}
        />
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
  const { sorted, sort, toggle } = useSortableTable(
    roster,
    (r, k: SortKey) => r[k] ?? "",
    { key: "nom", dir: 1 },
    (x, y) => String(x).localeCompare(String(y), undefined, { sensitivity: "base" }),
  );
  const Th = ({ k, children }: { k: SortKey; children: React.ReactNode }) => (
    <SortHeader k={k} sort={sort} onToggle={toggle}>
      {children}
    </SortHeader>
  );

  return (
    <div className="overflow-x-auto">
      <table className={T.table}>
        <thead>
          <tr className={T.head}>
            <Th k="nom">Last name</Th>
            <Th k="prenom">First name</Th>
            <Th k="email">E-mail</Th>
            <Th k="status">Status</Th>
            <Th k="githubLogin">GitHub</Th>
            <Th k="lastLoginAt">Last sign-in</Th>
            <th className={T.th} aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <Row key={r.id} classroomId={classroomId} entry={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
