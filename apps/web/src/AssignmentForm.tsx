import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileText,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Lock,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Assignment, OrgRepo, RepoTree, WorkMode } from "@hgc/contracts";

import { api, ApiError, apiErrorMessage, useMe } from "./api";
import { HelpIcon } from "./help";
import { useToast } from "./notify";
import {
  Alert,
  Badge,
  Button,
  cx,
  Field,
  FieldLabel,
  GithubIcon,
  humanize,
  IconButton,
  inputClass,
  inputSize,
  isoDateTime,
  localDateKey,
  localDateTimeInputValue,
  Progress,
  QueryError,
  RangeCalendar,
  Segmented,
  Select,
  SettingRow,
  Sheet,
  Switch,
  Textarea,
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
    <ul className={depth === 0 ? "space-y-0.5" : "ml-4 space-y-0.5 border-l border-line pl-2"}>
      {nodes.map((n) =>
        n.type === "tree" ? (
          <li key={n.path}>
            <details open={depth < 1}>
              <summary className="flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[13px] hover:bg-surface-2">
                <Folder className="size-3.5 text-fg-faint" />
                {n.name}
              </summary>
              <TreeView nodes={n.children} checked={checked} onToggle={onToggle} depth={depth + 1} />
            </details>
          </li>
        ) : (
          <li key={n.path}>
            <label className="flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[13px] hover:bg-surface-2">
              <input
                type="checkbox"
                className="accent-accent"
                checked={checked.has(n.path)}
                onChange={(e) => onToggle(n.path, e.target.checked)}
              />
              <FileText className="size-3.5 text-fg-faint" />
              <span className={checked.has(n.path) ? "font-medium" : ""}>{n.name}</span>
              {checked.has(n.path) ? (
                <Lock className="size-3 text-accent" aria-label="protected" />
              ) : null}
            </label>
          </li>
        ),
      )}
    </ul>
  );
}

// --- Create / edit form (shown in a sheet) ---

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
    // Above the sheet (Z.modal): the whole panel greys out, spinner on top.
    <div
      className={`fixed inset-0 ${Z.overlay} flex flex-col items-center justify-center gap-3 bg-canvas/70 backdrop-blur-sm`}
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-8 animate-spin text-accent" />
      <p className="text-sm font-medium text-fg-muted">{CREATE_STEPS[step]}</p>
    </div>
  );
}

/**
 * Work modes (ADR-013), one line each — the wording follows
 * `packages/contracts/src/codespace.ts`, which is the contract with the
 * portal. Teacher surfaces stay in English (i18n.tsx scope rule).
 */
const WORK_MODE_LABELS: Record<WorkMode, string> = {
  free: "Free",
  online: "Online",
  online_seb: "Exam (SEB)",
};
const WORK_MODE_DESC: Record<WorkMode, string> = {
  free: "Students clone and push with their own GitHub account",
  online:
    "Work happens in the portal; students only read their repository and the portal pushes for them",
  online_seb:
    "Same, but the session only opens from Safe Exam Browser and students get no repository access before grading",
};

/** One Browser Exam Key per line, 64 hex characters (portal invariant). */
const BEK_RE = /^[0-9a-fA-F]{64}$/;
const parseKeys = (raw: string): string[] =>
  raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

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

