/**
 * Drizzle schema, M1 scope (see docs/03-architecture.md, section
 * « Schéma de base de données »). UTC everywhere (timestamptz), uuid v7
 * primary keys generated application-side. UNIQUE constraints are the
 * idempotency mechanism (NFR-09).
 */
import { sql } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";
import {
  bigint,
  bigserial,
  boolean,
  char,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    oidcSub: text("oidc_sub").notNull().unique(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    givenName: text("given_name").notNull().default(""),
    familyName: text("family_name").notNull().default(""),
    swissEduId: text("swiss_edu_id"),
    /** Avatar URL provided by the IdP (OIDC `picture` claim), if present. */
    pictureUrl: text("picture_url"),
    role: text("role", { enum: ["student", "teacher", "admin"] })
      .notNull()
      .default("student"),
    githubUserId: bigint("github_user_id", { mode: "number" }).unique(),
    githubLogin: text("github_login"),
    githubLinkedAt: timestamp("github_linked_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** Interface language chosen by the user; null falls back to English. */
    locale: text("locale", { enum: ["en", "fr"] }),
    /** Date-time display format; null falls back to ISO (YYYY-MM-DD HH:mm). */
    dateFormat: text("date_format", { enum: ["iso", "eu", "uk", "us"] }),
    /** Per-kind email opt-outs (mailer.ts EMAIL_KINDS); missing key = default. */
    emailPrefs: jsonb("email_prefs").$type<Record<string, boolean>>(),
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("users_email_idx").on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** Hex SHA-256 of the session token, never the plaintext token (AU-06). */
    sidHash: char("sid_hash", { length: 64 }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_expires_idx").on(t.expiresAt)],
);

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/** Uploaded avatar (cropped to 256×256 client-side), takes priority over `picture_url`. */
export const avatars = pgTable("avatars", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  data: bytea("data").notNull(),
  contentType: text("content_type").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Teachers managed in the database by the admin (H2 revision, 2026-07-07):
 * the grant is made by email even before the person has an account; identity
 * and last login fill in at their first edu-ID login.
 */
export const teacherGrants = pgTable(
  "teacher_grants",
  {
    id: uuid("id").primaryKey(),
    /** Normalized to lowercase. */
    email: text("email").notNull().unique(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey(),
  /** Resolved when the GitHub App is installed (M2); null until installed. */
  githubOrgId: bigint("github_org_id", { mode: "number" }).unique(),
  login: text("login").notNull().unique(),
  installationId: bigint("installation_id", { mode: "number" }).unique(),
  status: text("status", { enum: ["active", "degraded"] })
    .notNull()
    .default("active"),
  /**
   * GitHub billing plan (`free`, `team`, …), read through the App's org
   * Plan permission. Organization secrets never reach the private repos of a
   * Free org, so the LLM review tier would fail silently: the classroom page
   * warns the teacher while the plan is `free`.
   */
  plan: text("plan"),
});

export const classrooms = pgTable("classrooms", {
  id: uuid("id").primaryKey(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id),
  teacherId: uuid("teacher_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const enrollments = pgTable(
  "enrollments",
  {
    id: uuid("id").primaryKey(),
    classroomId: uuid("classroom_id")
      .notNull()
      .references(() => classrooms.id, { onDelete: "cascade" }),
    nom: text("nom").notNull(),
    prenom: text("prenom").notNull(),
    /** Normalized (trim + lowercase) at import time (AU-14). */
    email: text("email").notNull(),
    status: text("status", { enum: ["pending", "claimed"] })
      .notNull()
      .default("pending"),
    userId: uuid("user_id").references(() => users.id),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    conflictFlag: boolean("conflict_flag").notNull().default(false),
    /** Teacher/admin seat (self-enroll): excluded from the class headcount. */
    staff: boolean("staff").notNull().default(false),
  },
  (t) => [
    uniqueIndex("enrollments_classroom_email_uq").on(t.classroomId, t.email),
    uniqueIndex("enrollments_classroom_user_uq").on(t.classroomId, t.userId),
    index("enrollments_email_idx").on(sql`lower(${t.email})`),
  ],
);

export const assignments = pgTable(
  "assignments",
  {
    id: uuid("id").primaryKey(),
    classroomId: uuid("classroom_id")
      .notNull()
      .references(() => classrooms.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** US-08 lifecycle: draft → published → locked. */
    state: text("state", { enum: ["draft", "published", "locked"] })
      .notNull()
      .default("draft"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    graceMinutes: integer("grace_minutes").notNull().default(30),
    sourceRepoId: bigint("source_repo_id", { mode: "number" }).notNull(),
    sourceFullName: text("source_full_name").notNull(),
    squashedRepoId: bigint("squashed_repo_id", { mode: "number" }),
    squashedFullName: text("squashed_full_name"),
    sourceStrategy: text("source_strategy", { enum: ["whole", "squash"] })
      .notNull()
      .default("squash"),
    deadlineStrategy: text("deadline_strategy", { enum: ["lock", "commit"] })
      .notNull()
      .default("lock"),
    /** `none` = no grades/points shown and no review (LLM/milestone) dispatch. */
    gradingMode: text("grading_mode", { enum: ["none", "auto"] })
      .notNull()
      .default("auto"),
    branches: text("branches").array().notNull(),
    protectedFiles: text("protected_files").array().notNull(),
    sourceAheadSha: text("source_ahead_sha"),
    /** Last push received on a selected branch of the source repo (GH-50). */
    sourcePushedAt: timestamp("source_pushed_at", { withTimezone: true }),
    /** Last completed propagation to student repositories (GH-51). */
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    deadlineAppliedAt: timestamp("deadline_applied_at", { withTimezone: true }),
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
    /** GR-16: authoritative LLM review dispatched to every repo (grade-final). */
    llmDispatchedAt: timestamp("llm_dispatched_at", { withTimezone: true }),
    /** J-1 email reminder sent (atomic claim in the ticker, one shot). */
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("assignments_classroom_slug_uq").on(t.classroomId, t.slug),
    // Deadline ticker scan (ADR-006): published, past due, not yet applied.
    index("assignments_deadline_pending_idx")
      .on(t.deadlineAt)
      .where(sql`${t.state} = 'published' AND ${t.deadlineAppliedAt} IS NULL`),
    // Definitive freeze after the grace period (ADR-012).
    index("assignments_freeze_pending_idx")
      .on(t.deadlineAt)
      .where(sql`${t.deadlineAppliedAt} IS NOT NULL AND ${t.frozenAt} IS NULL`),
    // GR-16 ticker scan: frozen assignments whose LLM review is still due.
    index("assignments_llm_dispatch_pending_idx")
      .on(t.frozenAt)
      .where(sql`${t.frozenAt} IS NOT NULL AND ${t.llmDispatchedAt} IS NULL`),
  ],
);

/**
 * Intermediate grading milestones: at `due_at` the ticker fires ONE
 * `grade-milestone` repository_dispatch per student repository (same ledger
 * as grade-final, trigger `milestone`). Both the resolved date (jobs use it)
 * and the J±n offset relative to the deadline (reusable across semesters,
 * re-resolved when the deadline moves) are stored. The platform stays
 * ignorant of the barème: the per-criterion `milestone:` tag lives in
 * criteria.yml and `score grade --milestone <name>` filters on it.
 */
export const assignmentMilestones = pgTable(
  "assignment_milestones",
  {
    id: uuid("id").primaryKey(),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => assignments.id, { onDelete: "cascade" }),
    /** Kebab-case tag matched by the `milestone:` entries of criteria.yml. */
    name: text("name").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    /** J±n authoring, in days relative to the deadline (J-3 → -3); null = absolute date. */
    offsetDays: integer("offset_days"),
    /** Review dispatched to every repo (mirror of `llm_dispatched_at`). */
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("assignment_milestones_assignment_name_uq").on(t.assignmentId, t.name),
    // Ticker scan: milestones due, not yet dispatched.
    index("assignment_milestones_due_pending_idx")
      .on(t.dueAt)
      .where(sql`${t.dispatchedAt} IS NULL`),
  ],
);

export const studentRepos = pgTable(
  "student_repos",
  {
    id: uuid("id").primaryKey(),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => assignments.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    githubRepoId: bigint("github_repo_id", { mode: "number" }).unique(),
    fullName: text("full_name"),
    defaultBranch: text("default_branch"),
    provisionStatus: text("provision_status", { enum: ["pending", "ok", "error"] })
      .notNull()
      .default("pending"),
    provisionError: text("provision_error"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    invitationStatus: text("invitation_status", { enum: ["none", "pending", "accepted"] })
      .notNull()
      .default("none"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    rulesetId: bigint("ruleset_id", { mode: "number" }),
    lastCommitSha: text("last_commit_sha"),
    lastCommitAt: timestamp("last_commit_at", { withTimezone: true }),
    ciStatus: text("ci_status", { enum: ["none", "pending", "pass", "fail"] })
      .notNull()
      .default("none"),
    /** Open sync pull request (GH-51/52): one at most per repository. */
    syncPrNumber: integer("sync_pr_number"),
    syncPrState: text("sync_pr_state", { enum: ["open", "merged", "closed"] }),
    /** Selected GradeRun (GR-09); no FK: cross-reference with grade_runs. */
    currentGradeRunId: uuid("current_grade_run_id"),
    /** Grade frozen at the deadline (GR-12), immutable after deadline+grace (GR-14.4). */
    frozenGradeRunId: uuid("frozen_grade_run_id"),
    /** Authoritative LLM review run (GR-16), separate from the frozen CI grade. */
    llmGradeRunId: uuid("llm_grade_run_id"),
  },
  (t) => [
    // Provisioning idempotency key (GH-20, NFR-09).
    uniqueIndex("student_repos_assignment_user_uq").on(t.assignmentId, t.userId),
  ],
);

/**
 * Captured CI runs (GR-08): one immutable record per eligible run (selected
 * branch, non-bot commit). The (repo, run, attempt) uniqueness is the
 * idempotency; a replayed webhook or a reconciliation never duplicates.
 */
export const gradeRuns = pgTable(
  "grade_runs",
  {
    id: uuid("id").primaryKey(),
    studentRepoId: uuid("student_repo_id")
      .notNull()
      .references(() => studentRepos.id, { onDelete: "cascade" }),
    workflowRunId: bigint("workflow_run_id", { mode: "number" }).notNull(),
    runAttempt: integer("run_attempt").notNull().default(1),
    headBranch: text("head_branch").notNull(),
    headSha: char("head_sha", { length: 40 }).notNull(),
    conclusion: text("conclusion").notNull(),
    gradePoints: doublePrecision("grade_points"),
    gradeMax: doublePrecision("grade_max"),
    /** Raw test counters from the TESTS annotation (score ≥ 0.7.2), if any. */
    testsPassed: integer("tests_passed"),
    testsTotal: integer("tests_total"),
    parseStatus: text("parse_status", {
      enum: ["ok", "no_annotation", "malformed", "multiple", "fallback"],
    }).notNull(),
    /**
     * GR-16: `ci` for push-triggered runs (indicative grade), `llm` for the
     * repository_dispatch review (authoritative). LLM runs never enter the
     * GR-09 selection: they land in `student_repos.llm_grade_run_id`.
     */
    kind: text("kind", { enum: ["ci", "llm"] }).notNull().default("ci"),
    /** GR-14 criterion: server receipt time of the commit, never git time. */
    afterDeadline: boolean("after_deadline").notNull().default(false),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("grade_runs_repo_run_attempt_uq").on(t.studentRepoId, t.workflowRunId, t.runAttempt),
    // GR-09 selection: the most recent eligible run per repository.
    index("grade_runs_selection_idx").on(t.studentRepoId, t.completedAt),
  ],
);

/**
 * Push receipts (GR-14, ADR-012): the server receipt time is written
 * SYNCHRONOUSLY in the webhook handler; it is the reference for the grade
 * freeze and never depends on queue lag.
 */
export const pushReceipts = pgTable(
  "push_receipts",
  {
    id: uuid("id").primaryKey(),
    studentRepoId: uuid("student_repo_id")
      .notNull()
      .references(() => studentRepos.id, { onDelete: "cascade" }),
    branch: text("branch").notNull(),
    headSha: char("head_sha", { length: 40 }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    isBot: boolean("is_bot").notNull().default(false),
    forced: boolean("forced").notNull().default(false),
  },
  (t) => [uniqueIndex("push_receipts_repo_sha_uq").on(t.studentRepoId, t.headSha)],
);

/**
 * Bot commits (revert, deadline, sync, grader): deterministic GR-05/GH-44
 * filter. `grader` marks the GRADING.yml commits pushed by the llm-review
 * workflow (GITHUB_TOKEN → sender github-actions[bot]), so they never
 * produce a grade run nor displace the student's last commit.
 */
export const botCommits = pgTable(
  "bot_commits",
  {
    studentRepoId: uuid("student_repo_id")
      .notNull()
      .references(() => studentRepos.id, { onDelete: "cascade" }),
    sha: char("sha", { length: 40 }).notNull(),
    kind: text("kind", { enum: ["revert", "deadline", "sync", "grader"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("bot_commits_pk").on(t.studentRepoId, t.sha)],
);

/**
 * repository_dispatch ledger (GR-16): one row per (repo, trigger) claimed
 * with ON CONFLICT DO NOTHING BEFORE calling GitHub, so a worker restart
 * never re-fires the LLM review. `dispatched_at` is set after the API call;
 * rows stuck with a null `dispatched_at` are retried by the pg-boss job.
 * `milestone_id` is reserved for per-milestone reviews (not implemented yet);
 * the unique index coalesces it so (repo, trigger, NULL) stays unique.
 */
export const gradeDispatches = pgTable(
  "grade_dispatches",
  {
    id: uuid("id").primaryKey(),
    studentRepoId: uuid("student_repo_id")
      .notNull()
      .references(() => studentRepos.id, { onDelete: "cascade" }),
    trigger: text("trigger", { enum: ["deadline", "milestone"] }).notNull(),
    milestoneId: uuid("milestone_id"),
    /** Frozen commit sent in the client_payload (GR-14 selection). */
    sha: char("sha", { length: 40 }).notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("grade_dispatches_repo_trigger_uq").on(
      t.studentRepoId,
      t.trigger,
      sql`coalesce(${t.milestoneId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
  ],
);

/** History of protected-file reverts (anti-loop cap H10). */
export const reverts = pgTable(
  "reverts",
  {
    id: uuid("id").primaryKey(),
    studentRepoId: uuid("student_repo_id")
      .notNull()
      .references(() => studentRepos.id, { onDelete: "cascade" }),
    revertSha: char("revert_sha", { length: 40 }).notNull(),
    files: text("files").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reverts_repo_time_idx").on(t.studentRepoId, t.createdAt)],
);

/**
 * Scheduled tasks (ADR-011): the catalog (description, handler) lives in the
 * code; the database carries the admin configuration (interval, activation)
 * and the state of the last run. The ticker sweeps this table, so changing
 * the interval takes effect at the next tick, without a restart.
 */
export const scheduledTasks = pgTable("scheduled_tasks", {
  key: text("key").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  intervalMinutes: integer("interval_minutes").notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastStatus: text("last_status", { enum: ["ok", "error", "running"] }),
  lastError: text("last_error"),
  lastDurationMs: integer("last_duration_ms"),
});

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  actorUserId: uuid("actor_user_id"),
  actorType: text("actor_type", { enum: ["user", "system", "api_key"] }).notNull(),
  action: text("action").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    /** X-GitHub-Delivery; the PK is the deduplication (GH-61). */
    deliveryId: uuid("delivery_id").primaryKey(),
    event: text("event").notNull(),
    action: text("action"),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [
    index("webhook_deliveries_pending_idx")
      .on(t.receivedAt)
      .where(sql`${t.processedAt} IS NULL`),
  ],
);
