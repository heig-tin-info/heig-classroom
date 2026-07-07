/**
 * Schéma Drizzle — périmètre M1 (voir docs/03-architecture.md, section
 * « Schéma de base de données »). UTC partout (timestamptz), PK uuid v7
 * générées côté application. Les contraintes UNIQUE sont le mécanisme
 * d'idempotence (NFR-09).
 */
import { sql } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";
import {
  bigint,
  bigserial,
  boolean,
  char,
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
    /** URL d'avatar fournie par l'IdP (claim OIDC `picture`), si présente. */
    pictureUrl: text("picture_url"),
    role: text("role", { enum: ["student", "teacher", "admin"] })
      .notNull()
      .default("student"),
    githubUserId: bigint("github_user_id", { mode: "number" }).unique(),
    githubLogin: text("github_login"),
    githubLinkedAt: timestamp("github_linked_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    emailOptIn: boolean("email_opt_in").notNull().default(false),
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("users_email_idx").on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 hex du token de session — jamais le token en clair (AU-06). */
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

/** Avatar téléversé (recadré 256×256 côté client) — prioritaire sur `picture_url`. */
export const avatars = pgTable("avatars", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  data: bytea("data").notNull(),
  contentType: text("content_type").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Teachers gérés en base par l'admin (révision de H2, 2026-07-07) : le grant
 * se fait par e-mail avant même que la personne ait un compte — identité et
 * dernière connexion se remplissent à son premier login edu-ID.
 */
export const teacherGrants = pgTable(
  "teacher_grants",
  {
    id: uuid("id").primaryKey(),
    /** Normalisé en minuscules. */
    email: text("email").notNull().unique(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey(),
  /** Résolu à l'installation de la GitHub App (M2) ; null tant que non installée. */
  githubOrgId: bigint("github_org_id", { mode: "number" }).unique(),
  login: text("login").notNull().unique(),
  installationId: bigint("installation_id", { mode: "number" }).unique(),
  status: text("status", { enum: ["active", "degraded"] })
    .notNull()
    .default("active"),
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
    /** Normalisé (trim + lowercase) à l'import (AU-14). */
    email: text("email").notNull(),
    status: text("status", { enum: ["pending", "claimed"] })
      .notNull()
      .default("pending"),
    userId: uuid("user_id").references(() => users.id),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    conflictFlag: boolean("conflict_flag").notNull().default(false),
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
    /** Cycle de vie US-08 : brouillon → publié → verrouillé. */
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
    branches: text("branches").array().notNull(),
    protectedFiles: text("protected_files").array().notNull(),
    sourceAheadSha: text("source_ahead_sha"),
    deadlineAppliedAt: timestamp("deadline_applied_at", { withTimezone: true }),
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("assignments_classroom_slug_uq").on(t.classroomId, t.slug),
    // Scan du ticker deadline (ADR-006) : publiés, échus, non appliqués.
    index("assignments_deadline_pending_idx")
      .on(t.deadlineAt)
      .where(sql`${t.state} = 'published' AND ${t.deadlineAppliedAt} IS NULL`),
    // Gel définitif après le délai de grâce (ADR-012).
    index("assignments_freeze_pending_idx")
      .on(t.deadlineAt)
      .where(sql`${t.deadlineAppliedAt} IS NOT NULL AND ${t.frozenAt} IS NULL`),
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
  },
  (t) => [
    // Clé d'idempotence du provisionnement (GH-20, NFR-09).
    uniqueIndex("student_repos_assignment_user_uq").on(t.assignmentId, t.userId),
  ],
);

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
    /** X-GitHub-Delivery — la PK est la déduplication (GH-61). */
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