/** Section label inside the sheet. */
function Eyebrow({ children, trailing }: { children: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">{children}</p>
      {trailing}
    </div>
  );
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
  // --- Online workspace (ADR-013) ---
  const me = useMe();
  // The section only exists when the administrator granted this teacher the
  // feature; the server refuses a non-free mode either way (403).
  const canOnline = me.data?.codespace?.enabled === true;
  const [workMode, setWorkMode] = useState<WorkMode>(existing?.workMode ?? "free");
  // --- Group work (issue #2) ---
  // Only with `workMode: "free"` (the online and SEB sessions are per student)
  // and only while the assignment is a draft: once published, the repositories
  // are already one per student or one per group.
  const [groupMode, setGroupMode] = useState(existing?.groupMode ?? false);
  const [groupMaxSize, setGroupMaxSize] = useState(
    existing?.groupMaxSize != null ? String(existing.groupMaxSize) : "",
  );
  const groupLocked = existing !== undefined && existing.state !== "draft";
  const maxSizeValue = Number.parseInt(groupMaxSize, 10);
  // Only what is on screen may block Save. The field lives behind the group
  // switch and the free work mode; once it is gone, `groupFields()` sends
  // `groupMaxSize: null` anyway, so a value typed before must not keep the
  // submit disabled with nothing left to explain why.
  const maxSizeShown = workMode === "free" && groupMode;
  const maxSizeValid =
    !maxSizeShown || groupMaxSize.trim() === "" || (maxSizeValue >= 1 && maxSizeValue <= 50);
  const [codespaceImage, setCodespaceImage] = useState(existing?.codespaceImage ?? "");
  const [examKeys, setExamKeys] = useState((existing?.browserExamKeys ?? []).join("\n"));
  const onlineMode = workMode !== "free";
  const keys = parseKeys(examKeys);
  const keysValid = keys.every((k) => BEK_RE.test(k));
  // A published online assignment cannot go back to free: its repositories
  // were provisioned without write access (server-side 409 too).
  const onlineLocked = livePublished && (existing?.workMode ?? "free") !== "free";
  const workModeOptions = (["free", "online", "online_seb"] as WorkMode[])
    .filter((m) => !(onlineLocked && m === "free"))
    .map((m) => ({ value: m, label: WORK_MODE_LABELS[m] }));
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

  /** Work-mode fields, only when the teacher may actually set them. */
  const workModeFields = () =>
    canOnline
      ? {
          workMode,
          codespaceImage: onlineMode ? codespaceImage.trim() : "",
          browserExamKeys: workMode === "online_seb" ? keys : [],
        }
      : {};

  /**
   * Group fields. `groupMode` is never true outside the free work mode (the
   * server answers 400 `group_mode_requires_free`), and the switch is disabled
   * on a published assignment, so a PATCH always resends what is already
   * stored there rather than trying to change it (409 `not_draft`).
   */
  const groupFields = () => ({
    groupMode: workMode === "free" ? groupMode : false,
    groupMaxSize:
      groupMode && groupMaxSize.trim() !== "" ? Number.parseInt(groupMaxSize, 10) : null,
  });

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
            ...workModeFields(),
            ...groupFields(),
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
          ...workModeFields(),
          ...groupFields(),
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

  // Recessed panel for conditional detail — one surface level below the sheet.
  const panel = "rounded-field bg-surface-2 p-3";
  const section = "space-y-4 px-6 py-5";
  const fileCount = tree.data?.tree.filter((e) => e.type === "blob").length ?? 0;
  const formId = "assignment-form";
  const submitDisabled =
    save.isPending ||
    (!existing && !sourceRepo) ||
    (durationOnly && durationMinutes < 15) ||
    missingWhen ||
    rangeInvalid ||
    !milestonesValid ||
    !maxSizeValid ||
    (workMode === "online_seb" && !keysValid);

  return (
    <Sheet
      title={existing ? `Edit “${existing.name}”` : "New assignment"}
      subtitle={
        !existing || existing.state === "draft"
          ? "Draft — nothing is published yet"
          : existing.state === "locked"
            ? "Expired — move the deadline forward to reopen"
            : "Live — changes apply when you save"
      }
      onClose={onDone}
      flush
      footer={
        <>
          {error ? (
            <span className="min-w-0 flex-1 text-xs text-danger">{error}</span>
          ) : (
            <span className="min-w-0 flex-1 text-xs text-fg-faint">
              {livePublished
                ? "The assignment is live — changes apply when you save"
                : "Saved as a draft until you publish"}
            </span>
          )}
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={submitDisabled} loading={save.isPending}>
            {save.isPending
              ? existing
                ? "Saving…"
                : "Creating…"
              : existing
                ? "Save changes"
                : "Create assignment"}
          </Button>
        </>
      }
    >
      {save.isPending && !existing ? <CreatingOverlay /> : null}
      <form
        id={formId}
        className="divide-y divide-line"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {/* --- Identity: name, source, protected files --- */}
        <div className={section}>
          <Field
            label="Name"
            placeholder="Lab 1 — Pointers"
            value={name}
            onChange={(e) => setName(e.target.value)}
            fullWidth
            required
            autoFocus={!existing}
          />
          <div className="flex items-end gap-2.5">
            {existing ? (
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <FieldLabel help="assignment-source">Source repository</FieldLabel>
                <span className="inline-flex h-8.5 items-center gap-1.5 text-sm text-fg-muted">
                  <GithubIcon className="size-4" /> {existing.sourceFullName.split("/")[1]}
                </span>
              </div>
            ) : (
              // Picking the repository pre-fills a humanized name
              // ("labo-02-quadratic" → "Labo 02 Quadratic") that stays editable.
              <div className="min-w-0 flex-1">
                <Select
                  label="Source repository"
                  help="assignment-source"
                  value={sourceRepo}
                  onChange={(e) => {
                    const next = e.target.value;
                    setName((n) => (n === "" || n === humanize(sourceRepo) ? humanize(next) : n));
                    setSourceRepo(next);
                  }}
                  required
                >
                  <option value="" disabled>
                    {repos.isLoading
                      ? "Loading…"
                      : repos.isError
                        ? "Repositories unavailable"
                        : repos.data?.length === 0
                          ? "No repository in this organization"
                          : "Pick a repository"}
                  </option>
                  {repos.data?.map((r) => (
                    <option key={r.name} value={r.name}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <Button
              type="button"
              variant="secondary"
              disabled={!tree.data}
              onClick={() => setShowFiles((v) => !v)}
              aria-expanded={showFiles}
            >
              <Lock /> Protect files
            </Button>
          </div>
          {repos.isError && !existing ? (
            <QueryError
              title="Could not list the organization's repositories"
              error={repos.error}
              onRetry={() => void repos.refetch()}
              retrying={repos.isFetching}
            />
          ) : repos.data?.length === 0 && !existing ? (
            <Alert tone="warning" title="This organization has no repository yet">
              Create the assignment's source repository on GitHub first, then come back here.
            </Alert>
          ) : null}
          {sourceRepo === "" ? (
            <p className="text-xs text-fg-faint">
              Pick a source repository to browse its files and protect some of them.
            </p>
          ) : tree.isFetching ? (
            <Progress label={`Exploring ${sourceRepo}…`} />
          ) : tree.isError ? (
            <QueryError
              title={`Could not read ${sourceRepo}`}
              error={tree.error}
              onRetry={() => void tree.refetch()}
              retrying={tree.isFetching}
            />
          ) : tree.data ? (
            <p className="flex items-center gap-1 text-xs text-fg-muted">
              {fileCount} file{fileCount === 1 ? "" : "s"} · {protectedFiles.size} protected —
              student changes to protected files are reverted
              <HelpIcon topic="protected-files" />
            </p>
          ) : null}
          {showFiles && tree.data ? (
            <div className={`${panel} space-y-2`}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone="zinc" icon={GitBranch}>
                  {tree.data.defaultBranch}
                </Badge>
                {tree.data.branches.length > 1 ? (
                  <span className="text-xs text-fg-muted">{tree.data.branches.length} branches</span>
                ) : null}
                <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-xs text-fg-faint">
                  <GitCommitHorizontal className="size-3.5" />
                  {tree.data.headSha.slice(0, 7)}
                  {tree.data.headDate ? ` · ${isoDateTime(tree.data.headDate)}` : ""}
                </span>
              </div>
              <div className="max-h-64 overflow-y-auto rounded-[10px] border border-line bg-surface p-2">
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
              {tree.data.truncated ? (
                <p className="text-xs text-fg-muted">Large repository — tree truncated.</p>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* --- Timing: publication mode, deadline shape, dates --- */}
        <div className={section}>
          <Eyebrow>Schedule</Eyebrow>
          <div className="divide-y divide-line">
            {!livePublished ? (
              <SettingRow
                title="Goes live"
                help="assignment-dates"
                desc={
                  publishMode === "manual"
                    ? "When you press Publish"
                    : "At the start date, automatically"
                }
                className="pt-0"
              >
                <Segmented
                  name="publish-mode"
                  value={publishMode}
                  onChange={setPublishMode}
                  options={[
                    { value: "manual", label: "Manually" },
                    { value: "scheduled", label: "On a date" },
                  ]}
                />
              </SettingRow>
            ) : (
              <SettingRow
                title="Start & deadline"
                help="assignment-dates"
                desc="The assignment is live — dates stay editable"
                className="pt-0"
              />
            )}
            {!livePublished && publishMode === "manual" ? (
              <SettingRow
                title="Deadline"
                desc={
                  deadlineKind === "date" ? "The same date for everyone" : "Counted from publication"
                }
              >
                <Segmented
                  name="deadline-kind"
                  value={deadlineKind}
                  onChange={setDeadlineKind}
                  options={[
                    { value: "date", label: "Fixed date" },
                    { value: "duration", label: "Duration" },
                  ]}
                />
              </SettingRow>
            ) : null}
          </div>
          {durationOnly ? (
            <div className={`${panel} flex flex-wrap items-center gap-2.5`}>
              <input
                type="number"
                min={0}
                max={400}
                className={cx(inputClass, inputSize.md, "w-16 shrink-0 px-1 text-center font-mono")}
                aria-label="Days"
                value={durationDays}
                onChange={(e) => setDurationDays(e.target.value)}
                required
              />
              <span className="text-sm text-fg-muted">days</span>
              <input
                type="number"
                min={0}
                max={23}
                className={cx(inputClass, inputSize.md, "w-16 shrink-0 px-1 text-center font-mono")}
                aria-label="Hours"
                value={durationHours}
                onChange={(e) => setDurationHours(e.target.value)}
                required
              />
              <span className="text-sm text-fg-muted">hours</span>
              <span
                className={cx(
                  "ml-auto text-sm",
                  durationMinutes < 15 ? "text-warning" : "text-fg-muted",
                )}
              >
                {durationMinutes < 15
                  ? "At least 15 minutes"
                  : `→ due ${compactDuration(durationMinutes * 60_000)} after you publish`}
              </span>
            </div>
          ) : (
            <div className={`${panel} space-y-3`}>
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
              <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                {rangeMode ? (
                  <Field
                    label={livePublished ? "Start time" : "Start time (auto-publish)"}
                    type="time"
                    width="w-32"
                    value={timeOf(startAt)}
                    disabled={startAt === ""}
                    onChange={(e) => setStartAt(`${startAt.slice(0, 10)}T${e.target.value}`)}
                    required
                  />
                ) : null}
                <Field
                  label="Deadline time"
                  type="time"
                  width="w-32"
                  value={timeOf(deadlineAt)}
                  disabled={deadlineAt === ""}
                  onChange={(e) => setDeadlineAt(`${deadlineAt.slice(0, 10)}T${e.target.value}`)}
                  required
                />
                {/* Its own line on a phone: squeezed beside the two time
                    fields this summary breaks one token per line. */}
                <p className="min-w-0 basis-full pb-2 text-[13px] sm:flex-1 sm:basis-auto sm:text-right">
                  {rangeInvalid ? (
                    <span className="text-warning">The deadline must come after the start.</span>
                  ) : missingWhen ? (
                    <span className="text-fg-faint">
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
                    <span className="text-fg-muted">
                      {isoDateTime(toIso(startAt))} → {isoDateTime(toIso(deadlineAt))}
                      {" · "}
                      {compactDuration(new Date(deadlineAt).getTime() - new Date(startAt).getTime())}
                    </span>
                  ) : (
                    <span className="text-fg-muted">Deadline {isoDateTime(toIso(deadlineAt))}</span>
                  )}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* --- Repository setup --- */}
        <div className={section}>
          <Eyebrow>Repository setup</Eyebrow>
          <div className="divide-y divide-line">
            {!existing ? (
              <SettingRow
                title="Students receive"
                help="distributed-source"
                desc={
                  sourceStrategy === "squash"
                    ? "Your commit history stays private"
                    : "The full history is distributed as is"
                }
                className="pt-0"
              >
                <Segmented
                  name="source-strategy"
                  value={sourceStrategy}
                  onChange={setSourceStrategy}
                  options={[
                    { value: "squash", label: "One commit" },
                    { value: "whole", label: "Full history" },
                  ]}
                />
              </SettingRow>
            ) : null}
            {!existing && sourceStrategy === "squash" && (tree.data?.branches.length ?? 0) > 1 ? (
              <SettingRow title="Branch to squash" help="squash-branch">
                <Select value={branch} onChange={(e) => setBranch(e.target.value)} width="w-44">
                  {tree.data!.branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </Select>
              </SettingRow>
            ) : null}
            <SettingRow
              title="Grading"
              desc={gradingMode === "auto" ? "Points and a final review" : "Students see no grades"}
              className={existing ? "pt-0" : ""}
            >
              <Segmented
                name="grading-mode"
                value={gradingMode}
                onChange={setGradingMode}
                options={[
                  { value: "auto", label: "Automatic" },
                  { value: "none", label: "No grades" },
                ]}
              />
            </SettingRow>
            <SettingRow
              title="At the deadline"
              help="deadline-strategy"
              desc={
                deadlineStrategy === "lock"
                  ? "Pushes blocked, repository read-only"
                  : "A marker commit; late pushes stay visible"
              }
              className="pb-0"
            >
              <Tip label={livePublished ? "The deadline strategy is fixed at publication" : null}>
                <Segmented
                  name="deadline-strategy"
                  value={deadlineStrategy}
                  onChange={setDeadlineStrategy}
                  disabled={livePublished}
                  options={[
                    { value: "lock", label: "Lock" },
                    { value: "commit", label: "Mark and allow" },
                  ]}
                />
              </Tip>
            </SettingRow>
          </div>
        </div>

        {/* --- Work mode: online workspace (ADR-013, granted teachers only)
                and group work (issue #2, every teacher) --- */}
        <div className={section}>
          <Eyebrow>Work mode</Eyebrow>
          <div className="divide-y divide-line">
            {canOnline ? (
              <SettingRow title="Students work" desc={WORK_MODE_DESC[workMode]} className="pt-0">
                <Tip
                  label={
                    onlineLocked
                      ? "A published online assignment cannot go back to Free: its repositories were provisioned without write access"
                      : null
                  }
                >
                  <Segmented
                    name="work-mode"
                    value={workMode}
                    onChange={(m) => {
                      setWorkMode(m);
                      // Online and SEB sessions are per student: group work
                      // cannot survive the switch, so it goes off with it.
                      if (m !== "free") setGroupMode(false);
                    }}
                    options={workModeOptions}
                  />
                </Tip>
              </SettingRow>
            ) : null}
            {/* Group work belongs to the free mode only; in an online or SEB
                assignment the row would offer something the server refuses. */}
            {workMode === "free" ? (
              <SettingRow
                title="Group work"
                desc={
                  groupLocked
                    ? "Fixed at publication — the repositories already exist"
                    : groupMode
                      ? "One repository per group; you form the groups on their own screen"
                      : "One repository per student"
                }
                className={canOnline ? "" : "pt-0"}
              >
                <Tip
                  label={
                    groupLocked
                      ? "Group work can only be turned on or off while the assignment is a draft"
                      : null
                  }
                >
                  <Switch
                    label="Group work"
                    checked={groupMode}
                    disabled={groupLocked}
                    onChange={setGroupMode}
                  />
                </Tip>
              </SettingRow>
            ) : null}
          </div>
          {maxSizeShown ? (
            <div className={`${panel} flex flex-wrap items-end gap-x-4 gap-y-2`}>
              <Field
                label="Max group size"
                type="number"
                min={1}
                max={50}
                width="w-36"
                placeholder="no limit"
                value={groupMaxSize}
                onChange={(e) => setGroupMaxSize(e.target.value)}
              />
              <p
                className={cx(
                  "min-w-0 flex-1 pb-2 text-[13px]",
                  maxSizeValid ? "text-fg-muted" : "text-warning",
                )}
              >
                {maxSizeValid
                  ? "A hint, not a rule: a larger group only shows a warning on the groups screen."
                  : "Between 1 and 50, or leave it empty."}
              </p>
            </div>
          ) : null}
          {canOnline && onlineMode ? (
              <div className={`${panel} space-y-3`}>
                <Field
                  label="Container image"
                  hint="optional"
                  placeholder="default image"
                  value={codespaceImage}
                  onChange={(e) => setCodespaceImage(e.target.value)}
                  fullWidth
                />
                <p className="text-xs text-fg-muted">
                  Image name from the portal catalogue — leave empty for the portal's default
                  image.
                </p>
                {workMode === "online_seb" ? (
                  <div className="space-y-1.5">
                    <Textarea
                      label="Browser Exam Keys, one per line"
                      rows={3}
                      spellCheck={false}
                      className="font-mono text-xs"
                      placeholder="64 hexadecimal characters per key"
                      value={examKeys}
                      onChange={(e) => setExamKeys(e.target.value)}
                    />
                    <p className={cx("text-xs", keysValid ? "text-fg-muted" : "text-warning")}>
                      {keysValid
                        ? `${keys.length} key${keys.length === 1 ? "" : "s"} — one per Safe Exam Browser platform/version`
                        : "Each key is exactly 64 hexadecimal characters"}
                    </p>
                  </div>
                ) : null}
              </div>
          ) : null}
        </div>

        {/* --- Milestones (creation only, graded assignments) --- */}
        {!existing && gradingMode === "auto" ? (
          <div className={section}>
            <Eyebrow
              trailing={
                <span className="font-mono text-[11px] text-fg-faint">criteria tagged milestone:</span>
              }
            >
              Milestones — optional intermediate reviews
            </Eyebrow>
            {milestones.map((m, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <input
                  className={cx(inputClass, inputSize.md, "min-w-40 flex-1 font-mono")}
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
                  className={cx(inputClass, inputSize.md, "w-16 shrink-0 px-1 text-center font-mono")}
                  aria-label="Days before the deadline"
                  value={m.days}
                  onChange={(e) =>
                    setMilestones((rows) =>
                      rows.map((r, j) => (j === i ? { ...r, days: e.target.value } : r)),
                    )
                  }
                  required
                />
                <span className="whitespace-nowrap text-[13px] text-fg-muted">
                  days before
                  {milestoneDate(m.days) ? ` → ${milestoneDate(m.days)}` : ""}
                </span>
                <IconButton
                  label="Remove milestone"
                  type="button"
                  onClick={() => setMilestones((rows) => rows.filter((_, j) => j !== i))}
                >
                  <Trash2 />
                </IconButton>
                {m.name !== "" && !milestoneName.test(m.name) ? (
                  <span className="w-full text-xs text-warning">
                    lowercase letters, digits, - and _
                  </span>
                ) : null}
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setMilestones((rows) => [...rows, { name: "", days: "7" }])}
            >
              <Plus /> Add milestone
            </Button>
          </div>
        ) : null}

        {existing?.state === "locked" ? (
          <div className="px-6 py-5">
            <Alert tone="warning" title="This assignment has expired">
              Saving a deadline in the future <b>reopens</b> it: repositories are unlocked,
              students can push again, and the grade freezes anew at the new deadline (the
              previous frozen grade and LLM review are discarded).
            </Alert>
          </div>
        ) : null}
      </form>
    </Sheet>
  );
}
