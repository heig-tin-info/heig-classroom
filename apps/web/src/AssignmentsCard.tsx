import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  ClipboardList,
  ExternalLink,
  Lock,
  MonitorPlay,
  Pencil,
  Plus,
  Send,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import type { Assignment } from "@hgc/contracts";

import { api } from "./api";
import { AssignmentForm, compactDuration } from "./AssignmentForm";
import { useConfirm } from "./confirm";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  IconButton,
  isoDateTime,
  Menu,
  SectionHeading,
  Skeleton,
  Tip,
  useNow,
  type MenuItem,
} from "./ui";

function StateBadge({ a, now }: { a: Assignment; now: number }) {
  if (a.state === "locked") return <Badge tone="zinc" icon={Lock}>locked</Badge>;
  if (a.state === "published") {
    const started = new Date(a.startAt).getTime() <= now;
    return <Badge tone="green">{started ? "in progress" : "published"}</Badge>;
  }
  return <Badge tone="amber">draft</Badge>;
}

function AssignmentRow({
  classroomId,
  assignment: a,
  onEdit,
  onOpen,
  archived = false,
}: {
  classroomId: string;
  assignment: Assignment;
  onEdit: () => void;
  onOpen: () => void;
  archived?: boolean;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const now = useNow(60_000);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["assignments", classroomId] });
  const base = `/app/api/classrooms/${classroomId}/assignments/${a.id}`;
  const archive = useMutation({
    mutationFn: () => api(`${base}/archive`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const unarchive = useMutation({
    mutationFn: () => api(`${base}/unarchive`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const publish = useMutation({
    mutationFn: () => api(`${base}/publish`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => api(base, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  const menu: MenuItem[] = archived
    ? [{ label: "Restore", icon: ArchiveRestore, onSelect: () => unarchive.mutate() }]
    : [
        // Editable at every stage: moving the deadline of an expired
        // assignment into the future reopens it (repos unlocked, grading
        // resumes until the new deadline).
        { label: "Edit", icon: Pencil, onSelect: onEdit },
        { label: "Source repository", icon: ExternalLink, href: `https://github.com/${a.sourceFullName}` },
        ...(a.squashedFullName
          ? [{ label: "Distributed repository", icon: ExternalLink, href: `https://github.com/${a.squashedFullName}` }]
          : []),
        {
          label: "Archive",
          icon: Archive,
          separator: true,
          onSelect: async () => {
            if (await confirm({ title: `Archive “${a.name}”?`, message: "The assignment leaves the list; nothing is deleted and it can be restored from the archives.", confirmLabel: "Archive" })) {
              archive.mutate();
            }
          },
        },
        ...(a.state === "draft"
          ? [
              {
                label: "Delete",
                icon: Trash2,
                danger: true,
                onSelect: async () => {
                  if (
                    await confirm({
                      title: `Delete “${a.name}”?`,
                      message: "The distributed repository on GitHub is deleted too. This cannot be undone.",
                      confirmLabel: "Delete",
                      danger: true,
                    })
                  ) {
                    remove.mutate();
                  }
                },
              },
            ]
          : []),
      ];

  const when =
    a.state === "draft" && a.durationMinutes != null ? (
      // Manual + duration: dates are provisional until Publish stamps them.
      <>{compactDuration(a.durationMinutes * 60_000)} after publication</>
    ) : (
      <>
        {isoDateTime(a.startAt)} → {isoDateTime(a.deadlineAt)}
        <span className="text-fg-faint">
          {" "}
          · {compactDuration(new Date(a.deadlineAt).getTime() - new Date(a.startAt).getTime())}
        </span>
        {a.state === "draft" && a.publishMode === "scheduled" ? (
          <Tip label="Auto-publishes at the start date">
            <span className="ml-1 text-accent">· auto</span>
          </Tip>
        ) : null}
      </>
    );

  return (
    // Title and state on the first line, the schedule on the second; the
    // actions stay pinned right whatever the name length.
    <li className={cx("flex items-center gap-4 px-5 py-3.5", archived && "opacity-70")}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <button
            type="button"
            onClick={onOpen}
            className="truncate text-left text-[15px] font-semibold tracking-tight transition-colors hover:text-accent"
          >
            {a.name}
          </button>
          <StateBadge a={a} now={now} />
          {a.workMode !== "free" ? (
            <Badge tone="zinc" icon={MonitorPlay}>
              {a.workMode === "online_seb" ? "exam" : "online"}
            </Badge>
          ) : null}
          {archived ? (
            <Badge tone="zinc" icon={Archive}>
              archived
            </Badge>
          ) : null}
        </div>
        <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-fg-muted">
          <CalendarClock className="size-3.5 shrink-0 text-fg-faint" />
          <span className="truncate">{when}</span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!archived && a.state === "draft" ? (
          <Button
            size="sm"
            variant="secondary"
            loading={publish.isPending}
            onClick={async () => {
              if (
                await confirm({
                  title: `Publish “${a.name}”?`,
                  message:
                    a.durationMinutes != null
                      ? `The deadline will be ${compactDuration(a.durationMinutes * 60_000)} from now. Students will see the assignment and can accept it.`
                      : "Students will see the assignment and can accept it.",
                  confirmLabel: "Publish",
                })
              ) {
                publish.mutate();
              }
            }}
          >
            <Send /> Publish
          </Button>
        ) : null}
        {archived ? (
          <IconButton label="Restore" onClick={() => unarchive.mutate()} disabled={unarchive.isPending}>
            <ArchiveRestore />
          </IconButton>
        ) : (
          <Menu items={menu} label={`Actions for ${a.name}`} />
        )}
      </div>
    </li>
  );
}

export function AssignmentsSection({
  classroomId,
  appInstalled,
  onOpenAssignment,
}: {
  classroomId: string;
  appInstalled: boolean;
  onOpenAssignment: (assignmentId: string) => void;
}) {
  const [sheet, setSheet] = useState<"create" | Assignment | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const list = useQuery<Assignment[]>({
    queryKey: ["assignments", classroomId, showArchived ? "archived" : "active"],
    queryFn: () =>
      api(`/app/api/classrooms/${classroomId}/assignments${showArchived ? "?archived=1" : ""}`),
  });

  return (
    <div className="space-y-4">
      <SectionHeading
        title={showArchived ? "Archived assignments" : "Assignments"}
        count={list.data?.length}
        help="assignments"
        actions={
          <>
            <IconButton label="Archives" active={showArchived} onClick={() => setShowArchived((v) => !v)}>
              <Archive />
            </IconButton>
            {appInstalled ? (
              <Button onClick={() => setSheet("create")}>
                <Plus /> New assignment
              </Button>
            ) : null}
          </>
        }
      />

      {list.isLoading ? (
        <Card className="divide-y divide-line">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-2 px-5 py-4">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </Card>
      ) : list.data?.length ? (
        <Card>
          <ul className="divide-y divide-line">
            {list.data.map((a) => (
              <AssignmentRow
                key={a.id}
                classroomId={classroomId}
                assignment={a}
                archived={showArchived}
                onEdit={() => setSheet(a)}
                onOpen={() => onOpenAssignment(a.id)}
              />
            ))}
          </ul>
        </Card>
      ) : (
        <Card>
          {showArchived ? (
            <EmptyState icon={Archive} title="No archived assignments">
              Assignments you archive end up here and can be restored.
            </EmptyState>
          ) : appInstalled ? (
            <EmptyState
              icon={ClipboardList}
              title="No assignments yet"
              action={
                <Button onClick={() => setSheet("create")}>
                  <Plus /> New assignment
                </Button>
              }
            >
              Create the first assignment from a source repository of the organization.
            </EmptyState>
          ) : (
            <EmptyState icon={ClipboardList} title="Assignments need the GitHub App">
              Install the GitHub App on the organization to create assignments.
            </EmptyState>
          )}
        </Card>
      )}

      {sheet ? (
        <AssignmentForm
          classroomId={classroomId}
          existing={sheet === "create" ? undefined : sheet}
          onDone={() => setSheet(null)}
        />
      ) : null}
    </div>
  );
}
