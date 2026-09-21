import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  Lock,
  Pencil,
  Plus,
  Scissors,
  Trash2,
  User,
  UserPlus,
  Users,
  UsersRound,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type {
  AssignmentGroup,
  AssignmentGroupsPayload,
  ClassroomDetail,
  GroupMember,
} from "@hgc/contracts";

import { api, ApiError, apiErrorMessage } from "./api";
import { Breadcrumb } from "./Breadcrumb";
import { useConfirm } from "./confirm";
import { fuzzyFilter } from "./fuzzy";
import { useT } from "./i18n";
import type { Route } from "./router";
import {
  Alert,
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  IconButton,
  Initials,
  inputClass,
  inputSize,
  Menu,
  PageHeader,
  pressable,
  QueryError,
  SearchInput,
  Skeleton,
  Tip,
  type MenuItem,
} from "./ui";

/*
 * Group formation (issue #2, lot 1). A teacher screen, so English throughout.
 *
 * The four decisions behind it:
 * - Type: the 28 px page title over 13 px dense rows; a group name steps to
 *   15 px / 600 over its 13 px member chips. Counts are tabular.
 * - Color: ONE accent, the `Add group` button. The selected card wears a 1 px
 *   accent hairline — the accent as state, not as a second action. A lock is
 *   zinc, an oversized group amber; nothing here is red but a deletion.
 * - Space: 6 between member chips, 12 from a card header to its chips, 16
 *   inside a card, 24 between the two panes and under the page header.
 * - Finish: hairlines and `surface-2` for the recessed bits. No shadow in the
 *   page flow: the selected card is a hairline, never an elevation.
 *
 * The squint test: strip the accent and the selected card is still the one
 * carrying "Click a student in the Unassigned list to add them here" — the
 * affordance says where the next click lands, the colour only repeats it.
 */

const fullName = (m: { nom: string; prenom: string }) => `${m.prenom} ${m.nom}`;

/** The `error` discriminator the group endpoints answer a 409 with. */
type GroupErrorCode = "has_repo" | "duplicate_name" | "group_mode_off" | "unassigned_students";

function groupErrorCode(err: unknown): GroupErrorCode | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const code = (err.body as { error?: unknown } | null)?.error;
  return typeof code === "string" ? (code as GroupErrorCode) : null;
}

// --- Unassigned pane ---------------------------------------------------

function UnassignedRow({
  member,
  disabled,
  onAssign,
}: {
  member: GroupMember;
  /** No group can receive the click yet (no group exists, or one is in flight). */
  disabled: boolean;
  onAssign: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onAssign}
        className={cx(
          "group flex w-full items-center gap-2.5 px-4 py-2 text-left text-[13px] transition-colors",
          disabled ? "cursor-default opacity-60" : "hover:bg-surface-2",
        )}
      >
        <Initials name={[member.prenom, member.nom]} className="size-6 text-[10px]" />
        <span className="min-w-0 flex-1 truncate font-medium">{fullName(member)}</span>
        {member.claimStatus === "pending" ? <Badge tone="amber">pending</Badge> : null}
        {/* One icon per row is eleven icons in a column: it appears where the
            pointer is, and the whole row stays the target either way. */}
        {!disabled ? (
          <UserPlus
            className="size-3.5 shrink-0 text-fg-faint opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden
          />
        ) : null}
      </button>
    </li>
  );
}

