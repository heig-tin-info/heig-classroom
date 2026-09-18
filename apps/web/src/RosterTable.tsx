import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  GraduationCap,
  Loader2,
  Pencil,
  Trash2,
  UserRoundX,
  X,
} from "lucide-react";
import { Fragment, useState } from "react";

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
  inputSize,
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
    // Compact: an inline edit sits inside a table row, so it takes the 28 px
    // control height instead of the 34 px one a form field gets.
    const small = cx(inputClass, inputSize.sm, "w-full");
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

  const busy = unclaim.isPending || remove.isPending;

  // A failed action from the row menu: one line under the row it came from.
  const failure = unclaim.isError
    ? apiErrorMessage(unclaim.error, "Could not revoke this claim.")
    : remove.isError
      ? apiErrorMessage(remove.error, "Could not remove this student.")
      : null;

  return (
    <Fragment>
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
          {/* The menu is gone by the time the request answers, so the row
              itself carries the fact that something is running. */}
          {busy ? (
            <Loader2 className="mr-1 inline size-4 animate-spin text-fg-faint" aria-label="Working…" />
          ) : null}
          <Menu
            label={`Actions for ${entry.prenom} ${entry.nom}`}
            items={[
              { label: "Edit", icon: Pencil, onSelect: () => setEditing(true) },
              ...(entry.status === "claimed" || entry.conflictFlag
                ? [
                    {
                      label: "Revoke claim",
                      icon: UserRoundX,
                      disabled: unclaim.isPending,
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
                disabled: remove.isPending,
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
      {failure ? (
        <tr>
          <td colSpan={7} className="px-3 pb-2 text-[13px] text-danger">
            {failure}
          </td>
        </tr>
      ) : null}
    </Fragment>
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
    /* Seven columns never fit a phone: the table scrolls, the page does not. */
    <div className="overflow-x-auto">
      <table className={cx(T.table, "min-w-220")}>
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
