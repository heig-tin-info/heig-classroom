/**
 * Drizzle schema (SQLite, better-sqlite3).
 *
 * The four entities of the framing document, and nothing else: `users`,
 * `assignments`, `sessions`, `push_events`. The portal *login* session is not a
 * fifth table: it is a stateless signed token (`auth/session.ts`), justified in
 * docs/v1.md § 3.
 *
 * Timestamps are stored as epoch milliseconds (`timestamp_ms`), UTC, like
 * heig-classroom stores `timestamptz`. SQLite has no timestamp type and a
 * text date would sort badly across time zones.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * One row per ref changed by a successful `receive-pack` on a staging
 * repository. This is the timestamped proof of submission (invariant 7: the
 * row is written *before* any relay to the forge is attempted), and the work
 * queue for the relay job at the same time.
 *
 * `state` stays `pending` for as long as the relay is worth retrying — a
 * forge outage must never turn into a lost submission — and only moves to
 * `failed` once the attempt budget is exhausted.
 */
export const pushEvents = sqliteTable(
  "push_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    student: text("student").notNull(),
    assignment: text("assignment").notNull(),
    /** Full ref name, e.g. `refs/heads/main`. */
    ref: text("ref").notNull(),
    /** Ref value after the push. */
    sha: text("sha").notNull(),
    /** Ref value before the push; null when the ref was created. */
    oldSha: text("old_sha"),
    /** Null when the ref was deleted. */
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
    state: text("state", { enum: ["pending", "relayed", "failed"] })
      .notNull()
      .default("pending"),
    /** Relay attempts already made; drives the backoff. */
    attempts: integer("attempts").notNull().default(0),
    /** Epoch ms before which the relay job must not pick this row up. */
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
    relayedAt: integer("relayed_at", { mode: "timestamp_ms" }),
    /** Last relay error, tokens redacted (see git/relay.ts). */
    lastError: text("last_error"),
  },
  (t) => [
    index("push_events_state_idx").on(t.state, t.nextAttemptAt),
    index("push_events_session_idx").on(t.sessionId, t.receivedAt),
  ],
);

export type PushEventRow = typeof pushEvents.$inferSelect;
export type NewPushEventRow = typeof pushEvents.$inferInsert;

/**
 * The three other entities of the framing document (jalon-0 V1): the user, the
 * assignment, the session. Together with `push_events` above, that makes the
 * four announced tables and nothing else: the portal login session is a signed
 * cookie with no server-side state (auth/session.ts), not a fifth table.
 */

