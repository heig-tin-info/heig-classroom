/**
 * API payload types shared by the server (producers) and the web app
 * (consumers). Wire format: dates travel as ISO strings. Any payload drift
 * becomes a compile error on the side that diverges.
 */
import type { TeacherCodespaceGrant, WorkMode } from "./codespace.js";

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
  /**
   * Online workspace (ADR-013): the viewer's own grant, or null when the
   * feature is not configured at all (no `CODESPACE_URL`). This is where the
   * front reads whether to show the work-mode section of the assignment form
   * and the admin column; the server re-checks on every write.
   */
  codespace: TeacherCodespaceGrant | null;
  /**
   * Host of the portal (`localhost:3100`, `codespace.example.ch`): the
   * student side builds the `sebs://<host>/exam/<id>.seb` deep link from it.
   * Null when no portal is configured.
   */
  codespaceHost: string | null;
}

export type AssignmentState = "draft" | "published" | "locked";
/** `none` = no grades/points anywhere and no review dispatch; `auto` = current behaviour. */
export type GradingMode = "none" | "auto";
/**
 * How a draft goes live. `scheduled`: the ticker auto-publishes at startAt
 * (absolute dates). `manual`: the Publish button sets startAt = now and the
 * deadline is either the stored absolute date or now + durationMinutes.
 */
export type PublishMode = "scheduled" | "manual";
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
  /** The viewer created this classroom; false for one they only co-teach. */
  isOwner: boolean;
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

/**
 * Classroom staff (GH-9): the additional teachers/assistants of a classroom,
 * beside its owner. `role` is a label — every member holds the same rights
 * inside the classroom; only the owner manages this list.
 */
export type ClassroomStaffRole = "teacher" | "assistant";

export interface ClassroomStaffMember {
  id: string;
  email: string;
  role: ClassroomStaffRole;
  /** Filled once the invited e-mail matched an account (null otherwise). */
  givenName: string | null;
  familyName: string | null;
  /** The invitation was resolved to a real account. */
  claimed: boolean;
  createdAt: string;
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
  staff: ClassroomStaffMember[];
  /** The viewer created this classroom (or is an admin): may manage staff,
      archive and delete it. Other staff members see those read-only. */
  isOwner: boolean;
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
  publishMode: PublishMode;
  /** Manual mode only: deadline = publication + duration; null = absolute deadline. */
  durationMinutes: number | null;
  branches: string[];
  protectedFiles: string[];
  /** ADR-013; `free` for every assignment created before the feature. */
  workMode: WorkMode;
  /** Portal catalogue image; null = the portal's default image. */
  codespaceImage: string | null;
  /** Teacher-side only — Browser Exam Keys are secrets, never sent to students. */
  browserExamKeys: string[];
  /**
   * Group assignment (issue #2): one repository per group, every member a
   * collaborator. Only with `workMode: "free"`; editable while draft.
   */
  groupMode: boolean;
  /** Advisory maximum group size (warning only); null = no hint. */
  groupMaxSize: number | null;
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
  /**
   * Group repository (issue #2): the group it belongs to. Null for an
   * individual repository — including a lot-1 one left on a group assignment,
   * which is how the table tells it apart from the group's.
   */
  groupId: string | null;
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
  /** Validation flow: teacher override; final = teacherPoints ?? llm ?? frozen CI. */
  teacherPoints: number | null;
  teacherComment: string | null;
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
  /**
   * Group assignment (issue #2): the student's group, whose repository is
   * then `repo` — the same object on every member's line. Null for an
   * individual assignment or a student in no group.
   */
  group: { id: string; name: string } | null;
  repo: AssignmentDetailRepo | null;
}

