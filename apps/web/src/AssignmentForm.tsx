import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  FileText,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Lock,
  Plus,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Assignment, OrgRepo, RepoTree } from "@hgc/contracts";

import { api, ApiError, apiErrorMessage } from "./api";
import { HelpIcon } from "./help";
import {
  Badge,
  Button,
  Field,
  GithubIcon,
  isoDateTime,
  localDateTimeInputValue,
  Progress,
} from "./ui";

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

// The backend provisions the squashed repository synchronously (create →
// clone → squash → push), which takes several seconds. We can't stream real
// progress, so the overlay walks through the steps on a timer to make the
// wait feel intentional rather than stuck.
const CREATE_STEPS = [
  "Creating the squashed repository…",
  "Cloning the source repository…",
  "Squashing the history…",
  "Pushing to GitHub…",
];

function CreatingOverlay() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setStep((s) => Math.min(s + 1, CREATE_STEPS.length - 1)),
      1800,
    );
    return () => clearInterval(id);
  }, []);
  return (
    // Above the modal (z-50): the whole dialog greys out, spinner on top.
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-white/70 backdrop-blur-sm dark:bg-zinc-950/70"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-8 animate-spin text-accent" />
      <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
        {CREATE_STEPS[step]}
      </p>
    </div>
  );
}

/** Compact duration: "45 min", "1 h 30 min", "3 d 4 h", "26 d". */
export function compactDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) {
    const m = min % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr ? `${d} d ${hr} h` : `${d} d`;
}

/** "labo-02-quadratic" → "Labo 02 Quadratic" (default assignment name). */
export function humanize(repo: string): string {
  return repo
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function AssignmentForm({
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
  const [branch, setBranch] = useState("");
  const [showFiles, setShowFiles] = useState(false);
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
      if (!existing) {
        setProtectedFiles(new Set(t.suggestedProtected));
        setBranch(t.defaultBranch);
      }
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
              branches: branch ? [branch] : undefined,
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
      ? apiErrorMessage(save.error, "Request failed")
      : null;

  const select =
    "rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-accent focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

  return (
    <form
      className="relative space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {save.isPending && !existing ? <CreatingOverlay /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {existing ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="flex items-center gap-1 font-medium text-zinc-700 dark:text-zinc-300">
              Source repository <HelpIcon topic="assignment-source" />
            </span>
            <span className="inline-flex items-center gap-1.5 py-1.5 text-sm text-zinc-500 dark:text-zinc-400">
              <GithubIcon className="size-4" /> {existing.sourceFullName.split("/")[1]}
            </span>
          </label>
        ) : (
          // The repository comes first: picking it pre-fills a humanized name
          // ("labo-02-quadratic" → "Labo 02 Quadratic") that stays editable.
          <label className="flex flex-col gap-1 text-sm">
            <span className="flex items-center gap-1 font-medium text-zinc-700 dark:text-zinc-300">
              Source repository <HelpIcon topic="assignment-source" />
            </span>
            <select
              className={`${select} w-full`}
              value={sourceRepo}
              onChange={(e) => {
                const next = e.target.value;
                setName((n) => (n === "" || n === humanize(sourceRepo) ? humanize(next) : n));
                setSourceRepo(next);
              }}
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
        <Field
          label="Name"
          placeholder="Lab 1 — Pointers"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full"
          required
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Start"
          help="assignment-dates"
          type="datetime-local"
          value={startAt}
          onChange={(e) => setStartAt(e.target.value)}
          className="w-full"
          required
        />
        <Field
          label="Deadline"
          help="assignment-dates"
          type="datetime-local"
          value={deadlineAt}
          onChange={(e) => setDeadlineAt(e.target.value)}
          className="w-full"
          required
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {!existing ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="flex items-center gap-1 font-medium text-zinc-700 dark:text-zinc-300">
              Distributed source <HelpIcon topic="distributed-source" />
            </span>
            <select
              className={`${select} w-full`}
              value={sourceStrategy}
              onChange={(e) => setSourceStrategy(e.target.value as "squash" | "whole")}
            >
              <option value="squash">Squash (single initial commit)</option>
              <option value="whole">Whole history</option>
            </select>
          </label>
        ) : null}
        {!existing && sourceStrategy === "squash" && (tree.data?.branches.length ?? 0) > 1 ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="flex items-center gap-1 font-medium text-zinc-700 dark:text-zinc-300">
              Branch to squash <HelpIcon topic="squash-branch" />
            </span>
            <select
              className={`${select} w-full`}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            >
              {tree.data!.branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-1 text-sm">
          <span className="flex items-center gap-1 font-medium text-zinc-700 dark:text-zinc-300">
            At deadline <HelpIcon topic="deadline-strategy" />
          </span>
          <select
            className={`${select} w-full`}
            value={deadlineStrategy}
            onChange={(e) => setDeadlineStrategy(e.target.value as "lock" | "commit")}
            disabled={existing !== undefined && existing.state !== "draft"}
            title={
              existing !== undefined && existing.state !== "draft"
                ? "The deadline strategy is fixed at publication"
                : undefined
            }
          >
            <option value="lock">Lock the repository</option>
            <option value="commit">Deadline commit</option>
          </select>
        </label>
      </div>

      {existing?.state === "locked" ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          This assignment has expired. Saving a deadline in the future <b>reopens</b> it:
          repositories are unlocked, students can push again, and the grade freezes anew at
          the new deadline (the previous frozen grade and LLM review are discarded).
        </p>
      ) : null}

      {sourceRepo === "" ? (
        <p className="text-sm text-zinc-400">
          Pick a source repository to explore its content and choose protected files.
        </p>
      ) : tree.isFetching ? (
        <Progress label={`Exploring ${sourceRepo}…`} />
      ) : tree.data ? (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
          {/* Collapsed by default: the suggestion is right in most cases. */}
          <div className="flex w-full items-center gap-2 px-3 py-2 text-sm">
            <button
              type="button"
              onClick={() => setShowFiles((v) => !v)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              aria-expanded={showFiles}
            >
              <ChevronRight
                className={`size-4 shrink-0 text-zinc-400 transition-transform ${showFiles ? "rotate-90" : ""}`}
              />
              <Lock className="size-3.5 shrink-0 text-zinc-400" />
              <span>
                {protectedFiles.size} file{protectedFiles.size === 1 ? "" : "s"} automatically
                protected
              </span>
            </button>
            <HelpIcon topic="protected-files" />
            <span className="hidden items-center gap-2 text-xs text-zinc-400 sm:inline-flex">
              <GitCommitHorizontal className="size-3.5" />
              {tree.data.headSha.slice(0, 7)}
              {tree.data.headDate ? ` · ${isoDateTime(tree.data.headDate)}` : ""}
            </span>
          </div>
          {showFiles ? (
            <div className="space-y-2 border-t border-zinc-100 p-3 dark:border-zinc-800">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone="zinc" icon={GitBranch}>
                  {tree.data.defaultBranch}
                </Badge>
                {tree.data.branches.length > 1 ? (
                  <span className="text-zinc-500 dark:text-zinc-400">
                    {tree.data.branches.length} branches
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
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        {error ? (
          <span className="min-w-0 flex-1 text-sm text-red-600 dark:text-red-400">{error}</span>
        ) : null}
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
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
      </div>
    </form>
  );
}
