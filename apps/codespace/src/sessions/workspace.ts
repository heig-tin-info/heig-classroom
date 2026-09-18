/**
 * Seeding of the `<vol>/work` workspace: a clone of the staging repository,
 * with `origin` pointed at the portal's Git channel.
 *
 * **Timing matters.** This function runs *before* the `podman run`: after it,
 * the `:U` option has given `work/` to the UID range that `--userns=auto` drew
 * for the container, and the portal (uid `codespace`) can no longer create or
 * modify a file there — in particular not `work/.git/config`. This is the same
 * constraint as the one described in `shadow.ts`, seen from the write side.
 *
 * Consequence carried by `manager.ts`: the session id is **stable for the
 * lifetime of the volume**, because the `origin` remote written here contains
 * it and it will never be rewritten.
 *
 * Three states are distinguished, and that is the 2026-09-17 fix:
 *
 *  - `work/.git` absent → full seeding from the staging repository;
 *  - `work/.git` present but **with no commit at all** (the case of a session
 *    whose staging repository was empty at the first start, for lack of a token
 *    to fetch the student's private repository) → it is completed: fetch, local
 *    branch on the default branch, tracking `origin/<branch>`. The untracked
 *    files the student has already created are kept — `checkout -B` from an
 *    unborn branch does not touch them;
 *  - same case, but `work/` already belongs to the container: completion is
 *    impossible from the host and `manager.ts` does it through `engine.exec`
 *    after the start (`completionScript`).
 *
 * A repository that already carries at least one commit is **never** touched
 * again: the student owns their repository.
 */
import { access, constants } from "node:fs/promises";
import { join } from "node:path";

import { git, stagingHeadBranch, type StagingPaths } from "../git/index.js";

const IDENTITY = {
  GIT_AUTHOR_NAME: "codespace-portal",
  GIT_AUTHOR_EMAIL: "portal@codespace.local",
  GIT_COMMITTER_NAME: "codespace-portal",
  GIT_COMMITTER_EMAIL: "portal@codespace.local",
} as const;

/**
 * The student's git identity, as the `users` table knows it (`display_name`,
 * `email`). It is not a secret: it is the name and the academic address the
 * student already reads in classroom.
 */
export interface GitIdentity {
  name: string;
  email: string;
}

