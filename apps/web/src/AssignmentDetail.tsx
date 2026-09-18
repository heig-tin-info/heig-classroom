import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Download,
  FileCode,
  GitPullRequest,
  History,
  Lock,
  LockOpen,
  Loader2,
  Milestone as MilestoneIcon,
  MonitorPlay,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Snowflake,
  Trash2,
  UserCheck,
  Users,
  XCircle,
} from "lucide-react";
import { useState } from "react";

import type {
  AssignmentDetailPayload,
  AssignmentDetailStudent,
  AssignmentMilestone,
  ClassroomDetail,
  GradeView,
} from "@hgc/contracts";
import { finalPoints, resolveFinalGrade } from "@hgc/domain";

import { ActivityPanel } from "./activity/ActivityPanel";
import { api, ApiError } from "./api";
import { compactDuration } from "./AssignmentForm";
import { Breadcrumb } from "./Breadcrumb";
import { buildCloneScript, cloneScriptFileName } from "./cloneScript";
import { useConfirm } from "./confirm";
import { GradeHistoryModal } from "./GradeHistoryModal";
import { fuzzyFilter } from "./fuzzy";
import { formatDuration, useT } from "./i18n";
import type { Route } from "./router";
import {
  Alert,
  Badge,
  Button,
  Card,
  cx,
  Field,
  GithubIcon,
  IconButton,
  isoDateTime,
  Menu,
  Modal,
  PageHeader,
  SearchInput,
  SectionHeading,
  Select,
  Skeleton,
  SortHeader,
  Spinner,
  Stat,
  T,
  Textarea,
  Tip,
  useNow,
  useSortableTable,
} from "./ui";

function CiBadge({ s, tests }: { s: AssignmentDetailStudent["repo"]; tests?: GradeView | null }) {
  // Real test counters (TESTS annotation, score ≥ 0.7.2) beat check-run
  // counts: "2/10 tests" says more than "pass 1/1".
  if (tests?.testsTotal) {
    const p = tests.testsPassed ?? 0;
    const t = tests.testsTotal;
    return (
      <Badge
        tone={p === t ? "green" : p === 0 ? "red" : "amber"}
        icon={p === t ? CheckCircle2 : XCircle}
      >
        {p}/{t} tests
      </Badge>
    );
  }
  if (!s || s.ciStatus === "none") return <span className="text-fg-faint">—</span>;
  const checks =
    s.checksPassed !== null && s.checksTotal !== null ? ` ${s.checksPassed}/${s.checksTotal}` : "";
  if (s.ciStatus === "pass")
    return (
      <Badge tone="green" icon={CheckCircle2}>
        pass{checks}
      </Badge>
    );
  if (s.ciStatus === "fail")
    return (
      <Badge tone="red" icon={XCircle}>
        fail{checks}
      </Badge>
    );
  return (
    <Badge tone="amber" icon={Clock}>
      running
    </Badge>
  );
}

/** Plain mark (e.g. "4.5"): the number is the information, no badge chrome. */
function GradeText({ grade, frozen }: { grade: GradeView | null; frozen: boolean }) {
  if (!grade) return <span className="text-fg-faint">—</span>;
  if (grade.parseStatus === "ok" && grade.points !== null) {
    return (
      <span className="inline-flex items-center gap-1 font-semibold tabular-nums">
        {grade.points.toFixed(1)}
        {frozen ? <Snowflake className="size-3 text-fg-faint" /> : null}
      </span>
    );
  }
  if (grade.parseStatus === "fallback") return <span className="text-fg-faint">—</span>;
  return (
    <Badge tone="amber" icon={AlertTriangle}>
      {grade.parseStatus === "multiple" ? "multiple GRADE" : grade.parseStatus.replace("_", " ")}
    </Badge>
  );
}