export interface AssignmentDetailPayload {
  assignment: {
    id: string;
    name: string;
    /** Used client-side to name the generated clone script. */
    slug: string;
    /** Classroom name, for the header of the generated clone script. */
    classroom: string;
    state: AssignmentState;
    startAt: string;
    deadlineAt: string;
    /** Review countdown: the LLM dispatch fires at deadline + grace. */
    graceMinutes: number;
    gradingMode: GradingMode;
    frozenAt: string | null;
    llmDispatchedAt: string | null;
    /** Validation flow: grades signed off by the teacher (final for students). */
    gradesValidatedAt: string | null;
    sourceAheadSha: string | null;
    sourcePushedAt: string | null;
    syncedAt: string | null;
    /** ADR-013 work mode and its portal settings (teacher side). */
    workMode: WorkMode;
    codespaceImage: string | null;
    browserExamKeys: string[];
    /** Last successful PUT to the portal; null = never synced. */
    codespaceSyncedAt: string | null;
    /** Failure of the last attempt; null when the last one succeeded. */
    codespaceSyncError: string | null;
    /**
     * Config Key the portal computed for this exam assignment's `.seb`, as
     * returned by the last successful sync. The teacher compares it with the
     * one the SEB configuration tool displays. Null outside `online_seb`, and
     * until the first successful sync.
     */
    codespaceConfigKey: string | null;
    /**
     * Plain HTTPS URL of the `.seb` file, for the teacher to download and
     * hand to the SEB configuration tool. **Not** the `sebs://` deep link,
     * which would launch SEB instead of saving the file. Null when no portal
     * is configured or the assignment is not in `online_seb` mode.
     */
    codespaceSebUrl: string | null;
    /** Group assignment (issue #2): the detail table groups its lines by team. */
    groupMode: boolean;
    groupMaxSize: number | null;
  };
  students: AssignmentDetailStudent[];
}

// --- Classroom grade sheet (teacher): roster x graded assignments ---

export interface ClassroomGradesAssignment {
  id: string;
  name: string;
  deadlineAt: string;
  /** Null = the teacher has not signed the grades off yet (provisional). */
  gradesValidatedAt: string | null;
}

export interface ClassroomGradesStudent {
  enrollmentId: string;
  nom: string;
  prenom: string;
  email: string;
  status: "pending" | "claimed";
  /** Final points per assignment id; missing/null = no grade for that one. */
  points: Record<string, number | null>;
}

export interface ClassroomGradesPayload {
  classroom: { id: string; name: string };
  /** Graded, non-archived assignments, oldest deadline first. */
  assignments: ClassroomGradesAssignment[];
  /** Non-staff roster, ordered by name. */
  students: ClassroomGradesStudent[];
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
  /** Teacher override, only exposed once the grades are validated. */
  teacherPoints: number | null;
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
  /** Grades signed off by the teacher: what the student sees is final. */
  gradesValidatedAt: string | null;
  /**
   * ADR-013. `online`/`online_seb` put a Start button next to (or instead of)
   * the repository link. The Browser Exam Keys are deliberately absent: they
   * are secrets and never leave the teacher side.
   */
  workMode: WorkMode;
  /**
   * Group assignment (issue #2): the student's group and the names of the
   * other members; `repo` is then the group's repository. Null when the
   * assignment is individual or the student is in no group.
   */
  group: { name: string; teammates: string[] } | null;
  repo: StudentRepo | null;
}

export interface StudentClassroom {
  id: string;
  name: string;
  orgLogin: string;
  teacher: string;
  assignments: StudentAssignment[];
}

// --- Group assignments (issue #2, lot 1: group formation) ---

/** One student of the classroom as seen from the group-formation screen. */
export interface GroupMember {
  enrollmentId: string;
  nom: string;
  prenom: string;
  email: string;
  claimStatus: "pending" | "claimed";
  githubLogin: string | null;
  avatarUrl: string | null;
}

export interface AssignmentGroup {
  id: string;
  /** Display name, unique per assignment (`Group 3`, `Les Castors`). */
  name: string;
  /** Repository name suffix (`<assignment-slug>-<group-slug>`), frozen once a repo exists. */
  slug: string;
  members: GroupMember[];
  /**
   * The group's repository, created at the first acceptance of any member
   * (lot 2). While it exists the group is locked: no rename, no delete. A
   * member can still be added (invited on it) or removed (their access is
   * revoked on GitHub).
   */
  repo: { fullName: string | null; provisionStatus: ProvisionStatus } | null;
}

export interface AssignmentGroupsPayload {
  assignment: {
    id: string;
    name: string;
    state: AssignmentState;
    groupMode: boolean;
    /** Advisory maximum: exceeding it only shows a warning. Null = no hint. */
    groupMaxSize: number | null;
  };
  /** Ordered by position (creation order), stable across renames. */
  groups: AssignmentGroup[];
  /** Non-staff roster entries not in any group, ordered by name. */
  unassigned: GroupMember[];
  /**
   * Other group-mode assignments of the same classroom (source for
   * "Copy from…"), oldest first. Excludes this assignment.
   */
  copySources: { id: string; name: string; groups: number }[];
}

/** Publish refused (409 `unassigned_students`): group mode with students left out. */
export interface UnassignedStudentsError {
  error: "unassigned_students";
  message: string;
  students: { enrollmentId: string; nom: string; prenom: string }[];
}
