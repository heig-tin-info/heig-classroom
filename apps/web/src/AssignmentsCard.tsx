import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  CalendarClock,
  ClipboardList,
  ExternalLink,
  FileText,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";

import { api, ApiError } from "./api";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  GithubIcon,
  isoDateTime,
  localDateTimeInputValue,
  Modal,
  Progress,
} from "./ui";

interface Assignment {
  id: string;
  name: string;
  slug: string;
  state: "draft" | "published" | "locked";
  startAt: string;
  deadlineAt: string;
  graceMinutes: number;
  sourceFullName: string;
  squashedFullName: string | null;
  sourceStrategy: "whole" | "squash";
  deadlineStrategy: "lock" | "commit";
  branches: string[];
  protectedFiles: string[];
}

interface OrgRepo {
  name: string;
  defaultBranch: string;
}

interface RepoTree {
  name: string;
  defaultBranch: string;
  branches: string[];
  headSha: string;
  headDate: string | null;
  tree: { path: string; type: "blob" | "tree" }[];
  truncated: boolean;
  suggestedProtected: string[];
}

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
      className="inline-flex items-center gap-1 text-zinc-500 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
    >
      <GithubIcon className="size-3.5" />
      {fullName.split("/")[1]}
      <ExternalLink className="size-3" />
    </a>
  );
}

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

// --- Repository tree with protected-file checkboxes ---

interface TreeNode {
  name: string;
  path: string;
  type: "blob" | "tree";
  children: TreeNode[];
}

function buildTree(entries: RepoTree["tree"]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirs = new Map<string, TreeNode>();
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const e of sorted) {
    const parts = e.path.split("/");
    const name = parts[parts.length - 1]!;
    const parentPath = parts.slice(0, -1).join("/");
    const node: TreeNode = { name, path: e.path, type: e.type, children: [] };
    if (e.type === "tree") dirs.set(e.path, node);
    const parent = parentPath ? dirs.get(parentPath) : undefined;
    (parent ? parent.children : root).push(node);
  }
  const order = (nodes: TreeNode[]) => {
    nodes.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "tree" ? -1 : 1,
    );
    nodes.forEach((n) => order(n.children));
  };
  order(root);
  return root;
}

function TreeView({
  nodes,
  checked,
  onToggle,
  depth = 0,
}: {
  nodes: TreeNode[];
  checked: Set<string>;
  onToggle: (path: string, value: boolean) => void;
  depth?: number;
}) {
  return (
    <ul className={depth === 0 ? "space-y-0.5" : "ml-4 space-y-0.5 border-l border-zinc-200 pl-2 dark:border-zinc-800"}>
      {nodes.map((n) =>
        n.type === "tree" ? (
          <li key={n.path}>
            <details open={depth < 1}>
              <summary className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <Folder className="size-3.5 text-zinc-400" />
                {n.name}
              </summary>
              <TreeView nodes={n.children} checked={checked} onToggle={onToggle} depth={depth + 1} />
            </details>
          </li>
        ) : (
          <li key={n.path}>
            <label className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <input
                type="checkbox"
                className="accent-accent"
                checked={checked.has(n.path)}
                onChange={(e) => onToggle(n.path, e.target.checked)}
              />
              <FileText className="size-3.5 text-zinc-400" />
              {n.name}
              {checked.has(n.path) ? (
                <span className="text-xs text-accent">protected</span>
              ) : null}
            </label>
          </li>
        ),
      )}
    </ul>
  );
}

// --- Create / edit form (shown in a modal) ---

const toIso = (local: string) => new Date(local).toISOString();
const toLocalInput = (iso: string) => localDateTimeInputValue(new Date(iso));

