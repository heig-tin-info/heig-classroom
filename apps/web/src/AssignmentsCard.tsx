import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
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

import { api, apiErrorMessage } from "./api";
import { AssignmentForm, compactDuration } from "./AssignmentForm";
import { useConfirm } from "./confirm";
import {
  Alert,
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  IconButton,
  isoDateTime,
  Menu,
  QueryError,
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
  now,
  onEdit,
  onOpen,
  archived = false,
}: {
  classroomId: string;
  assignment: Assignment;
  /** One clock for the whole list, ticked by the section. */
  now: number;
  onEdit: () => void;
  onOpen: () => void;
  archived?: boolean;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
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

  const repoLinks: MenuItem[] = [
    { label: "Source repository", icon: ExternalLink, href: `https://github.com/${a.sourceFullName}` },
    ...(a.squashedFullName
      ? [{ label: "Distributed repository", icon: ExternalLink, href: `https://github.com/${a.squashedFullName}` }]
      : []),
  ];

  const menu: MenuItem[] = archived
    ? // An archived assignment keeps its repositories on GitHub: the links are
      // the only way back to them from here.
      [{ label: "Restore", icon: ArchiveRestore, onSelect: () => unarchive.mutate() }, ...repoLinks]
    : [
        // Editable at every stage: moving the deadline of an expired
        // assignment into the future reopens it (repos unlocked, grading
        // resumes until the new deadline).
        { label: "Edit", icon: Pencil, onSelect: onEdit },
        ...repoLinks,
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
            <span className="ml-1 font-medium text-fg-muted">· auto</span>
          </Tip>
        ) : null}
      </>
    );

  // Whichever action just failed: one line under the row rather than silence.
  const failure = publish.isError
    ? apiErrorMessage(publish.error, "Could not publish this assignment.")
    : archive.isError
      ? apiErrorMessage(archive.error, "Could not archive this assignment.")
      : unarchive.isError
        ? apiErrorMessage(unarchive.error, "Could not restore this assignment.")
        : remove.isError
          ? apiErrorMessage(remove.error, "Could not delete this assignment.")
          : null;

  return (
    // Title and state on the first line, the schedule on the second; the
    // actions stay pinned right whatever the name length, and drop below the
    // title once the row no longer fits a phone.
    <li className={cx("flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5", archived && "opacity-70")}>
      <div className="min-w-56 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {/* Never truncated: on a phone the end of the name is often the
              only thing telling two labs apart. */}
          <button
            type="button"
            onClick={onOpen}
            className="max-w-full text-balance text-left text-[15px] font-semibold tracking-tight transition-colors hover:text-accent"
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
        {/* The icon rides in the text flow, so a schedule that wraps on a
            phone never leaves it stranded on a line of its own. */}
        <p className="mt-0.5 text-[13px] text-fg-muted">
          <CalendarClock className="mr-1.5 inline size-3.5 -translate-y-px text-fg-faint" />
          {when}
        </p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
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
        <Menu items={menu} label={`Actions for ${a.name}`} />
      </div>
      {failure ? <p className="w-full text-[13px] text-danger">{failure}</p> : null}
    </li>
  );
}

export function AssignmentsSection({
  classroomId,
  appInstalled,
  blockedElsewhere = false,
  onOpenAssignment,
}: {
  classroomId: string;
  appInstalled: boolean;
  /** The page already explains why assignments are blocked (organization
      missing): skip the App notice, one banner on a bad screen is enough. */
  blockedElsewhere?: boolean;
  onOpenAssignment: (assignmentId: string) => void;
}) {
  const [sheet, setSheet] = useState<"create" | Assignment | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const now = useNow(60_000);
  const list = useQuery<Assignment[]>({
    queryKey: ["assignments", classroomId, showArchived ? "archived" : "active"],
    queryFn: () =>
      api(`/app/api/classrooms/${classroomId}/assignments${showArchived ? "?archived=1" : ""}`),
  });
  /** Only a loaded, genuinely empty list; loading and error are not "empty". */
  const isEmpty = list.isSuccess && list.data.length === 0;
  // The empty state below says the same thing with its own words; two copies
  // of one sentence on one screen is one too many.
  const noticeInEmptyState = !appInstalled && isEmpty && !showArchived;

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
            {/* Hidden only when the empty state below carries this very
                action: while the list loads or fails, the teacher still gets
                their way to create an assignment. */}
            {appInstalled && !isEmpty ? (
              <Button onClick={() => setSheet("create")}>
                <Plus /> Create assignment
              </Button>
            ) : null}
          </>
        }
      />

      {/* The missing App blocks every assignment action, loaded list or not:
          it belongs above the list, not inside one of its states. */}
      {!appInstalled && !noticeInEmptyState && !blockedElsewhere ? (
        <Alert tone="warning" icon={AlertTriangle} title="Assignments need the GitHub App">
          Install the GitHub App on the organization to create assignments.
        </Alert>
      ) : null}

      {list.isLoading ? (
        <Card className="divide-y divide-line">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-2 px-5 py-4">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </Card>
      ) : list.isError ? (
        <QueryError
          title={showArchived ? "Could not load the archives" : "Could not load the assignments"}
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
        />
      ) : list.data?.length ? (
        <Card>
          <ul className="divide-y divide-line">
            {list.data.map((a) => (
              <AssignmentRow
                key={a.id}
                classroomId={classroomId}
                assignment={a}
                now={now}
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
                  <Plus /> Create assignment
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