export interface WorkspaceOptions {
  paths: StagingPaths;
  sessionId: string;
  /** `portal.internal`: the name `--add-host` gives to the gateway. */
  gitRemoteHost: string;
  gitRemotePort: number;
  /**
   * Identity to write into `work/.git/config` if it is not there already. The
   * container's `GIT_AUTHOR_*` / `GIT_COMMITTER_*` variables are enough for
   * `git commit`, but the student who types `git config user.name` must read
   * something, and an identity set by the student themselves is never
   * overwritten.
   */
  identity?: GitIdentity;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

export function remoteUrl(host: string, port: number, sessionId: string): string {
  return `http://${host}:${port}/git/${sessionId}`;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * `work/` belongs to the container's UID range from the first `:U` on, and the
 * portal no longer writes there. This is measured rather than deduced from the
 * session state: an aborted `podman run` leaves a directory still ours.
 */
async function writable(path: string): Promise<boolean> {
  return access(path, constants.W_OK | constants.X_OK).then(
    () => true,
    () => false,
  );
}

/**
 * `safe.directory`: after the first `:U`, `work/` no longer belongs to the
 * portal and git refuses to work there ("detected dubious ownership"). `HOME`
 * being already neutralised by `gitRunner`, there is no global configuration
 * where the exception could be set: it is set on the call itself.
 */
function gitWork(workDir: string, args: string[]): Promise<string> {
  return git(["-c", `safe.directory=${workDir}`, "-C", workDir, ...args], { env: IDENTITY });
}

export interface WorkspaceState {
  /** `work/.git` exists. */
  present: boolean;
  /** The portal can still write there (before the first `:U`). */
  writable: boolean;
  /** `HEAD` points at a commit. False for an unborn branch. */
  born: boolean;
  /** Current branch, even unborn. */
  branch: string | null;
  /** `@{upstream}` resolved, `null` if the branch has no tracking. */
  upstream: string | null;
}

/** What the portal can read from `work/` without writing to it. */
export async function inspectWorkspace(workDir: string): Promise<WorkspaceState> {
  const present = await exists(join(workDir, ".git"));
  const canWrite = await writable(workDir);
  if (!present) {
    return { present: false, writable: canWrite, born: false, branch: null, upstream: null };
  }
  const head = (
    await gitWork(workDir, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "")
  ).trim();
  const branch = (await gitWork(workDir, ["branch", "--show-current"]).catch(() => "")).trim();
  const upstream = (
    await gitWork(workDir, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]).catch(() => "")
  ).trim();
  return {
    present: true,
    writable: canWrite,
    born: head !== "",
    branch: branch === "" ? null : branch,
    upstream: upstream === "" ? null : upstream,
  };
}

/** An arbitrary value, made harmless for `sh -lc`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Sets `user.name` / `user.email` in `work/.git/config`, **never overwriting**
 * what is already there: if the student has set their own, it stays. Called
 * from the host, hence only as long as `work/` belongs to us (before the first
 * `:U`).
 */
async function writeIdentity(workDir: string, identity: GitIdentity): Promise<void> {
  const present = async (key: string): Promise<boolean> =>
    (await gitWork(workDir, ["config", "--local", "--get", key]).catch(() => "")).trim() !== "";
  if (!(await present("user.name"))) {
    await gitWork(workDir, ["config", "--local", "user.name", identity.name]);
  }
  if (!(await present("user.email"))) {
    await gitWork(workDir, ["config", "--local", "user.email", identity.email]);
  }
}

/**
 * The same thing, played **inside the container** when `work/` no longer
 * belongs to us. No secret gets in: a name and an academic address.
 *
 * The script exits without doing anything when `/work` is not a repository —
 * the case of an assignment without a staging repository — and touches nothing
 * when the student has already set their identity.
 */
export function identityScript(identity: GitIdentity): string {
  const name = shellQuote(identity.name);
  const email = shellQuote(identity.email);
  return [
    "set -e",
    "cd /work",
    "git rev-parse --git-dir >/dev/null 2>&1 || exit 0",
    `git config --local --get user.name >/dev/null 2>&1 || git config --local user.name ${name}`,
    `git config --local --get user.email >/dev/null 2>&1 || git config --local user.email ${email}`,
    "git config --local --get user.name",
    "git config --local --get user.email",
  ].join("\n");
}

/**
 * Completion script, played **inside the container** when `work/` no longer
 * belongs to us. It does what `ensureWorkspace` does from the host, with the
 * same guarantees:
 *
 *  - `fetch origin` goes through `http://portal.internal:9418/git/<session>`,
 *    which the source IP address authenticates: **no secret enters the
 *    container** (invariant 1);
 *  - `checkout -B` from an unborn branch keeps the untracked files the student
 *    has already written; it refuses rather than overwriting an untracked file
 *    the repository brings, and the message says so;
 *  - `--set-upstream-to` makes argument-less `git pull` and `git push` correct.
 */
export function completionScript(branch: string): string {
  return [
    "set -e",
    "cd /work",
    "git fetch -q origin '+refs/heads/*:refs/remotes/origin/*'",
    `git checkout -q -B '${branch}' 'origin/${branch}'`,
    `git branch -q --set-upstream-to='origin/${branch}' '${branch}'`,
    "git --no-pager log --oneline -1",
  ].join("\n");
}

export interface EnsureWorkspaceResult {
  /** `work/.git` was created by this call. */
  created: boolean;
  /** An existing repository, without a commit, was filled by this call. */
  completed: boolean;
  /** Local branch set, with tracking. `null`: the staging repository is empty. */
  branch: string | null;
  /**
   * Completion is still to be done and cannot be done from the host: `work/`
   * already belongs to the container. `manager.ts` picks it up through
   * `engine.exec` after the start.
   */
  needsContainer: boolean;
  /**
   * The git identity is still to be set and cannot be set from the host, for
   * the same reason. `manager.ts` then plays `identityScript` through
   * `engine.exec`.
   */
  needsIdentity: boolean;
}

export async function ensureWorkspace(opts: WorkspaceOptions): Promise<EnsureWorkspaceResult> {
  const work = opts.paths.workDir;
  const origin = remoteUrl(opts.gitRemoteHost, opts.gitRemotePort, opts.sessionId);
  const state = await inspectWorkspace(work);

  // The identity is set on a repository that already exists; for a repository
  // created further down, it is written right after the `init`. It depends
  // neither on the commits nor on the branch: a student whose workspace is
  // complete must be able to commit, and that is precisely the case observed in
  // production.
  let needsIdentity = false;
  if (opts.identity && state.present) {
    if (state.writable) await writeIdentity(work, opts.identity);
    else needsIdentity = true;
  }

  // A repository that carries commits belongs to the student: it is left alone.
  if (state.present && state.born) {
    return {
      created: false,
      completed: false,
      branch: state.branch,
      needsContainer: false,
      needsIdentity,
    };
  }

  const branch = await stagingHeadBranch(opts.paths.gitDir);
  if (state.present && branch === null) {
    // Staging repository still without a ref (empty target repository in lab
    // mode): nothing to set, the workspace stays the student's.
    return { created: false, completed: false, branch: null, needsContainer: false, needsIdentity };
  }
  if (state.present && !state.writable) {
    // Resumption of an already started session: `:U` gave `work/` to the container.
    return { created: false, completed: false, branch, needsContainer: true, needsIdentity };
  }

  if (!state.present) {
    await git(["init", "-q", "--initial-branch=main", work], { env: IDENTITY });
    await git(["-C", work, "remote", "add", "origin", origin], { env: IDENTITY });
    if (opts.identity) await writeIdentity(work, opts.identity);
  }
  // The content comes from the staging repository through the local path: the
  // portal has no reason to go through its own HTTP server to talk to itself.
  await gitWork(work, [
    "fetch",
    "-q",
    opts.paths.gitDir,
    "+refs/heads/*:refs/remotes/origin/*",
  ]).catch(() => "");
  const branches = (
    await gitWork(work, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/remotes/origin/",
    ]).catch(() => "")
  )
    .split("\n")
    .filter(Boolean);
  // The staging repository's default branch first — it is the student
  // repository's own, `master` as often as `main` — then `origin/main`, then
  // the first one that comes.
  const preferred =
    branch && branches.includes(`origin/${branch}`)
      ? `origin/${branch}`
      : branches.includes("origin/main")
        ? "origin/main"
        : branches[0];
  let local: string | null = null;
  if (preferred) {
    local = preferred.replace(/^origin\//, "");
    await gitWork(work, ["checkout", "-q", "-B", local, preferred]);
    // Tracking is what makes argument-less `git pull` and `git push` correct
    // inside the container; without it, the student has to name their remote and
    // their branch every time.
    await gitWork(work, ["branch", "-q", `--set-upstream-to=${preferred}`, local]).catch(() => "");
  }
  opts.log?.info(
    { sessionId: opts.sessionId, origin, branch: local, completed: state.present },
    state.present ? "workspace completed" : "workspace seeded",
  );
  return {
    created: !state.present,
    completed: state.present,
    branch: local,
    needsContainer: false,
    needsIdentity,
  };
}
