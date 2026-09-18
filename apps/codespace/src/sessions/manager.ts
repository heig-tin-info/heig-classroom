/**
 * Life cycle of a session: creation or resumption, heartbeat, garbage
 * collection, reconciliation with Podman, shadow repository snapshots.
 *
 * Invariants held here:
 *  - a single live session per (student, assignment) pair — analyse.md D5;
 *  - the staging repository of an assignment in exam mode is seeded from the
 *    teacher's template, never from the student's repository —
 *    invariant 6, applied by choosing the `StagingSource`;
 *  - the anchor container is never seen: the engine only returns the
 *    containers carrying the session label.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { eq } from "drizzle-orm";

import type { Engine } from "../engine/index.js";
import type { Db } from "../db/client.js";
import type { AssignmentRepoRef, AssignmentRow, SessionRow, UserRow } from "../db/schema.js";
import { sessions } from "../db/schema.js";
import {
  ForgeUnconfiguredError,
  ensureStagingRepo,
  redactSecrets,
  refSnapshot,
  stagingPaths,
  type RepoRef,
  type SessionLookup,
  type StagingResult,
  type StagingSession,
  type StagingSource,
} from "../git/index.js";

import {
  completionScript,
  ensureWorkspace,
  identityScript,
  type EnsureWorkspaceResult,
  type GitIdentity,
} from "./workspace.js";
import { snapshot } from "./shadow.js";
import {
  findAnySession,
  findAssignment,
  findSession,
  findUser,
  listLiveSessions,
  targetRepoOfSession,
  updateSession,
} from "./store.js";

export interface ManagerOptions {
  db: Db;
  engine: Engine;
  volumesRoot: string;
  /** Grace period after the last heartbeat before the container is destroyed. */
  graceMs: number;
  gcIntervalMs: number;
  shadowIntervalMs: number;
  healthTimeoutMs: number;
  /** Host of the `origin` remote written into the workspace: `portal.internal`. */
  gitRemoteHost: string;
  gitRemotePort: number;
  /**
   * Public origin of classroom (`CLASSROOM_URL`) and of the portal
   * (`PUBLIC_URL`). They serve exactly one purpose: the return URL passed to
   * the container for the status-bar extension's "Close" button
   * (`images/c-dev/extension`). Empty, no URL is passed on and the button does
   * not appear.
   */
  classroomUrl?: string;
  publicUrl?: string;
  log: {
    info: (o: object, m: string) => void;
    warn: (o: object, m: string) => void;
    error: (o: object, m: string) => void;
  };
}

export interface StartResult {
  session: SessionRow;
  /** True if a container was launched (new or resumed session). */
  launched: boolean;
  /** Milliseconds between the `podman run` and the container's `/healthz`. */
  healthyInMs: number | null;
  /** The cookie token, returned once: it has no reason to come out again. */
  cookieToken: string;
}

/**
 * What the caller brings in addition to the (student, assignment) pair.
 * Everything is optional: the standalone portal's Start button sets none of
 * them, classroom's launch token sets them all.
 */
export interface StartOptions {
  /** The session was born from an SEB verification (invariant 5). */
  sebVerified?: boolean;
  /** Teacher who carries the quota, copied from the assignment. */
  teacherId?: string | null;
  /** `jti` of the launch token, for the audit trail. */
  launchJti?: string | null;
  /** Student repository brought by the token; replaces the assignment's convention. */
  targetRepo?: AssignmentRepoRef | null;
}

export interface SessionManager {
  start(user: UserRow, assignment: AssignmentRow, opts?: StartOptions): Promise<StartResult>;
  /** Restarts the container if it has vanished; otherwise does nothing. */
  ensureRunning(sessionId: string): Promise<SessionRow>;
  close(sessionId: string, reason: string): Promise<void>;
  touch(sessionId: string, at?: Date): void;
  /** Checks a session's cookie token, in constant time. */
  checkCookie(session: SessionRow, token: string | undefined): boolean;
  reconcile(): Promise<{ resumed: number; stopped: number; orphans: number }>;
  collect(now?: Date): Promise<{ closed: number }>;
  snapshotAll(): Promise<{ committed: number; skipped: number }>;
  startTimers(): void;
  stopTimers(): Promise<void>;
  /** For `git/httpBackend.ts`: the container's address authenticates the session. */
  readonly lookup: SessionLookup;
  /**
   * For `git/relay.ts`: where to relay an event's pushes. The session decides
   * (it carries the token's repository); the assignment is only a fallback.
   */
  repoOfEvent(row: { sessionId?: string; student: string; assignment: string }): RepoRef | undefined;
}

