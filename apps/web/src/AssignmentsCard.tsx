import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  Send,
  CalendarClock,
  ClipboardList,
  ExternalLink,
  Lock,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import type { Assignment } from "@hgc/contracts";

import { api } from "./api";
import { AssignmentForm, compactDuration } from "./AssignmentForm";
import { HelpIcon } from "./help";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  GithubIcon,
  IconButton,
  isoDateTime,
  Modal,
  Spinner,
  Tip,
} from "./ui";

function StateBadge({ state }: { state: Assignment["state"] }) {
  if (state === "published") return <Badge tone="green">published</Badge>;
  if (state === "locked") return <Badge tone="red" icon={Lock}>locked</Badge>;
  return <Badge tone="zinc">draft</Badge>;
}

function GhLink({ fullName }: { fullName: string }) {
  return (
    <a
      href={`https://github.com/${fullName}`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-full items-center gap-1 text-zinc-500 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
    >
      <GithubIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 break-all">{fullName.split("/")[1]}</span>
      <ExternalLink className="size-3 shrink-0" />
    </a>
  );
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

  return (
    // Two-line layout: title/state/dates with the actions pinned top-right,
    // repo links on their own secondary line so long names wrap freely
    // without ever pushing the buttons around.
    <li className="flex items-start gap-2 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Tip label="Open assignment detail">
            <button onClick={onOpen} className="font-medium hover:text-accent hover:underline">
              {a.name}
            </button>
          </Tip>
          <StateBadge state={a.state} />
          {archived ? (
            <Badge tone="zinc" icon={Archive}>
              archived
            </Badge>
          ) : null}
          {a.state === "draft" && a.durationMinutes != null ? (
            // Manual + duration: dates are provisional until Publish stamps them.
            <span className="inline-flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
              <CalendarClock className="size-3.5" />
              {compactDuration(a.durationMinutes * 60_000)} after publication
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
              <CalendarClock className="size-3.5" />
              {isoDateTime(a.startAt)} → {isoDateTime(a.deadlineAt)}
              <span className="text-zinc-400">
                ({compactDuration(new Date(a.deadlineAt).getTime() - new Date(a.startAt).getTime())})
              </span>
              {a.state === "draft" && a.publishMode === "scheduled" ? (
                <Tip label="Auto-publishes at the start date">
                  <span className="text-accent">· auto</span>
                </Tip>
              ) : null}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <GhLink fullName={a.sourceFullName} />
          {a.squashedFullName ? <GhLink fullName={a.squashedFullName} /> : null}
        </div>
      </div>
      <span className="flex shrink-0 items-center">
        {archived ? (
          <IconButton
            label="Restore"
            onClick={() => unarchive.mutate()}
            disabled={unarchive.isPending}
          >
            <ArchiveRestore className="size-4" />
          </IconButton>
        ) : null}
        {!archived && a.state === "draft" ? (
          <IconButton
            label="Publish"
            onClick={() => {
              if (
                window.confirm(
                  a.durationMinutes != null
                    ? `Publish “${a.name}”? The deadline will be ${compactDuration(a.durationMinutes * 60_000)} from now.`
                    : `Publish “${a.name}”? Students will see it and can accept it.`,
                )
              ) {
                publish.mutate();
              }
            }}
            disabled={publish.isPending}
          >
            <Send className="size-4" />
          </IconButton>
        ) : null}
        {/* Editable at every stage: moving the deadline of an expired
            assignment into the future reopens it (repos unlocked, grading
            resumes until the new deadline). */}
        {!archived ? (
          <>
            <IconButton label="Edit" onClick={onEdit}>
              <Pencil className="size-4" />
            </IconButton>
            <IconButton
              label="Archive"
              onClick={() => {
                if (window.confirm(`Archive “${a.name}”?`)) archive.mutate();
              }}
            >
              <Archive className="size-4" />
            </IconButton>
          </>
        ) : null}
        {!archived && a.state === "draft" ? (
          <IconButton
            label="Delete"
            danger
            onClick={() => {
              if (
                window.confirm(
                  `Delete “${a.name}”? The squashed repository on GitHub will be deleted too.`,
                )
              ) {
                remove.mutate();
              }
            }}
          >
            <Trash2 className="size-4" />
          </IconButton>
        ) : null}
      </span>
    </li>
  );
}


export function AssignmentsCard({
  classroomId,
  appInstalled,
  onOpenAssignment,
}: {
  classroomId: string;
  appInstalled: boolean;
  onOpenAssignment: (assignmentId: string) => void;
}) {
  const [modal, setModal] = useState<"create" | Assignment | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const list = useQuery<Assignment[]>({
    queryKey: ["assignments", classroomId, showArchived ? "archived" : "active"],
    queryFn: () =>
      api(`/app/api/classrooms/${classroomId}/assignments${showArchived ? "?archived=1" : ""}`),
  });

  return (
    <Card className="p-4">
      <div className="mb-1 flex items-center gap-2">
        <ClipboardList className="size-4 text-zinc-400" />
        <h2 className="font-medium">Assignments</h2>
        <HelpIcon topic="assignments" />
        <span className="flex-1" />
        <Tip label="Archives">
          <button
            aria-label="Archives"
            aria-pressed={showArchived}
            onClick={() => setShowArchived((v) => !v)}
            className={`rounded-lg p-2 transition-colors ${
              showArchived
                ? "bg-accent/10 text-accent hover:bg-accent/20"
                : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            }`}
          >
            <Archive className="size-4" />
          </button>
        </Tip>
        {appInstalled ? (
          <Button onClick={() => setModal("create")}>
            <Plus className="size-4" /> New assignment
          </Button>
        ) : null}
      </div>

      {!appInstalled ? (
        <p className="text-sm text-amber-600 dark:text-amber-400">
          Install the GitHub App on the organization to create assignments.
        </p>
      ) : null}

      {list.isLoading ? (
        <Spinner className="py-8" />
      ) : list.data?.length ? (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {list.data.map((a) => (
            <AssignmentRow
              key={a.id}
              classroomId={classroomId}
              assignment={a}
              archived={showArchived}
              onEdit={() => setModal(a)}
              onOpen={() => onOpenAssignment(a.id)}
            />
          ))}
        </ul>
      ) : showArchived ? (
        <EmptyState icon={Archive} title="No archived assignments">
          Assignments you archive end up here and can be restored.
        </EmptyState>
      ) : appInstalled ? (
        <EmptyState icon={ClipboardList} title="No assignments yet">
          Create the first assignment from a source repository of the organization.
        </EmptyState>
      ) : null}

      {modal ? (
        <Modal
          title={modal === "create" ? "New assignment" : `Edit “${modal.name}”`}
          subtitle={
            modal === "create" || modal.state === "draft"
              ? "Draft — nothing is published yet"
              : modal.state === "locked"
                ? "Expired — move the deadline forward to reopen"
                : "Live — changes apply when you save"
          }
          narrow
          flush
          onClose={() => setModal(null)}
        >
          <AssignmentForm
            classroomId={classroomId}
            existing={modal === "create" ? undefined : modal}
            onDone={() => setModal(null)}
          />
        </Modal>
      ) : null}
    </Card>
  );
}