function AssignmentForm({
  classroomId,
  existing,
  onDone,
}: {
  classroomId: string;
  existing?: Assignment;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(existing?.name ?? "");
  const [sourceRepo, setSourceRepo] = useState(
    existing ? existing.sourceFullName.split("/")[1]! : "",
  );
  const [startAt, setStartAt] = useState(
    existing ? toLocalInput(existing.startAt) : localDateTimeInputValue(),
  );
  const [deadlineAt, setDeadlineAt] = useState(
    existing ? toLocalInput(existing.deadlineAt) : "",
  );
  const [sourceStrategy, setSourceStrategy] = useState<"squash" | "whole">(
    existing?.sourceStrategy ?? "squash",
  );
  const [deadlineStrategy, setDeadlineStrategy] = useState<"lock" | "commit">(
    existing?.deadlineStrategy ?? "lock",
  );
  const [protectedFiles, setProtectedFiles] = useState<Set<string>>(
    new Set(existing?.protectedFiles ?? []),
  );

  const repos = useQuery<OrgRepo[]>({
    queryKey: ["org-repos", classroomId],
    enabled: !existing,
    queryFn: () => api(`/app/api/classrooms/${classroomId}/org-repos`),
  });

  const tree = useQuery<RepoTree>({
    queryKey: ["repo-tree", classroomId, sourceRepo],
    enabled: sourceRepo !== "",
    staleTime: 60_000,
    queryFn: async () => {
      const t = await api<RepoTree>(
        `/app/api/classrooms/${classroomId}/org-repos/${sourceRepo}/tree`,
      );
      if (!existing) setProtectedFiles(new Set(t.suggestedProtected));
      return t;
    },
  });
  const nodes = useMemo(() => (tree.data ? buildTree(tree.data.tree) : []), [tree.data]);

  const save = useMutation({
    mutationFn: () =>
      existing
        ? api(`/app/api/classrooms/${classroomId}/assignments/${existing.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              name,
              startAt: toIso(startAt),
              deadlineAt: toIso(deadlineAt),
              deadlineStrategy,
              protectedFiles: [...protectedFiles],
            }),
          })
        : api(`/app/api/classrooms/${classroomId}/assignments`, {
            method: "POST",
            body: JSON.stringify({
              name,
              sourceRepo,
              startAt: toIso(startAt),
              deadlineAt: toIso(deadlineAt),
              sourceStrategy,
              deadlineStrategy,
              protectedFiles: [...protectedFiles],
            }),
          }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["assignments", classroomId] });
      onDone();
    },
  });
  const error =
    save.isError && save.error instanceof ApiError
      ? ((save.error.body as { message?: string })?.message ?? "Request failed")
      : null;

  const select =
    "rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-accent focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Name"
          placeholder="Lab 1 — Pointers"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        {existing ? (
          <Badge tone="zinc" icon={GithubIcon}>
            {existing.sourceFullName.split("/")[1]}
          </Badge>
        ) : (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              Source repository
            </span>
            <select
              className={select}
              value={sourceRepo}
              onChange={(e) => setSourceRepo(e.target.value)}
              required
            >
              <option value="" disabled>
                {repos.isLoading ? "Loading…" : "Pick a repository"}
              </option>
              {repos.data?.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Start"
          type="datetime-local"
          value={startAt}
          onChange={(e) => setStartAt(e.target.value)}
          required
        />
        <Field
          label="Deadline"
          type="datetime-local"
          value={deadlineAt}
          onChange={(e) => setDeadlineAt(e.target.value)}
          required
        />
        {!existing ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">Distributed source</span>
            <select
              className={select}
              value={sourceStrategy}
              onChange={(e) => setSourceStrategy(e.target.value as "squash" | "whole")}
            >
              <option value="squash">Squash (single initial commit)</option>
              <option value="whole">Whole history</option>
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">At deadline</span>
          <select
            className={select}
            value={deadlineStrategy}
            onChange={(e) => setDeadlineStrategy(e.target.value as "lock" | "commit")}
          >
            <option value="lock">Lock the repository</option>
            <option value="commit">Deadline commit</option>
          </select>
        </label>
      </div>

      {sourceRepo === "" ? (
        <p className="text-sm text-zinc-400">
          Pick a source repository to explore its content and choose protected files.
        </p>
      ) : tree.isFetching ? (
        <Progress label={`Exploring ${sourceRepo}…`} />
      ) : tree.data ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="zinc" icon={GitBranch}>
              {tree.data.defaultBranch}
            </Badge>
            {tree.data.branches.length > 1 ? (
              <span className="text-zinc-500 dark:text-zinc-400">
                {tree.data.branches.length} branches
              </span>
            ) : null}
            <Badge tone="zinc" icon={GitCommitHorizontal}>
              {tree.data.headSha.slice(0, 7)}
            </Badge>
            {tree.data.headDate ? (
              <span className="text-zinc-500 dark:text-zinc-400">
                last commit {isoDateTime(tree.data.headDate)}
              </span>
            ) : null}
          </div>
          <div className="max-h-64 overflow-y-auto rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
            <TreeView
              nodes={nodes}
              checked={protectedFiles}
              onToggle={(path, value) =>
                setProtectedFiles((prev) => {
                  const next = new Set(prev);
                  if (value) next.add(path);
                  else next.delete(path);
                  return next;
                })
              }
            />
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Checked files are protected: any student change is automatically reverted.
            {tree.data.truncated ? " (large repository — tree truncated)" : ""}
          </p>
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <Button disabled={save.isPending || (!existing && !sourceRepo)}>
          {save.isPending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {existing ? "Saving…" : "Creating squashed repository…"}
            </>
          ) : existing ? (
            "Save changes"
          ) : (
            <>
              <Plus className="size-4" /> Create assignment
            </>
          )}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        {error ? <span className="text-sm text-red-600 dark:text-red-400">{error}</span> : null}
      </div>
    </form>
  );
}

// --- Card ---

function AssignmentRow({
  classroomId,
  assignment: a,
  onEdit,
}: {
  classroomId: string;
  assignment: Assignment;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["assignments", classroomId] });
  const base = `/app/api/classrooms/${classroomId}/assignments/${a.id}`;
  const archive = useMutation({
    mutationFn: () => api(`${base}/archive`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => api(base, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
      <span className="font-medium">{a.name}</span>
      <StateBadge state={a.state} />
      <span className="inline-flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
        <CalendarClock className="size-3.5" />
        {isoDateTime(a.startAt)} → {isoDateTime(a.deadlineAt)}
      </span>
      <span className="flex-1" />
      <span className="flex items-center gap-3 text-sm">
        <GhLink fullName={a.sourceFullName} />
        {a.squashedFullName ? <GhLink fullName={a.squashedFullName} /> : null}
      </span>
      <span className="flex items-center">
        {a.state === "draft" ? (
          <IconButton label="Edit" onClick={onEdit}>
            <Pencil className="size-4" />
          </IconButton>
        ) : null}
        <IconButton
          label="Archive"
          onClick={() => {
            if (window.confirm(`Archive “${a.name}”?`)) archive.mutate();
          }}
        >
          <Archive className="size-4" />
        </IconButton>
        {a.state === "draft" ? (
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
}: {
  classroomId: string;
  appInstalled: boolean;
}) {
  const [modal, setModal] = useState<"create" | Assignment | null>(null);
  const list = useQuery<Assignment[]>({
    queryKey: ["assignments", classroomId],
    queryFn: () => api(`/app/api/classrooms/${classroomId}/assignments`),
  });

  return (
    <Card className="p-4">
      <div className="mb-1 flex items-center gap-2">
        <ClipboardList className="size-4 text-zinc-400" />
        <h2 className="font-medium">Assignments</h2>
        <span className="flex-1" />
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

      {list.data?.length ? (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {list.data.map((a) => (
            <AssignmentRow
              key={a.id}
              classroomId={classroomId}
              assignment={a}
              onEdit={() => setModal(a)}
            />
          ))}
        </ul>
      ) : appInstalled ? (
        <EmptyState icon={ClipboardList} title="No assignments yet">
          Create the first assignment from a source repository of the organization.
        </EmptyState>
      ) : null}

      {modal ? (
        <Modal
          title={modal === "create" ? "New assignment" : `Edit “${modal.name}”`}
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