function UnassignedPane({
  members,
  canAssign,
  onAssign,
}: {
  members: GroupMember[];
  canAssign: boolean;
  onAssign: (m: GroupMember) => void;
}) {
  const [query, setQuery] = useState("");
  const shown = fuzzyFilter(query, members, (m) => `${m.nom} ${m.prenom} ${m.email}`);
  return (
    <Card className="overflow-hidden lg:sticky lg:top-6">
      <div className="space-y-2.5 border-b border-line px-4 py-3">
        <h2 className="flex items-center gap-2 text-base font-bold tracking-tight">
          <User className="size-4 text-fg-faint" />
          Unassigned
          <span className="text-sm tabular-nums text-fg-faint">{members.length}</span>
        </h2>
        {members.length > 0 ? (
          <SearchInput
            placeholder="Search a student"
            aria-label="Search an unassigned student"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full"
          />
        ) : null}
      </div>
      {members.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-fg-muted">
          Everyone is in a group.
        </p>
      ) : shown.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-fg-muted">
          No student matches “{query}”.
        </p>
      ) : (
        <ul
          aria-label="Unassigned students"
          className="max-h-112 divide-y divide-line overflow-y-auto"
        >
          {shown.map((m) => (
            <UnassignedRow
              key={m.enrollmentId}
              member={m}
              disabled={!canAssign}
              onAssign={() => onAssign(m)}
            />
          ))}
        </ul>
      )}
      {members.length > 0 && !canAssign ? (
        <p className="border-t border-line px-4 py-2.5 text-xs text-fg-faint">
          Add a group first, then click a student to put them in it.
        </p>
      ) : null}
    </Card>
  );
}

// --- Group card --------------------------------------------------------