/** Deterministic container name: reconciliation finds it on its own. */
export function containerNameFor(sessionId: string): string {
  return `cs-${sessionId}`;
}

/**
 * Invariant 6. The assignment's mode alone decides the source, and exam mode
 * has only one possible branch.
 */
export function stagingSourceFor(
  assignment: AssignmentRow,
  targetRepoUrl: string | undefined,
): StagingSource {
  if (assignment.mode === "exam") {
    if (!assignment.templateRepo) {
      throw new Error(
        `assignment ${assignment.id} in exam mode without a template repository: refusing to seed otherwise`,
      );
    }
    return { mode: "exam", templateFrom: assignment.templateRepo };
  }
  const from = targetRepoUrl ?? assignment.templateRepo;
  return from ? { mode: "lab", mirrorFrom: from } : { mode: "empty" };
}

/**
 * **The only** environment variables the portal sets on a student container,
 * in addition to those of the image. Invariant 1: no secret leaves the portal,
 * and this list is what a test asserts.
 *
 * The three `CODESPACE_` ones are read by `heig.codespace-statusbar`, the
 * status-bar extension baked into the image (`images/c-dev/extension`).
 *
 * The four `GIT_` ones are the student's identity (`users.display_name`,
 * `users.email`). Git honours them **without any configuration file at all**,
 * so a `git commit` from the terminal as well as from VS Code's git extension
 * carries the student's name and academic address. They are not secrets: the
 * student already reads both of them in classroom.
 */