/**
 * Portal user, created at the first OIDC login (invariant 4: no other identity
 * source). `login` is the institutional identifier (`preferred_username`): it
 * is what names the volume directory, so it must satisfy the `SAFE_ID` of
 * `git/staging.ts`.
 */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    /** OIDC subject: the identity key, stable even if the address changes. */
    oidcSub: text("oidc_sub").notNull(),
    login: text("login").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull().default(""),
    /**
     * GitHub login, when it is known. It comes from the launch token's claims
     * for an account coming from classroom (classroom is the source of truth for
     * the GitHub link); it stays null for a standalone OIDC account.
     */
    githubLogin: text("github_login"),
    /** Derived from the Keycloak realm role at every login, never stored by hand. */
    role: text("role", { enum: ["student", "teacher"] })
      .notNull()
      .default("student"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("users_oidc_sub_idx").on(t.oidcSub),
    uniqueIndex("users_login_idx").on(t.login),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;

/**
 * Assignment. In v0 it comes from `seed/assignments.yaml` (analyse.md § 5: "an
 * assignment is a YAML file until the pilot"); the teacher-facing creation UI
 * is out of scope.
 *
 * `templateRepo` / `targetRepo` carry invariant 6: in exam mode the staging
 * repository is seeded from the **template**, and the target repository is only
 * a relay destination.
 */
export const assignments = sqliteTable("assignments", {
  /** Short identifier, also names the volume subdirectory. */
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  mode: text("mode", { enum: ["lab", "exam"] })
    .notNull()
    .default("lab"),
  /** Student image to launch, e.g. `codespace/c-dev:4.137.0`. */
  image: text("image").notNull(),
  /** `http.uploadpack` of the staging repository; true by default (analyse.md 3.2). */
  uploadPack: integer("upload_pack", { mode: "boolean" }).notNull().default(true),
  /** The teacher's template repository: URL or path of a local repository. */
  templateRepo: text("template_repo"),
  /** Fixed target repository `<owner>/<name>`. Exclusive with `targetRepoPattern`. */
  targetRepo: text("target_repo"),
  /**
   * Convention, e.g. `codespace/{student}-tp-pointeurs`. `{student}` is
   * substituted. **Fallback**: an assignment synchronised from classroom
   * receives the student's repository through the launch token, and
   * `sessions.targetRepo` is what is authoritative. These two columns remain for
   * the standalone YAML seed (`seed/assignments.yaml`).
   */
  targetRepoPattern: text("target_repo_pattern"),

  // --- Assignment synchronised from heig-classroom ------------------------
  // All null for an assignment coming from the standalone YAML seed.
  /** Owning teacher: carrier of the quota (`sessions.teacherId`). */
  teacherId: text("teacher_id"),
  teacherEmail: text("teacher_email"),
  /** Simultaneous live sessions allowed to this teacher, across all assignments. */
  maxActiveSessions: integer("max_active_sessions"),
  classroomId: text("classroom_id"),
  classroomName: text("classroom_name"),
  /**
   * The teacher's template repository, as classroom names it. Invariant 6: it is
   * from there, and from nowhere else, that an exam staging repository is
   * seeded. `templateRepo` carries its clone URL.
   */
  sourceRepo: text("source_repo", { mode: "json" }).$type<AssignmentRepoRef>(),
  /** Opening window. Null = no bound on that side. */
  opensAt: integer("opens_at", { mode: "timestamp_ms" }),
  closesAt: integer("closes_at", { mode: "timestamp_ms" }),
  /** Config Key of the `.seb` served (seb/sebFile.ts). Null outside exam mode. */
  configKey: text("config_key"),
  /** One BEK per (platform, version) pair: a list, not a scalar (analyse.md 4.4). */
  beks: text("beks", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default([]),
  /** Settings of the `.seb`: `examKeySalt`, `quitUrl`, `extraAllowedHosts`. */
  sebConfig: text("seb_config", { mode: "json" }).$type<AssignmentSebConfig>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export interface AssignmentSebConfig {
  /** Browser Exam Key salt, stable for an assignment (seb/sebFile.ts). */
  examKeySalt: string;
  /**
   * `startURL` written into the `.seb`, hence into the Config Key computation.
   * Absent for a standalone assignment (the portal then takes its own route
   * `/exam/<id>/start`); present for a synchronised assignment, where it is
   * classroom that authenticates the student before redirecting to `/launch`.
   */
  startUrl?: string;
  quitUrl?: string;
  extraAllowedHosts?: string[];
}

/** Repository on the forge, as classroom names it (`CodespaceRepoRef`). */
export interface AssignmentRepoRef {
  fullName: string;
  defaultBranch: string;
}

export type AssignmentRow = typeof assignments.$inferSelect;
export type NewAssignmentRow = typeof assignments.$inferInsert;

/**
 * Session: a (student, assignment) pair and the container that serves it.
 * Only one live per pair (analyse.md D5); the constraint is held by
 * `sessions/store.ts`, not by a partial index, because "live" is a set of
 * states and SQLite does not index that without duplication.
 *
 * `student` duplicates `users.login` on purpose: the volume path derives from
 * it and must not move if the user record changes.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    student: text("student").notNull(),
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => assignments.id),
    /** Podman id; null between the creation of the row and the `run`. */
    containerId: text("container_id"),
    containerName: text("container_name"),
    /** Address on the `codespace` bridge: that is the whole authentication of the Git channel. */
    containerIp: text("container_ip"),
    /** `<VOLUMES_ROOT>/<student>/<assignment>`, kept after the container is destroyed. */
    volumeDir: text("volume_dir").notNull(),
    state: text("state", { enum: ["starting", "running", "stopped", "closed", "failed"] })
      .notNull()
      .default("starting"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** Heartbeat, updated by the proxy on every request. */
    lastSeen: integer("last_seen", { mode: "timestamp_ms" }).notNull(),
    /** Token of the `cs_session` cookie, carried by the student's browser. */
    cookieToken: text("cookie_token").notNull(),
    /** True if the session was born from an SEB verification (invariant 5). */
    sebVerified: integer("seb_verified", { mode: "boolean" }).notNull().default(false),
    /**
     * Teacher who carries the quota, copied from the assignment at creation
     * time. Copied rather than joined: the quota is counted in a single query,
     * and a reassigned assignment does not move the already open sessions.
     */
    teacherId: text("teacher_id"),
    /** `jti` of the launch token that opened or resumed this session. */
    launchJti: text("launch_jti"),
    /**
     * The student's repository, brought by the launch token. It is the relay's
     * target and, in lab mode, the mirror's source. Null for a session born from
     * the YAML seed: the assignment then carries the convention.
     */
    targetRepo: text("target_repo", { mode: "json" }).$type<AssignmentRepoRef>(),
  },
  (t) => [
    index("sessions_pair_idx").on(t.student, t.assignmentId, t.state),
    index("sessions_state_idx").on(t.state, t.lastSeen),
    // The quota count: a teacher's live sessions, across all assignments.
    index("sessions_teacher_idx").on(t.teacherId, t.state),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;

/**
 * Single use of launch tokens. One row per consumed `jti`; the primary key *is*
 * the guarantee — a second `INSERT` of the same `jti` fails, and it is that
 * refusal that `classroom/routes.ts` turns into a 403.
 *
 * `exp` is kept only for the purge: beyond it, the token is refused by
 * `verifyHs256` anyway, so the row has nothing left to prevent.
 */
export const launchTokensUsed = sqliteTable(
  "launch_tokens_used",
  {
    jti: text("jti").primaryKey(),
    /** The token's `exp`, in milliseconds. The row is purged after that. */
    exp: integer("exp", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("launch_tokens_used_exp_idx").on(t.exp)],
);

export type LaunchTokenUsedRow = typeof launchTokensUsed.$inferSelect;