function MemberChip({
  member,
  locked,
  onRemove,
}: {
  member: GroupMember;
  locked: boolean;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-surface-2 py-0.5 pl-1 pr-1 text-[13px]">
      <Initials name={[member.prenom, member.nom]} className="size-5 text-[9px]" />
      <span className="min-w-0 truncate">{fullName(member)}</span>
      {locked ? (
        <span className="pr-1.5" />
      ) : (
        <IconButton
          size="sm"
          label={`Remove ${fullName(member)} from the group`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X />
        </IconButton>
      )}
    </span>
  );
}

function GroupNameField({
  group,
  onCommit,
  onCancel,
}: {
  group: AssignmentGroup;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(group.name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  const commit = () => {
    const next = value.trim();
    if (next === "" || next === group.name) onCancel();
    else onCommit(next);
  };
  return (
    <input
      ref={ref}
      value={value}
      aria-label={`Name of ${group.name}`}
      className={cx(inputClass, inputSize.sm, "w-44 font-semibold")}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

function GroupCard({
  group,
  selected,
  maxSize,
  busy,
  error,
  onSelect,
  onRename,
  onDelete,
  onRemoveMember,
}: {
  group: AssignmentGroup;
  selected: boolean;
  maxSize: number | null;
  busy: boolean;
  /** The last failure that named this group, shown on its own line. */
  error: string | null;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onRemoveMember: (m: GroupMember) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const locked = group.repo !== null;
  const over = maxSize != null && group.members.length > maxSize;
  const menu: MenuItem[] = [
    { label: "Rename", icon: Pencil, disabled: locked, onSelect: () => setRenaming(true) },
    { label: "Delete", icon: Trash2, danger: true, separator: true, disabled: locked, onSelect: onDelete },
  ];
  return (
    <div
      {...pressable(onSelect)}
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`Group ${group.name}`}
      className={cx(
        "rounded-card border bg-surface p-4 transition-colors duration-150",
        // Selection is a hairline, not an elevation: no shadow in page flow.
        selected
          ? "border-accent ring-1 ring-accent"
          : "cursor-pointer border-line hover:border-line-strong hover:bg-surface-2/40",
        busy && "opacity-60",
      )}
    >
      {/* The ⋯ is pinned top-right: a badge that pushes the header onto a
          second line must not take the menu with it. */}
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1.5">
        {renaming ? (
          <GroupNameField
            group={group}
            onCommit={(name) => {
              setRenaming(false);
              onRename(name);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : locked ? (
          <span className="text-[15px] font-semibold tracking-tight">{group.name}</span>
        ) : (
          <button
            type="button"
            title="Click to rename"
            onClick={(e) => {
              e.stopPropagation();
              setRenaming(true);
            }}
            className="rounded-sm text-left text-[15px] font-semibold tracking-tight transition-colors hover:text-accent"
          >
            {group.name}
          </button>
        )}
        <span className="text-[13px] tabular-nums text-fg-muted">
          {group.members.length}
          {maxSize != null ? ` / ${maxSize}` : ""}
        </span>
        {over ? <Badge tone="amber">over the hint</Badge> : null}
        {locked ? (
          <Tip label="The group repository exists — renaming, deleting and removing members would have to revoke GitHub access">
            <Badge tone="zinc" icon={Lock}>
              repository exists
            </Badge>
          </Tip>
        ) : null}
        </div>
        {/* Menu stops the click at its own anchor, so opening it does not
            also select the card. */}
        <Menu items={menu} label={`Actions for ${group.name}`} />
      </div>

      {group.members.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {group.members.map((m) => (
            <MemberChip
              key={m.enrollmentId}
              member={m}
              locked={locked}
              onRemove={() => onRemoveMember(m)}
            />
          ))}
        </div>
      ) : (
        <p className="mt-3 text-[13px] text-fg-faint">No members yet.</p>
      )}

      {/* The affordance carries the selection, so the card still reads with
          the accent stripped. */}
      {selected && !locked ? (
        <p className="mt-3 border-t border-line pt-2.5 text-xs text-fg-muted">
          Click a student in the Unassigned list to add them here.
        </p>
      ) : null}
      {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}
    </div>
  );
}

// --- Page --------------------------------------------------------------

export function GroupsPage({
  classroomId,
  assignmentId,
  navigate,
}: {
  classroomId: string;
  assignmentId: string;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const base = `/app/api/classrooms/${classroomId}/assignments/${assignmentId}/groups`;
  const key = ["assignment-groups", assignmentId];
  const groups = useQuery<AssignmentGroupsPayload>({
    queryKey: key,
    queryFn: () => api(base),
  });
  // Only for the breadcrumb: the groups payload names the assignment, not the
  // classroom. Same key as everywhere else, so it is usually already cached.
  const room = useQuery<ClassroomDetail>({
    queryKey: ["classroom", classroomId],
    queryFn: () => api(`/app/api/classrooms/${classroomId}`),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Which group the last failure belongs to, so it lands on its own card. */
  const [failure, setFailure] = useState<{ groupId: string | null; message: string } | null>(null);

  const payload = groups.data;
  const list = payload?.groups ?? [];
  // No selection yet (first render, or the selected group was deleted): the
  // first card takes it, so a click on the left always lands somewhere.
  const selected = list.find((g) => g.id === selectedId) ?? list[0] ?? null;

  /** Every write answers with the whole payload: the cache takes it as is. */
  const adopt = (next: AssignmentGroupsPayload) => {
    qc.setQueryData(key, next);
    setFailure(null);
  };
  const failed = (groupId: string | null, fallback: string) => (err: unknown) => {
    const code = groupErrorCode(err);
    setFailure({
      groupId,
      message:
        code === "has_repo"
          ? "This group already has a repository — removing a member would have to revoke their GitHub access (lot 2)."
          : apiErrorMessage(err, fallback),
    });
  };

  const create = useMutation({
    mutationFn: () => api<AssignmentGroup>(base, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: (g) => {
      setFailure(null);
      setSelectedId(g.id);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: failed(null, "Could not add a group."),
  });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api<AssignmentGroup>(`${base}/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    onSuccess: () => {
      setFailure(null);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err, v) => failed(v.id, "Could not rename this group.")(err),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`${base}/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setFailure(null);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err, id) => failed(id, "Could not delete this group.")(err),
  });
  const addMember = useMutation({
    mutationFn: ({ groupId, enrollmentId }: { groupId: string; enrollmentId: string }) =>
      api<AssignmentGroupsPayload>(`${base}/${groupId}/members`, {
        method: "POST",
        body: JSON.stringify({ enrollmentId }),
      }),
    onSuccess: adopt,
    onError: (err, v) => failed(v.groupId, "Could not add this student to the group.")(err),
  });
  const removeMember = useMutation({
    mutationFn: ({ groupId, enrollmentId }: { groupId: string; enrollmentId: string }) =>
      api<AssignmentGroupsPayload>(`${base}/${groupId}/members/${enrollmentId}`, {
        method: "DELETE",
      }),
    onSuccess: adopt,
    onError: (err, v) => failed(v.groupId, "Could not remove this student from the group.")(err),
  });
  const copy = useMutation({
    mutationFn: (fromAssignmentId: string) =>
      api<AssignmentGroupsPayload>(`${base}/copy`, {
        method: "POST",
        body: JSON.stringify({ fromAssignmentId }),
      }),
    onSuccess: (next) => {
      adopt(next);
      setSelectedId(null);
    },
    onError: failed(null, "Could not copy those groups."),
  });
  const split = useMutation({
    mutationFn: (size: number) =>
      api<AssignmentGroupsPayload>(`${base}/split`, {
        method: "POST",
        body: JSON.stringify({ size }),
      }),
    onSuccess: adopt,
    onError: failed(null, "Could not split the remaining students."),
  });
  const singles = useMutation({
    mutationFn: () => api<AssignmentGroupsPayload>(`${base}/singles`, { method: "POST" }),
    onSuccess: adopt,
    onError: failed(null, "Could not put the remaining students in groups of one."),
  });

  const crumbs = (
    <Breadcrumb
      items={[
        { label: t("nav.classrooms"), onClick: () => navigate({ view: "home" }) },
        {
          label: room.data?.name ?? "…",
          onClick: () => navigate({ view: "classroom", id: classroomId }),
        },
        {
          label: payload?.assignment.name ?? t("nav.assignment"),
          onClick: () => navigate({ view: "assignment", classroomId, assignmentId }),
        },
        { label: "Groups" },
      ]}
    />
  );

  if (groups.isLoading) {
    return (
      <div className="space-y-6">
        {crumbs}
        <Skeleton className="h-8 w-72" />
        <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
          <Card className="space-y-3 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </Card>
          <div className="grid gap-3 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!payload) {
    // Not in group mode: an answer, not a failure — the page simply does not
    // apply to an individual assignment.
    const off = groupErrorCode(groups.error) === "group_mode_off";
    return (
      <div className="space-y-6">
        {crumbs}
        {off ? (
          <Card>
            <EmptyState
              icon={UsersRound}
              title="This assignment is individual"
              action={
                <Button
                  variant="secondary"
                  onClick={() => navigate({ view: "assignment", classroomId, assignmentId })}
                >
                  Back to the assignment
                </Button>
              }
            >
              Turn on “Group work” while the assignment is a draft to form groups here.
            </EmptyState>
          </Card>
        ) : groups.error instanceof ApiError && groups.error.status === 404 ? (
          <Card>
            <EmptyState
              icon={XCircle}
              title="Assignment not found"
              action={
                <Button variant="secondary" onClick={() => navigate({ view: "classroom", id: classroomId })}>
                  Back to the classroom
                </Button>
              }
            >
              It was deleted, or it belongs to another classroom.
            </EmptyState>
          </Card>
        ) : (
          <QueryError
            title="Could not load the groups"
            error={groups.error}
            onRetry={() => void groups.refetch()}
            retrying={groups.isFetching}
          />
        )}
      </div>
    );
  }

  const { assignment, unassigned, copySources } = payload;
  const busy =
    addMember.isPending ||
    removeMember.isPending ||
    remove.isPending ||
    copy.isPending ||
    split.isPending ||
    singles.isPending;

  const copyItems: MenuItem[] = copySources.length
    ? copySources.map((s) => ({
        label: s.name,
        description: `${s.groups} group${s.groups === 1 ? "" : "s"}`,
        onSelect: async () => {
          if (
            await confirm({
              title: `Copy the groups of “${s.name}”?`,
              message:
                "The groups of this assignment are replaced by a copy of that one. Students already in a group here are moved.",
              confirmLabel: "Replace the groups",
              danger: true,
            })
          ) {
            copy.mutate(s.id);
          }
        },
      }))
    : [{ label: "No other group assignment", disabled: true }];

  const splitItems: MenuItem[] = [2, 3, 4].map((size) => ({
    label: `Groups of ${size}`,
    description: `${Math.ceil(unassigned.length / size)} new group${Math.ceil(unassigned.length / size) === 1 ? "" : "s"}`,
    onSelect: () => split.mutate(size),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={crumbs}
        title="Groups"
        description={
          // The breadcrumb already names the assignment: this line says what
          // state it is in and what the size hint is, nothing twice.
          <span className="flex flex-wrap items-center gap-2">
            <Badge
              tone={
                assignment.state === "published"
                  ? "green"
                  : assignment.state === "locked"
                    ? "zinc"
                    : "amber"
              }
            >
              {t(`state.${assignment.state}` as Parameters<typeof t>[0])}
            </Badge>
            {assignment.groupMaxSize != null ? (
              <span className="text-fg-faint">
                hint: at most {assignment.groupMaxSize} per group
              </span>
            ) : null}
          </span>
        }
        actions={
          <>
            <Menu
              items={copyItems}
              align="end"
              label="Copy the groups of another assignment"
              trigger={
                <Button variant="secondary">
                  <Copy /> Copy from…
                </Button>
              }
            />
            <Menu
              items={splitItems}
              align="end"
              label="Split the remaining students"
              trigger={
                <Button variant="secondary" disabled={unassigned.length === 0}>
                  <Scissors /> Split remaining
                </Button>
              }
            />
            <Button
              variant="secondary"
              disabled={unassigned.length === 0}
              loading={singles.isPending}
              onClick={() => singles.mutate()}
            >
              <User /> Everyone else alone
            </Button>
            {/* Hidden only when the empty state below carries this very
                action: two accent buttons for one action is one too many. */}
            {list.length > 0 ? (
              <Button loading={create.isPending} onClick={() => create.mutate()}>
                <Plus /> Add group
              </Button>
            ) : null}
          </>
        }
      />

      {assignment.state !== "draft" ? (
        <Alert tone="neutral" icon={Lock} title="This assignment is published">
          Groups whose repository already exists are locked: they cannot be renamed, deleted, nor
          lose a member.
        </Alert>
      ) : null}
      {failure && failure.groupId === null ? (
        <Alert tone="danger" icon={XCircle} title="The last action failed">
          {failure.message}
        </Alert>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[20rem_1fr]">
        <UnassignedPane
          members={unassigned}
          canAssign={selected !== null && !busy}
          onAssign={(m) =>
            selected &&
            addMember.mutate({ groupId: selected.id, enrollmentId: m.enrollmentId })
          }
        />

        {list.length === 0 ? (
          <Card>
            <EmptyState
              icon={Users}
              title="No group yet"
              action={
                <Button loading={create.isPending} onClick={() => create.mutate()}>
                  <Plus /> Add group
                </Button>
              }
            >
              Add a group, then click the students to fill it. “Split remaining” and “Everyone
              else alone” do the whole roster in one go.
            </EmptyState>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((g) => (
              <GroupCard
                key={g.id}
                group={g}
                selected={selected?.id === g.id}
                maxSize={assignment.groupMaxSize}
                busy={busy}
                error={failure?.groupId === g.id ? failure.message : null}
                onSelect={() => setSelectedId(g.id)}
                onRename={(name) => rename.mutate({ id: g.id, name })}
                onRemoveMember={(m) =>
                  removeMember.mutate({ groupId: g.id, enrollmentId: m.enrollmentId })
                }
                onDelete={async () => {
                  if (
                    await confirm({
                      title: `Delete “${g.name}”?`,
                      message:
                        g.members.length > 0
                          ? `Its ${g.members.length} member${g.members.length === 1 ? "" : "s"} go back to the unassigned list.`
                          : undefined,
                      confirmLabel: "Delete",
                      danger: true,
                    })
                  ) {
                    remove.mutate(g.id);
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