export const CONTAINER_ENV_KEYS = [
  "CODESPACE_DEADLINE",
  "CODESPACE_RETURN_URL",
  "CODESPACE_ASSIGNMENT_NAME",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

/** Base URL made absolute, or `undefined` if it cannot be used. */
function rootUrl(base: string | undefined): string | undefined {
  if (!base || base.trim() === "") return undefined;
  try {
    return new URL("/", base).href;
  } catch {
    return undefined;
  }
}

/**
 * What the container learns about its session, and nothing more.
 *
 *  - `CODESPACE_DEADLINE`: the assignment's deadline (classroom's `deadlineAt`,
 *    stored in `assignments.closesAt`). Absent when the assignment has none:
 *    the extension then shows no countdown;
 *  - `CODESPACE_RETURN_URL`: classroom for a session born from a launch token
 *    (`launchJti`), the portal otherwise. That is where the "Close" button
 *    takes you back;
 *  - `CODESPACE_ASSIGNMENT_NAME`: the assignment title, shown in the tooltip.
 *
 * None of these values is a secret, and there is no fourth one.
 */
export function containerEnvFor(
  session: Pick<SessionRow, "launchJti">,
  assignment: Pick<AssignmentRow, "title" | "closesAt">,
  urls: { classroomUrl?: string; publicUrl?: string },
  user?: Pick<UserRow, "displayName" | "email" | "login"> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (assignment.closesAt) env.CODESPACE_DEADLINE = assignment.closesAt.toISOString();
  // The session comes from classroom if and only if a launch token opened or
  // resumed it: `launchJti` is what says so, not the assignment.
  const back = rootUrl(session.launchJti ? urls.classroomUrl : urls.publicUrl);
  if (back) env.CODESPACE_RETURN_URL = back;
  if (assignment.title.trim() !== "") env.CODESPACE_ASSIGNMENT_NAME = assignment.title;
  const identity = user ? gitIdentityOf(user) : null;
  if (identity) {
    env.GIT_AUTHOR_NAME = identity.name;
    env.GIT_AUTHOR_EMAIL = identity.email;
    env.GIT_COMMITTER_NAME = identity.name;
    env.GIT_COMMITTER_EMAIL = identity.email;
  }
  return env;
}

/**
 * A student's git identity, or `null` if they have none that can be used.
 *
 * **All or nothing**: an address without a name, or the other way round, would
 * make git fall back to its automatic detection (`student@<container name>`)
 * for the missing half, which is worse than a plain absence. `display_name` is
 * what classroom's launch token brings; the institutional login takes over
 * when it is empty.
 */
export function gitIdentityOf(
  user: Pick<UserRow, "displayName" | "email" | "login">,
): GitIdentity | null {
  const name = user.displayName.trim() !== "" ? user.displayName.trim() : user.login.trim();
  const email = user.email.trim();
  if (name === "" || email === "") return null;
  return { name, email };
}

export interface ManagerDeps extends ManagerOptions {
  /** Clone URL of a student's target repository, for the mirror in lab mode. */
  forgeUrlOf?: (repo: RepoRef) => string;
  /**
   * The forge's `Authorization` header for the given repository. A student
   * repository provisioned by classroom is **private**: without it, the seeding
   * `git fetch` is refused and the workspace opens empty. Throws
   * `ForgeUnconfiguredError` when the forge has no credentials: the fetch is
   * then attempted anonymously, which is enough for a public repository, and
   * the cause is kept for the error page should the fetch fail.
   */
  forgeAuthorization?: (repo: RepoRef) => Promise<string>;
}

/**
 * The session's workspace could not be prepared. **The session does not
 * start**: no container is launched and the student gets a page that names the
 * cause. Opening an editor on an empty directory, as the portal did up to
 * 2026-09-17, is the worst possible behaviour — nothing signals that the
 * repository is missing and the student works beside their submission.
 *
 * `shortCause` is the sentence shown to the student (kept in French, it is
 * rendered into the student page); `message` carries the detail (already
 * stripped of any token) for the `warn` log.
 */
export class WorkspaceBootstrapError extends Error {
  constructor(
    readonly shortCause: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceBootstrapError";
  }
}

/**
 * Default branch of the student's repository, as classroom announces it in the
 * launch token. It decides two things: the `HEAD` of the staging repository,
 * hence what `git clone` would check out, and the local branch of `work/` with
 * its tracking.
 *
 * It is **not** `main` by convention. Measured in production: the repository
 * `heig-test-classroom2/labo-02-quadratic-yves-chevallier` is on `master`,
 * and it also carries a `grading` branch written by classroom's CI.
 * Without this value, `pickHead` did not find `main` and fell back on the
 * first branch that came — `grading`, that is to say the grading report rather
 * than the work.
 */
export function defaultBranchOf(
  session: Pick<SessionRow, "targetRepo">,
  assignment: Pick<AssignmentRow, "mode" | "sourceRepo">,
): string {
  // Invariant 6: in exam mode the source is the teacher's template, hence
  // their own branch, not that of the student's repository.
  if (assignment.mode === "exam") return assignment.sourceRepo?.defaultBranch ?? "main";
  return session.targetRepo?.defaultBranch ?? assignment.sourceRepo?.defaultBranch ?? "main";
}

/** `https://github.com/org/depot.git` → `{ owner: "org", name: "depot" }`. */
export function repoRefFromUrl(url: string): RepoRef | undefined {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url);
  const owner = m?.[1];
  const name = m?.[2];
  return owner && name ? { owner, name } : undefined;
}

/** What the student reads on the refusal page. Short, and free of git jargon. Kept in French: this text is rendered into the student page. */
export function shortCauseOf(err: unknown, repo: RepoRef | undefined): string {
  const where = repo ? `${repo.owner}/${repo.name}` : "le dépôt source";
  if (err instanceof ForgeUnconfiguredError) {
    return `le portail n'a pas les accès à ${where}`;
  }
  const text = String((err as Error | undefined)?.message ?? err);
  if (/not found|n'existe pas|does not exist|\b404\b/i.test(text)) {
    return `dépôt ${where} introuvable`;
  }
  if (/authentication|denied|forbidden|unauthorized|\b401\b|\b403\b/i.test(text)) {
    return `accès refusé au dépôt ${where}`;
  }
  return `récupération de ${where} impossible`;
}

