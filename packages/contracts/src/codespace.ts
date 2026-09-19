// --- Codespace (online workspace): the contract between classroom and the portal ---
//
// classroom is the source of truth for assignments, students and repositories;
// the portal (apps/codespace) is the source of truth for sessions. The two only
// talk to each other through these messages, signed HS256 with a shared secret
// (`CODESPACE_LAUNCH_SECRET` on both sides). Neither imports the other's code
// (the import rule of the root CLAUDE.md).

/**
 * Work mode of an assignment.
 * - `free`: the historical flow, the student clones and pushes with their own
 *   GitHub account.
 * - `online`: the work happens in the portal; the student only has read access
 *   to their repository, the portal pushes on their behalf.
 * - `online_seb`: like `online`, and the session is only opened from Safe Exam
 *   Browser (checked on the portal side); the student has no access at all to
 *   the repository before grading.
 */
export type WorkMode = "free" | "online" | "online_seb";
export const WORK_MODES: readonly WorkMode[] = ["free", "online", "online_seb"];

/** A teacher's "online workspace" settings, set by the administrator. */
export interface TeacherCodespaceGrant {
  /** The teacher sees and can pick the `online*` modes in their assignments. */
  enabled: boolean;
  /** Simultaneous active sessions allowed across all of their assignments. */
  maxActiveSessions: number;
}

/** A student's target repository, as classroom provisioned it. */
export interface CodespaceRepoRef {
  fullName: string;
  defaultBranch: string;
}

/**
 * An assignment as the portal needs to know it. classroom sends it (PUT) every
 * time an assignment in an `online*` mode is saved, before any student can
 * launch it; the portal creates or updates it (idempotent).
 */
export interface CodespaceAssignmentSync {
  /** Id of the assignment in classroom; the assignment key in the portal. */
  id: string;
  slug: string;
  name: string;
  classroomId: string;
  classroomName: string;
  mode: Exclude<WorkMode, "free">;
  /** Image from the portal catalog; null = default image. */
  image: string | null;
  /** Template repository (squashed): what the workspace is seeded from in exam mode. */
  sourceRepo: CodespaceRepoRef;
  /** Accepted Browser Exam Keys (`online_seb` mode), one per platform/version pair. */
  browserExamKeys: string[];
  /** Owning teacher: the holder of the quota. */
  teacher: { id: string; email: string };
  quota: { maxActiveSessions: number };
  startAt: string;
  deadlineAt: string | null;
}

/**
 * Launch token: classroom issues it when a student clicks Start, and the portal
 * verifies it on `GET /launch?token=...`. Short-lived (5 min), single use
 * (`jti`).
 */
export interface LaunchTokenClaims {
  iss: "heig-classroom";
  aud: "heig-codespace";
  iat: number;
  exp: number;
  jti: string;
  /** Id of the user in classroom (stable). */
  sub: string;
  email: string;
  displayName: string;
  githubLogin: string | null;
  assignmentId: string;
  /** The student's target repository; null when it is not provisioned yet. */
  repo: CodespaceRepoRef | null;
}

/** Service token for server-to-server calls (assignment PUT, etc.). */
export interface ServiceTokenClaims {
  iss: "heig-classroom" | "heig-codespace";
  aud: "heig-codespace-api" | "heig-classroom-api";
  iat: number;
  exp: number;
}

/** The portal's response to `GET /api/assignments/:id/sessions` (teacher table). */
export interface CodespaceSessionSummary {
  sessionId: string;
  userId: string;
  email: string;
  state: string;
  createdAt: string;
  lastSeenAt: string | null;
  lastPushAt: string | null;
}

/**
 * The portal's answer to `PUT /api/assignments/:id`.
 *
 * `configKey` and `sebLink` are the two things classroom cannot compute on its
 * own: they depend on the `.seb` file the portal generates (its `examKeySalt`
 * in particular, which is never regenerated). classroom stores the Config Key
 * on the assignment so that the teacher can compare it, in the SEB
 * configuration tool, with the one their machine reads from the downloaded
 * file (docs/preuve-b-manuelle.md § 2). Both are null outside exam mode.
 */
export interface CodespaceAssignmentSyncResult {
  id: string;
  /** Config Key of the `.seb` served for this assignment: 64 lowercase hex. */
  configKey: string | null;
  /** The `sebs://` deep link — the student's one-click hand-over to SEB. */
  sebLink: string | null;
}
