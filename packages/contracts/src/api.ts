/**
 * API payload types shared by the server (producers) and the web app
 * (consumers). Wire format: dates travel as ISO strings. Any payload drift
 * becomes a compile error on the side that diverges.
 */

/** Display format for date-times; null falls back to ISO (`2026-09-01 08:00`). */
export const DATE_FORMATS = ["iso", "eu", "uk", "us"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export function isDateFormat(v: unknown): v is DateFormat {
  return typeof v === "string" && (DATE_FORMATS as readonly string[]).includes(v);
}

export interface Me {
  id: string;
  email: string;
  givenName: string;
  familyName: string;
  role: "teacher" | "student" | "admin";
  githubLogin: string | null;
  lastLoginAt: string | null;
  avatarUrl: string | null;
  hasUploadedAvatar: boolean;
  locale: "en" | "fr" | null;
  dateFormat: DateFormat | null;
  emailPrefs: Record<string, boolean>;
}

export type AssignmentState = "draft" | "published" | "locked";
/** `none` = no grades/points anywhere and no review dispatch; `auto` = current behaviour. */
export type GradingMode = "none" | "auto";
export type ProvisionStatus = "pending" | "ok" | "error";
export type InvitationStatus = "none" | "pending" | "accepted";
export type CiStatus = "none" | "pending" | "pass" | "fail";

// --- Classrooms (teacher) ---

export interface ClassroomSummary {
  id: string;
  name: string;
  orgLogin: string;
  createdAt: string;
  archivedAt: string | null;
  students: number;
  claimed: number;
  assignments: {
    id: string;
    name: string;
    state: AssignmentState;
    startAt: string;
    deadlineAt: string;
  }[];
  roster: { nom: string; prenom: string; claimed: boolean; staff: boolean }[];
}

export interface RosterEntry {
  id: string;
  nom: string;
  prenom: string;
  email: string;
  status: "pending" | "claimed";
  conflictFlag: boolean;
  staff: boolean;
  githubLogin: string | null;
  lastLoginAt: string | null;
  avatarUrl: string | null;
  hasUploadedAvatar: boolean;
}

export interface ClassroomDetail {
  id: string;
  name: string;
  org: {
    login: string;
    installationId: number | null;
    githubOrgId: number | null;
    /** GitHub billing plan (`free`, `team`, …); null = unknown. */
    plan: string | null;
    /** `degraded` = the organization vanished from GitHub (deleted/renamed). */
    status: "active" | "degraded";
    /** Fresh existence check when uninstalled; null = indeterminate. */
    exists: boolean | null;
    /**
     * ANTHROPIC_API_KEY org secret presence (LLM reviews die without it).
     * Null = indeterminate: the App lacks the org Secrets read permission.
     */
    llmSecret: "ok" | "missing" | null;
  } | null;
  roster: RosterEntry[];
  appSlug: string | null;
}

// --- Assignments (teacher) ---

export interface Assignment {
  id: string;
  name: string;
  slug: string;
  state: AssignmentState;
  startAt: string;
  deadlineAt: string;
  graceMinutes: number;
  sourceFullName: string;
  squashedFullName: string | null;
  sourceStrategy: "whole" | "squash";
  deadlineStrategy: "lock" | "commit";
  gradingMode: GradingMode;
  branches: string[];
  protectedFiles: string[];
}

export interface OrgRepo {
  name: string;
  defaultBranch: string;
}

export interface RepoTree {
  name: string;
  defaultBranch: string;
  branches: string[];
  headSha: string;
  headDate: string | null;
  tree: { path: string; type: "blob" | "tree" }[];
  truncated: boolean;
  suggestedProtected: string[];
}

// --- Grades (GR-10/11): same shape on the student and teacher sides ---

export type GradeParseStatus = "ok" | "no_annotation" | "malformed" | "multiple" | "fallback";

export interface GradeView {
  points: number | null;
  max: number | null;
  testsPassed: number | null;
  testsTotal: number | null;
  parseStatus: GradeParseStatus;
  conclusion: string;
  sha: string;
  branch: string;
  kind: "ci" | "llm";
  afterDeadline: boolean;
  completedAt: string;
}

export interface GradeRunHistoryEntry extends GradeView {
  id: string;
  workflowRunId: number;
  runAttempt: number;
}

export interface GradeRunHistory {
  currentGradeRunId: string | null;
  frozenGradeRunId: string | null;
  llmGradeRunId: string | null;
  runs: GradeRunHistoryEntry[];
}

// --- Assignment detail (teacher, US-13/GR-15) ---

export interface AssignmentDetailRepo {
  id: string;
  fullName: string | null;
  provisionStatus: ProvisionStatus;
  provisionError: string | null;
  invitationStatus: InvitationStatus;
  acceptedAt: string;
  lockedAt: string | null;
  syncPr: { number: number; state: "open" | "merged" | "closed" | null } | null;
  grade: GradeView | null;
  frozenGrade: GradeView | null;
  llmGrade: GradeView | null;
  lastCommitSha: string | null;
  lastCommitAt: string | null;
  commitCount: number | null;
  checksPassed: number | null;
  checksTotal: number | null;
  ciStatus: CiStatus;
  missing?: boolean;
}

export interface AssignmentDetailStudent {
  enrollmentId: string;
  nom: string;
  prenom: string;
  email: string;
  claimStatus: "pending" | "claimed";
  githubLogin: string | null;
  repo: AssignmentDetailRepo | null;
}

export interface AssignmentDetailPayload {
  assignment: {
    id: string;
    name: string;
    state: AssignmentState;
    startAt: string;
    deadlineAt: string;
    /** Review countdown: the LLM dispatch fires at deadline + grace. */
    graceMinutes: number;
    gradingMode: GradingMode;
    frozenAt: string | null;
    llmDispatchedAt: string | null;
    sourceAheadSha: string | null;
    sourcePushedAt: string | null;
    syncedAt: string | null;
  };
  students: AssignmentDetailStudent[];
}

// --- Milestones (intermediate reviews, dispatched at due_at) ---

export interface AssignmentMilestone {
  id: string;
  /** criteria.yml `milestone:` tag / `score grade --milestone` argument. */
  name: string;
  dueAt: string;
  /** J±n authoring relative to the deadline; null = absolute date. */
  offsetDays: number | null;
  dispatchedAt: string | null;
}

// --- Repository activity (expandable row) ---

export interface Commit {
  sha: string;
  message: string;
  author: string;
  date: string | null;
  parents: string[];
}

export interface ActivityData {
  commits: Commit[];
  branches: { name: string; headSha: string }[];
  tests: { date: string; passed: number | null; total: number | null }[];
}

// --- Student home ---

export interface StudentRepo {
  fullName: string | null;
  provisionStatus: ProvisionStatus;
  invitationStatus: InvitationStatus;
  ciStatus: CiStatus;
  lockedAt: string | null;
  commitCount: number | null;
  checksPassed: number | null;
  checksTotal: number | null;
  grade: GradeView | null;
  llmGrade: GradeView | null;
  gradeFrozen: boolean;
}

export interface StudentAssignment {
  id: string;
  name: string;
  state: "published" | "locked";
  startAt: string;
  deadlineAt: string;
  /** Review countdown: the LLM review fires at deadline + grace. */
  graceMinutes: number;
  gradingMode: GradingMode;
  repo: StudentRepo | null;
}

export interface StudentClassroom {
  id: string;
  name: string;
  orgLogin: string;
  teacher: string;
  assignments: StudentAssignment[];
}