export function createSessionManager(opts: ManagerDeps): SessionManager {
  const { db, engine, log } = opts;
  let gcTimer: NodeJS.Timeout | null = null;
  let shadowTimer: NodeJS.Timeout | null = null;
  /** One session at a time: two concurrent `start` calls launch only one container. */
  const inFlight = new Map<string, Promise<SessionRow>>();

  function assignmentOf(session: SessionRow): AssignmentRow {
    const row = findAssignment(db, session.assignmentId);
    if (!row) throw new Error(`assignment ${session.assignmentId} not found`);
    return row;
  }

  /**
   * Seeds the staging repository. **Loud failure**: no more silent fallback on
   * an empty repository. An unreachable mirror, a repository that does not
   * exist or a forge without credentials all cause the session to be refused,
   * with a named cause.
   *
   * Two subtleties, both documented in `docs/deploy.md` § 5:
   *
   *  - a **target repository with no branch at all** in lab mode is legitimate
   *    (classroom has just created it): the `fetch` succeeds, reports zero
   *    refs, the workspace opens empty and the log says so at `info` level. In
   *    exam mode it is on the contrary an error: the student would not have the
   *    assignment statement;
   *  - the lab-mode mirror is fetched **only at the first seeding**, as long as
   *    the staging repository has no ref. Redoing it at every opening would
   *    bring the forge's refs back on top of those the student has pushed but
   *    that the relay has not yet passed on. In exam mode it always is: that is
   *    how a fix to the statement propagates (invariant 6).
   */
  async function seedStaging(
    session: SessionRow,
    assignment: AssignmentRow,
  ): Promise<StagingResult> {
    const paths = stagingPaths(opts.volumesRoot, session.student, assignment.id);
    const repo = targetRepoOfSession(session, assignment);
    const targetUrl = repo && opts.forgeUrlOf ? opts.forgeUrlOf(repo) : undefined;
    const wanted = stagingSourceFor(assignment, targetUrl);

    const already = await refSnapshot(paths.gitDir).catch(() => new Map<string, string>());
    const source: StagingSource =
      wanted.mode === "lab" && already.size > 0 ? { mode: "empty" } : wanted;
    const from =
      source.mode === "lab" ? source.mirrorFrom : source.mode === "exam" ? source.templateFrom : null;
    const sourceRepo = from ? repoRefFromUrl(from) : undefined;

    // The forge may have no credentials at all: the fetch is then attempted
    // anonymously (a public repository works), and the cause is kept at hand.
    let authorization: string | undefined;
    let authError: unknown;
    if (sourceRepo && opts.forgeAuthorization) {
      try {
        authorization = await opts.forgeAuthorization(sourceRepo);
      } catch (err) {
        authError = err;
      }
    }

    try {
      const result = await ensureStagingRepo({
        volumesRoot: opts.volumesRoot,
        student: session.student,
        assignment: assignment.id,
        source,
        uploadPack: assignment.uploadPack,
        defaultBranch: defaultBranchOf(session, assignment),
        ...(authorization ? { authorization } : {}),
      });
      if (result.refs === 0 && wanted.mode === "exam") {
        throw new WorkspaceBootstrapError(
          "le modèle de l'enseignant ne contient aucune branche",
          `template ${from ?? "?"} without a ref: the exam has no statement to hand out`,
        );
      }
      if (result.refs === 0 && wanted.mode === "lab") {
        log.info(
          { sessionId: session.id, repo: sourceRepo ?? null },
          "target repository with no branch at all: empty workspace, which is normal in lab mode",
        );
      }
      return result;
    } catch (err) {
      if (err instanceof WorkspaceBootstrapError) {
        log.warn({ sessionId: session.id, err: err.message }, "staging repository seeding refused");
        throw err;
      }
      const detail = redactSecrets(String((err as Error).message ?? err));
      const cause = shortCauseOf(authError ?? err, sourceRepo ?? repo);
      log.warn(
        {
          sessionId: session.id,
          student: session.student,
          assignment: assignment.id,
          repo: sourceRepo ?? repo ?? null,
          mode: wanted.mode,
          forge: authError ? redactSecrets(String((authError as Error).message ?? authError)) : null,
          err: detail,
        },
        "staging repository seeding impossible: the session does not start",
      );
      throw new WorkspaceBootstrapError(cause, detail);
    }
  }

  /**
   * Completes the workspace **from inside the container**, when `:U` has given
   * ownership of it to the container's UID range and the portal can no longer
   * write there (resumption of a session whose first seeding had failed).
   *
   * No secret gets in: the `fetch` goes to `portal.internal:9418`, which the
   * source IP address authenticates (invariant 1).
   *
   * A failure is logged at `warn` level but **does not close the session**: if
   * the student has already written a file that the repository brings,
   * `checkout` refuses — an incomplete workspace is better than a student
   * deprived of what they wrote.
   */
  async function finishWorkspace(
    session: SessionRow,
    workspace: EnsureWorkspaceResult,
  ): Promise<void> {
    if (!workspace.needsContainer || !workspace.branch) return;
    const name = session.containerName ?? containerNameFor(session.id);
    try {
      const out = await engine.exec(name, ["sh", "-lc", completionScript(workspace.branch)]);
      log.info(
        { sessionId: session.id, branch: workspace.branch, head: out.trim().split("\n").pop() },
        "workspace completed inside the container (resumption)",
      );
    } catch (err) {
      log.warn(
        {
          sessionId: session.id,
          branch: workspace.branch,
          err: redactSecrets(String((err as Error).message ?? err)),
        },
        "completing the workspace inside the container impossible",
      );
    }
  }

  /**
   * Sets the git identity **inside the container** when the host can no longer
   * write to `work/.git/config` (same constraint as `finishWorkspace`).
   *
   * No secret gets in: a student's name and an academic address. A failure is
   * logged and closes nothing — the `GIT_*` variables set at `podman run` are
   * already enough for `git commit`, this is only the version readable through
   * `git config user.name`.
   */
  async function ensureIdentityInContainer(
    session: SessionRow,
    identity: GitIdentity | null,
  ): Promise<void> {
    if (!identity) return;
    const name = session.containerName ?? containerNameFor(session.id);
    try {
      await engine.exec(name, ["sh", "-lc", identityScript(identity)]);
    } catch (err) {
      log.warn(
        { sessionId: session.id, err: redactSecrets(String((err as Error).message ?? err)) },
        "git identity not set in work/.git/config",
      );
    }
  }

  /** Launches the container and waits for its `/healthz`. */
  async function launch(
    session: SessionRow,
    assignment: AssignmentRow,
  ): Promise<{ session: SessionRow; healthyInMs: number }> {
    const paths = stagingPaths(opts.volumesRoot, session.student, assignment.id);
    const user = findUser(db, session.userId);
    const identity = user ? gitIdentityOf(user) : null;
    // **Before** the `podman run`: after it, `:U` has given `work/` to the
    // container's UID range and the portal no longer writes there (see
    // workspace.ts).
    const workspace = await ensureWorkspace({
      paths,
      sessionId: session.id,
      gitRemoteHost: opts.gitRemoteHost,
      gitRemotePort: opts.gitRemotePort,
      ...(identity ? { identity } : {}),
      log: opts.log,
    });
    const name = containerNameFor(session.id);
    const info = await engine.run({
      sessionId: session.id,
      name,
      workDir: paths.workDir,
      env: containerEnvFor(
        session,
        assignment,
        {
          ...(opts.classroomUrl !== undefined ? { classroomUrl: opts.classroomUrl } : {}),
          ...(opts.publicUrl !== undefined ? { publicUrl: opts.publicUrl } : {}),
        },
        user,
      ),
      ...(assignment.image ? { image: assignment.image } : {}),
    });
    if (!info.ip) {
      await engine.rm(name);
      updateSession(db, session.id, { state: "failed" });
      throw new Error(`container ${name} without an address on the codespace network`);
    }
    const healthyInMs = await engine.waitHealthy(info.ip, opts.healthTimeoutMs);
    const updated = updateSession(db, session.id, {
      containerId: info.id,
      containerName: info.name,
      containerIp: info.ip,
      state: "running",
      lastSeen: new Date(),
    });
    // Resumption of a volume whose `work/` already belongs to the container:
    // this is the only moment when completion is possible, the container having
    // just been born. Identity first: it conditions every commit to come.
    if (workspace.needsIdentity) await ensureIdentityInContainer(updated, identity);
    await finishWorkspace(updated, workspace);
    return { session: updated, healthyInMs };
  }

  /** Fields the launch token brings, set both at creation and at resumption. */
  function launchPatch(startOpts: StartOptions): Partial<SessionRow> {
    const patch: Partial<SessionRow> = {};
    if (startOpts.teacherId !== undefined) patch.teacherId = startOpts.teacherId;
    if (startOpts.launchJti !== undefined) patch.launchJti = startOpts.launchJti;
    if (startOpts.targetRepo !== undefined) patch.targetRepo = startOpts.targetRepo;
    return patch;
  }

  async function startInner(
    user: UserRow,
    assignment: AssignmentRow,
    startOpts: StartOptions,
  ): Promise<StartResult> {
    const sebVerified = startOpts.sebVerified ?? false;
    const patch = launchPatch(startOpts);
    // One row per (student, assignment) pair, whatever its state: this is what
    // makes the session id **stable for the lifetime of the volume**, hence the
    // `origin` remote written into `work/` still valid after a close and a
    // reopen. The portal could not rewrite it: after the first `:U`,
    // `work/.git/config` no longer belongs to it.
    const existing = findAnySession(db, user.login, assignment.id);
    const paths = stagingPaths(opts.volumesRoot, user.login, assignment.id);

    if (existing) {
      // D5: every new opening comes back to the live session.
      const alive =
        existing.state === "running" &&
        existing.containerName !== null &&
        (await engine.inspect(existing.containerName))?.state === "running";
      if (alive) {
        // The container is already running: it is not restarted (invariant
        // 10). But a staging repository **with no ref at all** is the symptom of
        // a missed seeding, and that is exactly the state left by the first real
        // trial of 2026-09-17. It is redone, and the workspace is completed
        // inside the live container. Nothing can be overwritten: by
        // construction, there was nothing.
        const identity = gitIdentityOf(user);
        const refs = await refSnapshot(paths.gitDir).catch(() => new Map<string, string>());
        if (refs.size === 0) {
          await seedStaging(existing, assignment);
          const workspace = await ensureWorkspace({
            paths,
            sessionId: existing.id,
            gitRemoteHost: opts.gitRemoteHost,
            gitRemotePort: opts.gitRemotePort,
            ...(identity ? { identity } : {}),
            log: opts.log,
          });
          await finishWorkspace(existing, workspace);
        }
        // The live container will not receive new `GIT_*` variables — they are
        // set at `podman run` — but `work/.git/config` can still be repaired,
        // and that is what `git config user.name` reads.
        await ensureIdentityInContainer(existing, identity);
        const touched = updateSession(db, existing.id, { ...patch, lastSeen: new Date() });
        return {
          session: touched,
          launched: false,
          healthyInMs: null,
          cookieToken: existing.cookieToken,
        };
      }
      const revived = updateSession(db, existing.id, {
        ...patch,
        state: "starting",
        sebVerified: sebVerified || existing.sebVerified,
        lastSeen: new Date(),
      });
      try {
        await seedStaging(revived, assignment);
        const { session, healthyInMs } = await launch(revived, assignment);
        log.info({ sessionId: session.id, student: user.login }, "session resumed on its volume");
        return { session, launched: true, healthyInMs, cookieToken: revived.cookieToken };
      } catch (err) {
        // The session stays resumable: its volume is intact and nothing was
        // launched. `stopped` keeps it live in the sense of D5, unlike `failed`
        // which would take it out of the (student, assignment) pair.
        updateSession(db, existing.id, { state: "stopped", containerIp: null, containerId: null });
        throw err;
      }
    }

    const id = randomUUID();
    const cookieToken = randomBytes(32).toString("base64url");
    const now = new Date();
    const [created] = db
      .insert(sessions)
      .values({
        id,
        userId: user.id,
        student: user.login,
        assignmentId: assignment.id,
        volumeDir: paths.dir,
        state: "starting",
        createdAt: now,
        lastSeen: now,
        cookieToken,
        sebVerified,
        teacherId: startOpts.teacherId ?? assignment.teacherId,
        launchJti: startOpts.launchJti ?? null,
        targetRepo: startOpts.targetRepo ?? null,
      })
      .returning()
      .all();
    if (!created) throw new Error("session creation returned no row");
    try {
      await seedStaging(created, assignment);
      const { session, healthyInMs } = await launch(created, assignment);
      log.info({ sessionId: session.id, student: user.login }, "session created");
      return { session, launched: true, healthyInMs, cookieToken };
    } catch (err) {
      updateSession(db, id, { state: "failed" });
      throw err;
    }
  }

  const manager: SessionManager = {
    async start(user, assignment, startOpts = {}) {
      const key = `${user.login} ${assignment.id}`;
      const pending = inFlight.get(key);
      if (pending) {
        const session = await pending;
        return {
          session,
          launched: false,
          healthyInMs: null,
          cookieToken: session.cookieToken,
        };
      }
      let resolve!: (s: SessionRow) => void;
      let reject!: (e: unknown) => void;
      const shared = new Promise<SessionRow>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // Without this `catch`, a start failure with no second caller becomes an
      // unhandled rejection and kills the process.
      shared.catch(() => undefined);
      inFlight.set(key, shared);
      try {
        const result = await startInner(user, assignment, startOpts);
        resolve(result.session);
        return result;
      } catch (err) {
        reject(err);
        throw err;
      } finally {
        inFlight.delete(key);
      }
    },

    async ensureRunning(sessionId) {
      const session = findSession(db, sessionId);
      if (!session) throw new Error(`session ${sessionId} unknown`);
      if (session.state === "closed" || session.state === "failed") {
        throw new Error(`session ${sessionId} closed`);
      }
      const name = session.containerName ?? containerNameFor(session.id);
      const info = await engine.inspect(name);
      if (info?.state === "running" && info.ip) {
        if (info.ip !== session.containerIp || session.state !== "running") {
          return updateSession(db, session.id, {
            state: "running",
            containerIp: info.ip,
            containerId: info.id,
            containerName: info.name,
          });
        }
        return session;
      }
      // Dead container, live session: relaunch on the same volume.
      log.warn({ sessionId }, "container missing for a live session, relaunching");
      const assignment = assignmentOf(session);
      await seedStaging(session, assignment);
      const { session: relaunched } = await launch(session, assignment);
      return relaunched;
    },

    async close(sessionId, reason) {
      const session = findSession(db, sessionId);
      if (!session) return;
      // Last snapshot before losing the container: without it, a session closed
      // right after a keystroke would have nothing in shadow.git.
      await snapshot(session.volumeDir).catch((err: unknown) => {
        log.warn(
          { sessionId, err: String((err as Error).message ?? err) },
          "closing snapshot impossible",
        );
        return null;
      });
      const name = session.containerName ?? containerNameFor(session.id);
      await engine.stop(name);
      await engine.rm(name);
      updateSession(db, sessionId, {
        state: "closed",
        containerIp: null,
        containerId: null,
      });
      log.info({ sessionId, reason }, "session closed, volume kept");
    },

    touch(sessionId, at = new Date()) {
      db.update(sessions).set({ lastSeen: at }).where(eq(sessions.id, sessionId)).run();
    },

    checkCookie(session, token) {
      if (!token) return false;
      const a = Buffer.from(session.cookieToken, "utf8");
      const b = Buffer.from(token, "utf8");
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    },

    async reconcile() {
      const containers = await engine.listSessions();
      const bySession = new Map(containers.map((c) => [c.sessionId ?? "", c]));
      const live = listLiveSessions(db);
      let resumed = 0;
      let stopped = 0;
      let orphans = 0;

      for (const session of live) {
        const container = bySession.get(session.id);
        if (container && container.state === "running" && container.ip) {
          updateSession(db, session.id, {
            state: "running",
            containerId: container.id,
            containerName: container.name,
            containerIp: container.ip,
          });
          resumed += 1;
          continue;
        }
        if (container) await engine.rm(container.name || container.id);
        // Volume kept: the session is resumed at the next access.
        updateSession(db, session.id, { state: "stopped", containerIp: null, containerId: null });
        stopped += 1;
      }

      const liveIds = new Set(live.map((s) => s.id));
      for (const container of containers) {
        if (container.sessionId && liveIds.has(container.sessionId)) continue;
        await engine.rm(container.name || container.id);
        orphans += 1;
      }
      log.info({ resumed, stopped, orphans }, "Podman ↔ database reconciliation");
      return { resumed, stopped, orphans };
    },

    async collect(now = new Date()) {
      const deadline = now.getTime() - opts.graceMs;
      let closed = 0;
      for (const session of listLiveSessions(db)) {
        if (session.lastSeen.getTime() > deadline) continue;
        await manager.close(session.id, "grace period elapsed");
        closed += 1;
      }
      return { closed };
    },

    async snapshotAll() {
      let committed = 0;
      let skipped = 0;
      for (const session of listLiveSessions(db)) {
        try {
          const result = await snapshot(session.volumeDir);
          if (result.sha) committed += 1;
          else skipped += 1;
          if (result.unreadable.length > 0) {
            log.warn(
              { sessionId: session.id, unreadable: result.unreadable },
              "partial snapshot: paths unreadable by the portal (see sessions/shadow.ts)",
            );
          }
        } catch (err) {
          skipped += 1;
          log.warn(
            { sessionId: session.id, err: String((err as Error).message ?? err) },
            "snapshot impossible",
          );
        }
      }
      return { committed, skipped };
    },

    startTimers() {
      if (!gcTimer) {
        gcTimer = setInterval(() => {
          void manager
            .collect()
            .catch((err: unknown) => log.error({ err }, "garbage collection failed"));
        }, opts.gcIntervalMs);
        gcTimer.unref();
      }
      if (!shadowTimer) {
        shadowTimer = setInterval(() => {
          void manager
            .snapshotAll()
            .catch((err: unknown) => log.error({ err }, "snapshots failed"));
        }, opts.shadowIntervalMs);
        shadowTimer.unref();
      }
    },

    async stopTimers() {
      if (gcTimer) clearInterval(gcTimer);
      if (shadowTimer) clearInterval(shadowTimer);
      gcTimer = null;
      shadowTimer = null;
    },

    lookup: {
      async bySessionId(sessionId: string): Promise<StagingSession | undefined> {
        const session = findSession(db, sessionId);
        if (!session || session.containerIp === null) return undefined;
        if (session.state !== "running" && session.state !== "starting") return undefined;
        const assignment = findAssignment(db, session.assignmentId);
        if (!assignment) return undefined;
        const repo = targetRepoOfSession(session, assignment);
        return {
          sessionId: session.id,
          student: session.student,
          assignment: session.assignmentId,
          containerIp: session.containerIp,
          uploadPack: assignment.uploadPack,
          ...(repo ? { targetRepo: repo } : {}),
        };
      },
    },

    repoOfEvent(row) {
      const assignment = findAssignment(db, row.assignment);
      // The launch token's repository, when the session carries one; the
      // assignment's convention otherwise. The session is looked up by its id,
      // not by the pair, because it survives its own closing: the relay must
      // stay correct right after the container has been destroyed.
      const session = row.sessionId ? findSession(db, row.sessionId) : undefined;
      if (session) return targetRepoOfSession(session, assignment);
      if (!assignment) return undefined;
      return targetRepoOfSession({ targetRepo: null, student: row.student }, assignment);
    },
  };

  return manager;
}