/** Validation flow: teacher override of one student's reviewed grade. */
function GradeOverrideModal({
  classroomId,
  assignmentId,
  repo,
  student,
  onClose,
}: {
  classroomId: string;
  assignmentId: string;
  repo: NonNullable<AssignmentDetailStudent["repo"]>;
  student: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  // Pre-fill with the grade the override replaces: LLM, else frozen CI.
  const suggested = repo.llmGrade?.points ?? repo.frozenGrade?.points ?? repo.grade?.points;
  const [points, setPoints] = useState(
    repo.teacherPoints != null
      ? String(repo.teacherPoints)
      : suggested != null
        ? String(suggested)
        : "",
  );
  const [comment, setComment] = useState(repo.teacherComment ?? "");
  const save = useMutation({
    mutationFn: (payload: { points: number | null; comment?: string | null }) =>
      api(`/app/api/classrooms/${classroomId}/assignments/${assignmentId}/repos/${repo.id}/grade`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["assignment-detail", assignmentId] });
      onClose();
    },
  });
  const parsed = Number.parseFloat(points);
  return (
    <Modal
      title="Adjust grade"
      subtitle={student}
      size="sm"
      onClose={onClose}
      footer={
        <>
          {save.isError ? (
            <span className="min-w-0 flex-1 text-sm text-danger">
              {save.error instanceof ApiError ? save.error.message : "Request failed"}
            </span>
          ) : null}
          {repo.teacherPoints != null ? (
            <Button variant="ghost" onClick={() => save.mutate({ points: null })} disabled={save.isPending}>
              Remove adjustment
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate({ points: parsed, comment: comment || null })}
            disabled={Number.isNaN(parsed) || parsed < 0}
            loading={save.isPending}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Points"
          hint={suggested != null ? `review grade ${suggested.toFixed(1)}` : "no review grade yet"}
          type="number"
          step={0.1}
          min={0}
          value={points}
          onChange={(e) => setPoints(e.target.value)}
          fullWidth
          required
          autoFocus
        />
        <Textarea
          label="Comment (optional)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={2000}
        />
      </div>
    </Modal>
  );
}

function StudentRow({
  classroomId,
  assignmentId,
  frozen,
  showGrades,
  canAdjust,
  s,
}: {
  classroomId: string;
  assignmentId: string;
  /** Deadline enforced (state locked): the displayed grade is the frozen one. */
  frozen: boolean;
  /** Grading mode `none` hides the grade column and the grade-now action. */
  showGrades: boolean;
  /** Validation flow: adjustments open once the grade is frozen. */
  canAdjust: boolean;
  s: AssignmentDetailStudent;
}) {
  const t = useT();
  const [showHistory, setShowHistory] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["assignment-detail", assignmentId] });
  const toggleLock = useMutation({
    mutationFn: (action: "lock" | "unlock") =>
      api(
        `/app/api/classrooms/${classroomId}/assignments/${assignmentId}/repos/${s.repo!.id}/${action}`,
        { method: "POST" },
      ),
    onSuccess: invalidate,
  });
  const gradeNow = useMutation({
    mutationFn: () =>
      api(
        `/app/api/classrooms/${classroomId}/assignments/${assignmentId}/repos/${s.repo!.id}/grade-now`,
        { method: "POST" },
      ),
  });
  const gradeNowError =
    gradeNow.isError && gradeNow.error instanceof ApiError && gradeNow.error.status === 409;

  const r = s.repo;
  const locked = r?.lockedAt != null;
  const canExpand = r?.provisionStatus === "ok";
  const name = `${s.prenom} ${s.nom}`.trim();
  return (
    <>
      <tr
        onClick={() => canExpand && setExpanded((e) => !e)}
        className={cx(T.row, T.rowHover, canExpand && "cursor-pointer", locked && "opacity-60")}
      >
        <td className={`${T.td} font-semibold`}>
          <span className="inline-flex items-center gap-1.5">
            {canExpand ? (
              expanded ? (
                <ChevronDown className="size-3.5 shrink-0 text-fg-faint" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-fg-faint" />
              )
            ) : (
              <span className="w-3.5" />
            )}
            {name}
            {r?.provisionStatus === "ok" && r.fullName ? (
              <Tip label={`${s.githubLogin ?? ""} · ${r.fullName}`}>
                <a
                  href={`https://github.com/${r.fullName}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Open ${r.fullName} on GitHub`}
                  className="ml-1 rounded-full p-1 text-fg-faint transition-colors hover:bg-surface-3 hover:text-fg"
                >
                  <GithubIcon className="size-3.5" />
                </a>
              </Tip>
            ) : s.githubLogin ? (
              <span className="ml-1 inline-flex items-center gap-1 text-xs font-normal text-fg-faint">
                <GithubIcon className="size-3" /> {s.githubLogin}
              </span>
            ) : null}
          </span>
        </td>
        <td className={T.td}>
          {r?.provisionStatus === "ok" ? (
            /* Repository gone from GitHub (deleted out of band, or unreachable
               live): one state, shown instead of the acceptance badge. */
            r.missing ? (
              <Badge tone="red" icon={XCircle}>
                {t("status.repoMissing")}
              </Badge>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <Badge tone="green" icon={CheckCircle2}>
                  {t("status.accepted")}
                </Badge>
                {r.syncPr && r.fullName ? (
                  <Tip label={`Sync pull request #${r.syncPr.number}`}>
                    <a
                      href={`https://github.com/${r.fullName}/pull/${r.syncPr.number}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Sync pull request #${r.syncPr.number}`}
                    >
                      <Badge
                        tone={
                          r.syncPr.state === "merged"
                            ? "green"
                            : r.syncPr.state === "open"
                              ? "amber"
                              : "zinc"
                        }
                        icon={GitPullRequest}
                      >
                        {r.syncPr.state === "merged"
                          ? "synced"
                          : r.syncPr.state === "open"
                            ? `sync PR #${r.syncPr.number}`
                            : "sync PR closed"}
                      </Badge>
                    </a>
                  </Tip>
                ) : null}
              </span>
            )
          ) : r?.provisionStatus === "error" ? (
            <Tip label={r.provisionError} className="inline-flex cursor-help">
              <Badge tone="red" icon={XCircle}>
                {t("status.provisionError")}
              </Badge>
            </Tip>
          ) : s.claimStatus === "claimed" ? (
            <Badge tone="amber" icon={Clock}>
              {t("status.notAccepted")}
            </Badge>
          ) : (
            <Badge tone="zinc">{t("status.notClaimed")}</Badge>
          )}
        </td>
        <td className={`${T.td} whitespace-nowrap`}>
          {r?.lastCommitSha ? (
            <span className="flex flex-col leading-tight">
              <Tip label={r.lastCommitSha}>
                <span className="font-mono text-xs">{r.lastCommitSha.slice(0, 7)}</span>
              </Tip>
              <span className="text-xs text-fg-muted">
                {r.lastCommitAt ? isoDateTime(r.lastCommitAt) : ""}
              </span>
            </span>
          ) : (
            <span className="text-fg-faint">—</span>
          )}
        </td>
        <td className={`${T.td} text-right tabular-nums`}>
          {r?.commitCount ?? <span className="text-fg-faint">—</span>}
        </td>
        <td className={T.td}>
          <CiBadge s={r} tests={frozen ? (r?.frozenGrade ?? r?.grade) : r?.grade} />
        </td>
        {showGrades ? (
          <td className={`${T.td} whitespace-nowrap`}>
            <span className="inline-flex items-center gap-1">
              {/* Validation flow: the teacher's adjustment IS the final grade. */}
              {r?.teacherPoints != null ? (
                <Tip
                  label={`Adjusted by the teacher${r.teacherComment ? ` — ${r.teacherComment}` : ""} (review was ${
                    (r.llmGrade?.points ?? r.frozenGrade?.points)?.toFixed(1) ?? "—"
                  })`}
                >
                  <span className="inline-flex items-center gap-1 font-semibold tabular-nums text-success">
                    <UserCheck className="size-3.5" />
                    {r.teacherPoints.toFixed(1)}
                  </span>
                </Tip>
              ) : /* GR-16: the authoritative LLM review, once landed, IS the grade;
                    until then the frozen CI grade shows with a pending marker. */
              r?.llmGrade && r.llmGrade.parseStatus === "ok" ? (
                <Tip
                  label={`LLM review — CI grade was ${
                    r.frozenGrade?.points != null ? r.frozenGrade.points.toFixed(1) : "—"
                  }`}
                >
                  <span className="inline-flex items-center gap-1 font-semibold tabular-nums">
                    <Bot className="size-3.5 text-accent" />
                    {r.llmGrade.points!.toFixed(1)}
                  </span>
                </Tip>
              ) : (
                <>
                  <GradeText grade={frozen ? (r?.frozenGrade ?? null) : (r?.grade ?? null)} frozen={frozen} />
                  {frozen && r?.frozenGrade ? (
                    <Tip label="LLM review pending">
                      <Bot className="size-3.5 animate-pulse text-warning" />
                    </Tip>
                  ) : null}
                </>
              )}
              {r?.provisionStatus === "ok" ? (
                <span className="ml-1 inline-flex" onClick={(e) => e.stopPropagation()}>
                  <IconButton size="sm" label="Grade history" onClick={() => setShowHistory(true)}>
                    <History />
                  </IconButton>
                  {canAdjust ? (
                    <IconButton size="sm" label="Adjust grade" onClick={() => setAdjusting(true)}>
                      <Pencil />
                    </IconButton>
                  ) : null}
                </span>
              ) : null}
            </span>
            {showHistory && r ? (
              <GradeHistoryModal
                classroomId={classroomId}
                assignmentId={assignmentId}
                repoId={r.id}
                fullName={r.fullName}
                student={name}
                onClose={() => setShowHistory(false)}
              />
            ) : null}
            {adjusting && r ? (
              <GradeOverrideModal
                classroomId={classroomId}
                assignmentId={assignmentId}
                repo={r}
                student={name}
                onClose={() => setAdjusting(false)}
              />
            ) : null}
          </td>
        ) : null}
        <td className={`${T.td} whitespace-nowrap text-right`}>
          {r?.provisionStatus === "ok" && r.fullName ? (
            <span className="inline-flex items-center" onClick={(e) => e.stopPropagation()}>
              {showGrades ? (
                <Tip
                  label={
                    gradeNowError
                      ? t("assignment.gradeNowUnsupported")
                      : gradeNow.isSuccess
                        ? t("assignment.gradeNowStarted")
                        : t("assignment.gradeNow")
                  }
                >
                  <button
                    type="button"
                    aria-label={t("assignment.gradeNow")}
                    onClick={() => gradeNow.mutate()}
                    disabled={gradeNow.isPending || locked}
                    className={cx(
                      "inline-flex size-8 items-center justify-center rounded-full transition-colors disabled:pointer-events-none disabled:opacity-40",
                      gradeNowError
                        ? "text-warning"
                        : gradeNow.isSuccess
                          ? "text-success"
                          : "text-fg-faint hover:bg-surface-2 hover:text-fg",
                    )}
                  >
                    {gradeNow.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : gradeNowError ? (
                      <AlertTriangle className="size-4" />
                    ) : gradeNow.isSuccess ? (
                      <CheckCircle2 className="size-4" />
                    ) : (
                      <Play className="size-4" />
                    )}
                  </button>
                </Tip>
              ) : null}
              {/* Padlock shows the STATE: closed red when locked, open otherwise. */}
              <Tip label={locked ? t("assignment.unlockRepo") : t("assignment.lockRepo")}>
                <button
                  type="button"
                  aria-label={locked ? t("assignment.unlockRepo") : t("assignment.lockRepo")}
                  onClick={() => toggleLock.mutate(locked ? "unlock" : "lock")}
                  disabled={toggleLock.isPending}
                  className={cx(
                    "inline-flex size-8 items-center justify-center rounded-full transition-colors disabled:pointer-events-none",
                    locked ? "text-danger hover:bg-danger-soft" : "text-fg-faint hover:bg-surface-2 hover:text-fg",
                  )}
                >
                  {toggleLock.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : locked ? (
                    <Lock className="size-4" />
                  ) : (
                    <LockOpen className="size-4" />
                  )}
                </button>
              </Tip>
            </span>
          ) : null}
        </td>
      </tr>
      {expanded && r ? (
        <tr className="border-t border-line bg-surface-2/50">
          <td colSpan={showGrades ? 7 : 6} className="p-0">
            <ActivityPanel
              classroomId={classroomId}
              assignmentId={assignmentId}
              repoId={r.id}
              fullName={r.fullName}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * GH-50: the source moved ahead of what students received. The teacher
 * triggers the propagation explicitly; the bot opens one PR per repository.
 */
function SyncBanner({
  classroomId,
  a,
}: {
  classroomId: string;
  a: AssignmentDetailPayload["assignment"];
}) {
  const sync = useMutation({
    mutationFn: () =>
      api(`/app/api/classrooms/${classroomId}/assignments/${a.id}/sync`, { method: "POST" }),
  });
  const ahead =
    a.sourcePushedAt !== null &&
    (a.syncedAt === null || new Date(a.sourcePushedAt) > new Date(a.syncedAt));
  const syncing = sync.isSuccess && !ahead ? false : sync.isSuccess;
  if (!ahead && !syncing) return null;
  return (
    <Alert
      tone="warning"
      icon={GitPullRequest}
      title="The source repository has new commits"
      action={
        <Button size="sm" variant="secondary" onClick={() => sync.mutate()} disabled={syncing} loading={sync.isPending}>
          <GitPullRequest /> {sync.isPending || syncing ? "Syncing…" : "Sync student repositories"}
        </Button>
      }
    >
      {a.sourceAheadSha ? (
        <code className="mr-1 font-mono text-xs">{a.sourceAheadSha.slice(0, 7)}</code>
      ) : null}
      Syncing opens a pull request on each student repository; students merge it themselves.
    </Alert>
  );
}

/**
 * ADR-013: an online assignment lives in the codespace portal too. The portal
 * is told about it by a pg-boss job, so the state here is "last successful
 * push, or the error of the last attempt"; Resync re-queues the job.
 */
function CodespaceBanner({
  classroomId,
  a,
}: {
  classroomId: string;
  a: AssignmentDetailPayload["assignment"];
}) {
  const resync = useMutation({
    mutationFn: () =>
      api(`/app/api/classrooms/${classroomId}/assignments/${a.id}/codespace-sync`, {
        method: "POST",
      }),
  });
  if (a.workMode === "free") return null;
  const failed = a.codespaceSyncError !== null;
  return (
    <Alert
      tone={failed ? "danger" : "neutral"}
      icon={MonitorPlay}
      title={a.workMode === "online_seb" ? "Online workspace, SEB only" : "Online workspace"}
      action={
        <Button
          size="sm"
          variant="secondary"
          onClick={() => resync.mutate()}
          disabled={resync.isSuccess}
          loading={resync.isPending}
        >
          <RefreshCw /> {resync.isSuccess ? "Resync queued" : "Resync"}
        </Button>
      }
    >
      {a.codespaceImage ? (
        <code className="mr-1 font-mono text-xs">{a.codespaceImage}</code>
      ) : (
        <span className="mr-1">default image</span>
      )}
      ·{" "}
      {failed
        ? a.codespaceSyncError
        : a.codespaceSyncedAt
          ? `synced with the portal at ${isoDateTime(a.codespaceSyncedAt)}`
          : "never synced with the portal yet"}
    </Alert>
  );
}

/**
 * Intermediate review checkpoints: at each milestone's date the platform
 * fires one `grade-milestone` review per repository; the criteria tagged
 * `milestone: <name>` in criteria.yml are the graded subset (the grading
 * scale stays out of the platform). Dates show absolute and J±n side by side,
 * counted from the deadline.
 */
function MilestonesSection({
  classroomId,
  assignmentId,
  deadlineAt,
}: {
  classroomId: string;
  assignmentId: string;
  deadlineAt: string;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const base = `/app/api/classrooms/${classroomId}/assignments/${assignmentId}/milestones`;
  const milestones = useQuery<AssignmentMilestone[]>({
    queryKey: ["milestones", assignmentId],
    queryFn: () => api(base),
  });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"offset" | "date">("offset");
  // Authored as "n days before the deadline" (J−n), sent as offsetDays = -n.
  const [offset, setOffset] = useState("7");
  const [date, setDate] = useState("");
  const invalidate = () => qc.invalidateQueries({ queryKey: ["milestones", assignmentId] });
  const create = useMutation({
    mutationFn: () =>
      api(base, {
        method: "POST",
        body: JSON.stringify(
          mode === "offset"
            ? { name: name.trim(), offsetDays: -Math.abs(Number(offset)) }
            : { name: name.trim(), dueAt: new Date(date).toISOString() },
        ),
      }),
    onSuccess: () => {
      setName("");
      setAdding(false);
      void invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (mid: string) => api(`${base}/${mid}`, { method: "DELETE" }),
    onSuccess: () => void invalidate(),
  });
  const jLabel = (dueAt: string) => {
    const days = Math.round(
      (new Date(dueAt).getTime() - new Date(deadlineAt).getTime()) / 86_400_000,
    );
    return days === 0 ? "J" : days < 0 ? `J−${-days}` : `J+${days}`;
  };
  const rows = milestones.data ?? [];
  const canSubmit =
    name.trim() !== "" && (mode === "offset" ? offset.trim() !== "" : date !== "");

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 px-5 py-3.5">
        <SectionHeading
          icon={MilestoneIcon}
          title="Milestones"
          count={rows.length}
          description={
            <>
              Intermediate LLM reviews of the criteria tagged{" "}
              <code className="font-mono text-xs">milestone: &lt;name&gt;</code>
            </>
          }
        />
        <span className="flex-1" />
        {!adding ? (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            <Plus /> Add milestone
          </Button>
        ) : null}
      </div>

      {rows.length === 0 && !adding ? (
        <p className="border-t border-line px-5 py-3 text-[13px] text-fg-muted">
          No milestones — the only review happens at the deadline.
        </p>
      ) : rows.length ? (
        <ul className="divide-y divide-line border-t border-line">
          {rows.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-[13px]">
              <span className="font-mono font-medium">{m.name}</span>
              <span className="inline-flex items-center gap-1 text-fg-muted">
                <CalendarClock className="size-3.5 text-fg-faint" />
                {isoDateTime(m.dueAt)}
              </span>
              <Badge tone="zinc">{jLabel(m.dueAt)}</Badge>
              {m.dispatchedAt ? (
                <Badge tone="green" icon={CheckCircle2}>
                  review sent
                </Badge>
              ) : (
                <Badge tone="amber" icon={Clock}>
                  scheduled
                </Badge>
              )}
              <span className="flex-1" />
              <IconButton
                size="sm"
                danger
                label={`Delete milestone ${m.name}`}
                disabled={remove.isPending}
                onClick={async () => {
                  if (await confirm({ title: `Delete milestone “${m.name}”?`, confirmLabel: "Delete", danger: true })) {
                    remove.mutate(m.id);
                  }
                }}
              >
                <Trash2 />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : null}

      {adding ? (
        <form
          className="flex flex-wrap items-end gap-3 border-t border-line bg-surface-2/50 px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) create.mutate();
          }}
        >
          <Field
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="mid-review"
            pattern="[a-z0-9][a-z0-9_-]*"
            title="lowercase letters, digits, - and _"
            className="w-44 font-mono"
            required
            autoFocus
          />
          <Select label="When" value={mode} onChange={(e) => setMode(e.target.value as "offset" | "date")} className="w-44">
            <option value="offset">J−n before deadline</option>
            <option value="date">Exact date</option>
          </Select>
          {mode === "offset" ? (
            <Field
              label="Days before deadline"
              type="number"
              min={1}
              max={365}
              value={offset}
              onChange={(e) => setOffset(e.target.value)}
              className="w-24"
              required
            />
          ) : (
            <Field
              label="Date"
              type="datetime-local"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          )}
          <Button type="submit" disabled={!canSubmit} loading={create.isPending}>
            <Plus /> Add
          </Button>
          <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
          {create.isError ? (
            <span className="w-full text-sm text-danger">
              {create.error instanceof ApiError &&
              typeof (create.error.body as { message?: unknown })?.message === "string"
                ? ((create.error.body as { message: string }).message)
                : "Could not add the milestone"}
            </span>
          ) : null}
        </form>
      ) : null}
    </Card>
  );
}

/**
 * Where the authoritative LLM review stands: counting down to deadline +
 * grace, then "running" until every provisioned repo carries its llm grade,
 * then "reviewed". Nothing before the deadline is enforced.
 */
function reviewStatus(
  a: AssignmentDetailPayload["assignment"],
  students: AssignmentDetailStudent[],
  now: number,
  t: ReturnType<typeof useT>,
): { label: string; hint: string; tone: "green" | "amber" | "zinc" } {
  const repos = students.filter((s) => s.repo?.provisionStatus === "ok");
  if (a.state !== "locked" || repos.length === 0) {
    return { label: "at the deadline", hint: `${a.graceMinutes} min grace, then the full review`, tone: "zinc" };
  }
  const reviewAt = new Date(a.deadlineAt).getTime() + a.graceMinutes * 60_000;
  if (repos.every((s) => s.repo!.llmGrade)) {
    return { label: "reviewed", hint: "every repository carries its LLM grade", tone: "green" };
  }
  if (now < reviewAt) {
    return { label: `in ${formatDuration(reviewAt - now, t)}`, hint: "fires once the grace period ends", tone: "amber" };
  }
  return { label: "running…", hint: "grades land as the runs complete", tone: "amber" };
}

type SortKey = "name" | "lastCommitAt" | "commitCount" | "grade" | "status";

export function AssignmentDetail({
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
  const now = useNow(15_000);
  const [query, setQuery] = useState("");
  const room = useQuery<ClassroomDetail>({
    queryKey: ["classroom", classroomId],
    queryFn: () => api(`/app/api/classrooms/${classroomId}`),
  });
  const detail = useQuery<AssignmentDetailPayload>({
    queryKey: ["assignment-detail", assignmentId],
    queryFn: () =>
      api(`/app/api/classrooms/${classroomId}/assignments/${assignmentId}/detail`),
  });
  const validate = useMutation({
    mutationFn: () =>
      api(`/app/api/classrooms/${classroomId}/assignments/${assignmentId}/validate-grades`, {
        method: "POST",
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["assignment-detail", assignmentId] }),
  });

  const rank = (s: AssignmentDetailStudent, key: SortKey): string | number => {
    switch (key) {
      case "name":
        return `${s.nom} ${s.prenom}`;
      case "lastCommitAt":
        return s.repo?.lastCommitAt ?? "";
      case "commitCount":
        return s.repo?.commitCount ?? -1;
      case "grade":
        return s.repo ? (finalPoints(s.repo) ?? -1) : -1;
      case "status":
        return s.repo?.provisionStatus === "ok" ? 2 : s.claimStatus === "claimed" ? 1 : 0;
    }
  };
  const students = detail.data?.students ?? [];
  const shown = fuzzyFilter(
    query,
    students,
    (s) => `${s.nom} ${s.prenom} ${s.githubLogin ?? ""} ${s.email}`,
  );
  const { sorted, sort, toggle } = useSortableTable(shown, rank, { key: "name", dir: 1 });

  const crumbs = (
    <Breadcrumb
      items={[
        { label: t("nav.classrooms"), onClick: () => navigate({ view: "home" }) },
        {
          label: room.data?.name ?? "…",
          onClick: () => navigate({ view: "classroom", id: classroomId }),
        },
        { label: t("nav.assignment") },
      ]}
    />
  );

  if (detail.isLoading) {
    return (
      <div className="space-y-6">
        {crumbs}
        <Skeleton className="h-8 w-80" />
        <Spinner className="py-16" label="Fetching repository states from GitHub…" />
      </div>
    );
  }
  if (!detail.data) return null;
  const a = detail.data.assignment;
  const accepted = students.filter((s) => s.repo?.provisionStatus === "ok").length;
  const passing = students.filter((s) => s.repo?.ciStatus === "pass").length;
  const graded = students
    .map((s) => (s.repo ? finalPoints(s.repo) : null))
    .filter((p): p is number => p != null);
  const average = graded.length ? graded.reduce((x, y) => x + y, 0) / graded.length : null;
  // Grading mode `none`: no grades, no review countdown, no milestones.
  const showGrades = a.gradingMode !== "none";
  // Validation flow: adjust/validate once the grade is frozen (deadline+grace).
  const canAdjust = showGrades && a.frozenAt != null;
  const review = reviewStatus(a, students, now, t);
  const deadlineMs = new Date(a.deadlineAt).getTime() - now;

  // Grades sheet (last name, first name, email, grade) -- final grade rule: @hgc/domain.
  const exportGrades = async () => {
    const XLSX = await import("xlsx");
    const rows = students.map((s) => {
      const final = s.repo ? resolveFinalGrade(s.repo) : null;
      return {
        Nom: s.nom,
        "Prénom": s.prenom,
        Email: s.email,
        Note: final?.points ?? "",
        Source: final?.source ?? "",
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Notes");
    XLSX.writeFile(wb, `${a.name} — notes.xlsx`);
  };

  // Clone script (issue #3): one bash file for the whole assignment, built
  // from the repositories this page already knows about — no server round
  // trip, no `gh` dependency.
  const downloadCloneScript = () => {
    const repos = students
      .map((s) => s.repo)
      .filter((r) => r != null && r.provisionStatus === "ok" && r.fullName != null && !r.missing)
      .map((r) => r!.fullName!);
    const script = buildCloneScript({
      assignmentName: a.name,
      slug: a.slug,
      classroomName: a.classroom,
      repos,
      generatedAt: new Date(),
    });
    const url = URL.createObjectURL(new Blob([script], { type: "text/x-shellscript" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = cloneScriptFileName(a.slug);
    link.click();
    URL.revokeObjectURL(url);
  };

  // Search already sorts by relevance.
  const rows = query.trim() !== "" ? shown : sorted;

  const Th = ({ k, children, right }: { k: SortKey; children: React.ReactNode; right?: boolean }) => (
    <SortHeader k={k} sort={sort} onToggle={toggle} right={right}>
      {children}
    </SortHeader>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={crumbs}
        title={a.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={a.state === "published" ? "green" : a.state === "locked" ? "zinc" : "amber"} icon={a.state === "locked" ? Lock : undefined}>
              {t(`state.${a.state}` as Parameters<typeof t>[0])}
            </Badge>
            {a.gradesValidatedAt ? (
              <Tip label={`Validated ${isoDateTime(a.gradesValidatedAt)}`}>
                <Badge tone="green" icon={ClipboardCheck}>
                  {t("assignment.gradesValidated")}
                </Badge>
              </Tip>
            ) : null}
            <span className="inline-flex items-center gap-1.5">
              <CalendarClock className="size-3.5 text-fg-faint" />
              {isoDateTime(a.startAt)} → {isoDateTime(a.deadlineAt)}
            </span>
          </span>
        }
        actions={
          <>
            <IconButton label={t("common.refresh")} onClick={() => detail.refetch()} disabled={detail.isFetching}>
              <RefreshCw className={detail.isFetching ? "animate-spin" : ""} />
            </IconButton>
            <Menu
              label="Assignment actions"
              items={[
                { label: t("assignment.cloneScript"), icon: FileCode, onSelect: downloadCloneScript },
                ...(showGrades
                  ? [{ label: t("assignment.export"), icon: Download, onSelect: () => void exportGrades() }]
                  : []),
              ]}
            />
            {canAdjust ? (
              <Button
                variant={a.gradesValidatedAt ? "secondary" : "primary"}
                loading={validate.isPending}
                onClick={async () => {
                  if (
                    await confirm({
                      title: a.gradesValidatedAt ? t("assignment.revalidate") : t("assignment.validate"),
                      message: t("assignment.validateConfirm"),
                      confirmLabel: a.gradesValidatedAt ? t("assignment.revalidate") : t("assignment.validate"),
                      cancelLabel: t("common.cancel"),
                    })
                  ) {
                    validate.mutate();
                  }
                }}
              >
                <ClipboardCheck />
                {a.gradesValidatedAt ? t("assignment.revalidate") : t("assignment.validate")}
              </Button>
            ) : null}
          </>
        }
      />

      <div className={cx("grid gap-3 sm:grid-cols-2", showGrades ? "lg:grid-cols-4" : "lg:grid-cols-3")}>
        <Stat
          icon={Users}
          label="Accepted"
          value={`${accepted} / ${students.length}`}
          hint={`${students.filter((s) => s.claimStatus === "claimed").length} claimed their seat`}
        />
        <Stat
          icon={CheckCircle2}
          label="CI passing"
          value={accepted ? `${passing} / ${accepted}` : "—"}
          hint="on the last commit"
        />
        {showGrades ? (
          <Stat
            icon={Bot}
            label="Average grade"
            value={average != null ? average.toFixed(1) : "—"}
            hint={`${graded.length} graded · LLM review ${review.label}`}
          />
        ) : null}
        <Stat
          icon={a.state === "locked" ? Lock : CalendarClock}
          label={deadlineMs > 0 ? "Deadline in" : "Deadline passed"}
          value={compactDuration(Math.abs(deadlineMs))}
          hint={deadlineMs > 0 ? isoDateTime(a.deadlineAt) : `${compactDuration(Math.abs(deadlineMs))} ago`}
        />
      </div>

      <SyncBanner classroomId={classroomId} a={a} />
      <CodespaceBanner classroomId={classroomId} a={a} />

      {showGrades ? (
        <MilestonesSection
          classroomId={classroomId}
          assignmentId={assignmentId}
          deadlineAt={a.deadlineAt}
        />
      ) : null}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <SearchInput
            placeholder={t("assignment.searchStudents")}
            aria-label={t("assignment.searchStudents")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-64"
          />
          <span className="text-[13px] text-fg-muted">
            {rows.length === students.length ? `${students.length} students` : `${rows.length} of ${students.length} students`}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className={T.table}>
            <thead>
              <tr className={T.head}>
                <Th k="name">{t("assignment.col.student")}</Th>
                <Th k="status">{t("assignment.col.status")}</Th>
                <Th k="lastCommitAt">{t("assignment.col.lastCommit")}</Th>
                <Th k="commitCount" right>
                  {t("assignment.col.commits")}
                </Th>
                <th className={T.th}>{t("assignment.col.checks")}</th>
                {showGrades ? <Th k="grade">{t("assignment.col.grade")}</Th> : null}
                <th className={T.th} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <StudentRow
                  key={s.enrollmentId}
                  classroomId={classroomId}
                  assignmentId={assignmentId}
                  frozen={a.state === "locked"}
                  showGrades={showGrades}
                  canAdjust={canAdjust}
                  s={s}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/** Assignment page: own view, under the classroom breadcrumb. */
export function AssignmentPage(props: {
  classroomId: string;
  assignmentId: string;
  navigate: (r: Route) => void;
}) {
  return <AssignmentDetail {...props} />;
}
