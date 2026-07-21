import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  FileText,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Lock,
  Milestone as MilestoneIcon,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Assignment, OrgRepo, RepoTree } from "@hgc/contracts";

import { api, ApiError, apiErrorMessage } from "./api";
import { HelpIcon } from "./help";
import { useToast } from "./notify";
import {
  Badge,
  Button,
  Field,
  GithubIcon,
  humanize,
  IconButton,
  isoDateTime,
  localDateKey,
  localDateTimeInputValue,
  Progress,
  RadioGroup,
  RangeCalendar,
  Tip,
  Z,
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
/** "HH:mm" of a datetime-local string, "" when unset. */
const timeOf = (local: string) => (local.length >= 16 ? local.slice(11, 16) : "");

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
    // Above the modal (Z.modal): the whole dialog greys out, spinner on top.
    <div
      className={`fixed inset-0 ${Z.overlay} flex flex-col items-center justify-center gap-3 bg-white/70 backdrop-blur-sm dark:bg-zinc-950/70`}
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
  const toast = useToast();
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
  // Publication: scheduled (auto at start) or manual (Publish button, with an
  // absolute deadline or a duration counted from the publication instant).
  const [publishMode, setPublishMode] = useState<"scheduled" | "manual">(
    existing?.publishMode ?? "manual",
  );
  const [deadlineKind, setDeadlineKind] = useState<"date" | "duration">(
    existing?.durationMinutes != null ? "duration" : "date",
  );
  const [durationDays, setDurationDays] = useState(
    existing?.durationMinutes != null ? String(Math.floor(existing.durationMinutes / 1440)) : "7",
  );
  const [durationHours, setDurationHours] = useState(
    existing?.durationMinutes != null
      ? String(Math.round((existing.durationMinutes % 1440) / 60))
      : "0",
  );
  const durationMinutes =
    (Number.parseInt(durationDays, 10) || 0) * 1440 + (Number.parseInt(durationHours, 10) || 0) * 60;
  const durationPicked = publishMode === "manual" && deadlineKind === "duration";
  // Published/locked: the mode is frozen, only the absolute dates move (GH-43 reopen).
  const livePublished = existing !== undefined && existing.state !== "draft";
  // Start + deadline both live in the calendar when the assignment has a real
  // start; manual mode only picks a deadline (the start is the Publish click).
  // Once published, even a duration-based assignment edits absolute dates.
  const rangeMode = livePublished || publishMode === "scheduled";
  const durationOnly = durationPicked && !livePublished;
  // A value is complete once it holds both a day and a time ("…THH:mm"):
  // clearing the time input leaves a bare "YYYY-MM-DDT" behind.
  const whenSet = (v: string) => v.length >= 16;
  const missingWhen = durationOnly
    ? false
    : (rangeMode && !whenSet(startAt)) || !whenSet(deadlineAt);
  // The calendar enforces start ≤ deadline; a same-day range can still invert
  // through the time inputs ("YYYY-MM-DDTHH:mm" compares as a plain string).
  const rangeInvalid =
    !durationOnly && rangeMode && whenSet(startAt) && whenSet(deadlineAt) && deadlineAt <= startAt;
  const [sourceStrategy, setSourceStrategy] = useState<"squash" | "whole">(
    existing?.sourceStrategy ?? "squash",
  );
  const [deadlineStrategy, setDeadlineStrategy] = useState<"lock" | "commit">(
    existing?.deadlineStrategy ?? "lock",
  );
  const [gradingMode, setGradingMode] = useState<"none" | "auto">(
    existing?.gradingMode ?? "auto",
  );
  const [protectedFiles, setProtectedFiles] = useState<Set<string>>(
    new Set(existing?.protectedFiles ?? []),
  );
  // Intermediate reviews authored with the assignment (creation only; the
  // detail view manages them afterwards). "n days before deadline" → J−n.
  const [milestones, setMilestones] = useState<{ name: string; days: string }[]>([]);
  const milestoneName = /^[a-z0-9][a-z0-9_-]{0,49}$/;
  const milestonesValid = milestones.every(
    (m) => milestoneName.test(m.name) && Number.parseInt(m.days, 10) >= 1,
  );
  // Resolved calendar day of a milestone (deadline − n days), when it is known.
  const milestoneDate = (days: string): string | null => {
    const n = Number.parseInt(days, 10);
    if (durationOnly || !whenSet(deadlineAt) || !(n >= 1)) return null;
    const d = new Date(deadlineAt);
    d.setDate(d.getDate() - n);
    return localDateKey(d);
  };

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

  // Dates/duration per mode. Create omits unused keys; edit clears the
  // duration explicitly (null) when switching back to absolute dates.
  const whenFields = (clearDuration: boolean) =>
    livePublished
      ? { startAt: toIso(startAt), deadlineAt: toIso(deadlineAt) }
      : publishMode === "scheduled"
        ? {
            publishMode,
            startAt: toIso(startAt),
            deadlineAt: toIso(deadlineAt),
            ...(clearDuration ? { durationMinutes: null } : {}),
          }
        : deadlineKind === "duration"
          ? { publishMode, durationMinutes }
          : {
              publishMode,
              deadlineAt: toIso(deadlineAt),
              ...(clearDuration ? { durationMinutes: null } : {}),
            };

  const save = useMutation({
    mutationFn: async () => {
      if (existing) {
        return api(`/app/api/classrooms/${classroomId}/assignments/${existing.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name,
            ...whenFields(true),
            deadlineStrategy,
            gradingMode,
            protectedFiles: [...protectedFiles],
          }),
        });
      }
      const created = await api<Assignment>(`/app/api/classrooms/${classroomId}/assignments`, {
        method: "POST",
        body: JSON.stringify({
          name,
          sourceRepo,
          ...whenFields(false),
          sourceStrategy,
          deadlineStrategy,
          gradingMode,
          branches: branch ? [branch] : undefined,
          protectedFiles: [...protectedFiles],
        }),
      });
      // Milestones need the assignment id: created right after, best-effort —
      // the assignment exists either way and the detail view can fix them up.
      const failures: string[] = [];
      for (const m of milestones) {
        try {
          await api(`/app/api/classrooms/${classroomId}/assignments/${created.id}/milestones`, {
            method: "POST",
            body: JSON.stringify({
              name: m.name.trim(),
              offsetDays: -Math.abs(Number.parseInt(m.days, 10)),
            }),
          });
        } catch (err) {
          failures.push(`${m.name}: ${err instanceof ApiError ? err.message : "failed"}`);
        }
      }
      if (failures.length) {
        toast(
          `Assignment created, but some milestones could not be added (${failures.join("; ")}). You can add them from the assignment view.`,
          "warning",
        );
      }
      return created;
    },
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
          fullWidth
          required
        />
      </div>

      {!livePublished ? (
        <div className="grid items-start gap-3 sm:grid-cols-2">
          <RadioGroup
            name="publish-mode"
            label="Publication"
            help="assignment-dates"
            value={publishMode}
            onChange={setPublishMode}
            options={[
              { value: "manual", label: "Manual", description: "Goes live when you press Publish" },
              {
                value: "scheduled",
                label: "Scheduled",
                description: "Published automatically at the start date",
              },
            ]}
          />
          {publishMode === "manual" ? (
            <RadioGroup
              name="deadline-kind"
              label="Deadline"
              help="assignment-dates"
              value={deadlineKind}
              onChange={setDeadlineKind}
              options={[
                { value: "date", label: "Fixed date", description: "Same deadline for everyone" },
                {
                  value: "duration",
                  label: "Duration",
                  description: "Counted from the moment you publish",
                },
              ]}
            />
          ) : null}
        </div>
      ) : null}

      {durationOnly ? (
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label="Days"
            type="number"
            min={0}
            max={400}
            className="w-24"
            value={durationDays}
            onChange={(e) => setDurationDays(e.target.value)}
            required
          />
          <Field
            label="Hours"
            type="number"
            min={0}
            max={23}
            className="w-24"
            value={durationHours}
            onChange={(e) => setDurationHours(e.target.value)}
            required
          />
          {durationMinutes < 15 ? (
            <p className="pb-1.5 text-sm text-amber-600 dark:text-amber-400">
              The duration must be at least 15 minutes.
            </p>
          ) : (
            <p className="pb-1.5 text-sm text-zinc-500 dark:text-zinc-400">
              Deadline {compactDuration(durationMinutes * 60_000)} after publication.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <RangeCalendar
            mode={rangeMode ? "range" : "single"}
            start={rangeMode ? startAt.slice(0, 10) : ""}
            end={deadlineAt.slice(0, 10)}
            onChange={(s, e) => {
              // The calendar owns the days; times survive a day change.
              if (rangeMode) setStartAt(s === "" ? "" : `${s}T${timeOf(startAt) || "08:00"}`);
              setDeadlineAt(e === "" ? "" : `${e}T${timeOf(deadlineAt) || "23:59"}`);
            }}
          />
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
            {rangeMode ? (
              <Field
                label={livePublished ? "Start time" : "Start time (auto-publish)"}
                type="time"
                className="w-28"
                value={timeOf(startAt)}
                disabled={startAt === ""}
                onChange={(e) => setStartAt(`${startAt.slice(0, 10)}T${e.target.value}`)}
                required
              />
            ) : null}
            <Field
              label="Deadline time"
              type="time"
              className="w-28"
              value={timeOf(deadlineAt)}
              disabled={deadlineAt === ""}
              onChange={(e) => setDeadlineAt(`${deadlineAt.slice(0, 10)}T${e.target.value}`)}
              required
            />
            <p className="min-w-0 flex-1 pb-1.5 text-right text-sm">
              {rangeInvalid ? (
                <span className="text-amber-600 dark:text-amber-400">
                  The deadline must come after the start.
                </span>
              ) : missingWhen ? (
                <span className="text-zinc-400">
                  {rangeMode
                    ? startAt === ""
                      ? "Pick the start day, then the deadline."
                      : deadlineAt === ""
                        ? "Now pick the deadline day."
                        : "Set the start and deadline times."
                    : deadlineAt === ""
                      ? "Pick the deadline day in the calendar."
                      : "Set the deadline time."}
                </span>
              ) : rangeMode ? (
                <span className="text-zinc-500 dark:text-zinc-400">
                  {isoDateTime(toIso(startAt))} → {isoDateTime(toIso(deadlineAt))}
                  {" · "}
                  {compactDuration(new Date(deadlineAt).getTime() - new Date(startAt).getTime())}
                </span>
              ) : (
                <span className="text-zinc-500 dark:text-zinc-400">
                  Deadline {isoDateTime(toIso(deadlineAt))}
                </span>
              )}
            </p>
          </div>
        </div>
      )}

      <div className="grid items-start gap-3 sm:grid-cols-3">
        {!existing ? (
          <RadioGroup
            name="source-strategy"
            label="Distributed source"
            help="distributed-source"
            value={sourceStrategy}
            onChange={setSourceStrategy}
            options={[
              {
                value: "squash",
                label: "Squash",
                description: "Single initial commit, history stays private",
              },
              { value: "whole", label: "Whole history", description: "Full history pushed as is" },
            ]}
          />
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
        <RadioGroup
          name="grading-mode"
          label="Grading"
          value={gradingMode}
          onChange={setGradingMode}
          options={[
            { value: "auto", label: "Automatic", description: "Points and final review" },
            { value: "none", label: "None", description: "No grades shown to students" },
          ]}
        />
        <Tip
          label={livePublished ? "The deadline strategy is fixed at publication" : null}
          className="flex w-full"
        >
          <RadioGroup
            name="deadline-strategy"
            label="At deadline"
            help="deadline-strategy"
            className="w-full"
            value={deadlineStrategy}
            onChange={setDeadlineStrategy}
            disabled={livePublished}
            options={[
              {
                value: "lock",
                label: "Lock the repository",
                description: "Pushes blocked, repository read-only",
              },
              {
                value: "commit",
                label: "Deadline commit",
                description: "Marker commit; late pushes stay visible",
              },
            ]}
          />
        </Tip>
      </div>

      {!existing && gradingMode === "auto" ? (
        <div className="space-y-2">
          <span className="flex items-center gap-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            <MilestoneIcon className="size-3.5 text-zinc-400" /> Milestones
            <span className="font-normal text-zinc-400">
              — intermediate reviews, n days before the deadline (criteria tagged{" "}
              <code className="text-xs">milestone:</code>)
            </span>
          </span>
          {milestones.map((m, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input
                className={select}
                placeholder="review-1"
                aria-label="Milestone name"
                value={m.name}
                onChange={(e) =>
                  setMilestones((rows) =>
                    rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)),
                  )
                }
                required
              />
              <input
                type="number"
                min={1}
                max={365}
                className={`${select} w-20`}
                aria-label="Days before the deadline"
                value={m.days}
                onChange={(e) =>
                  setMilestones((rows) =>
                    rows.map((r, j) => (j === i ? { ...r, days: e.target.value } : r)),
                  )
                }
                required
              />
              <span className="text-sm text-zinc-400">
                days before the deadline
                {milestoneDate(m.days) ? (
                  <span className="text-zinc-500 dark:text-zinc-400"> → {milestoneDate(m.days)}</span>
                ) : null}
              </span>
              <IconButton
                label="Remove milestone"
                type="button"
                onClick={() => setMilestones((rows) => rows.filter((_, j) => j !== i))}
              >
                <Trash2 className="size-4" />
              </IconButton>
              {m.name !== "" && !milestoneName.test(m.name) ? (
                <span className="text-xs text-amber-600 dark:text-amber-400">
                  lowercase letters, digits, - and _
                </span>
              ) : null}
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            onClick={() => setMilestones((rows) => [...rows, { name: "", days: "7" }])}
          >
            <Plus className="size-4" /> Add milestone
          </Button>
        </div>
      ) : null}

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
        <Button
          disabled={
            save.isPending ||
            (!existing && !sourceRepo) ||
            (durationOnly && durationMinutes < 15) ||
            missingWhen ||
            rangeInvalid ||
            !milestonesValid
          }
        >
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
