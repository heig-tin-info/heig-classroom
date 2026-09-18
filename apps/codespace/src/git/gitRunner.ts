/**
 * The only place the Git channel spawns `git`. Async (the portal serves
 * proxy traffic on the same event loop, so `execFileSync` is out, unlike
 * heig-classroom's batch jobs) and token-redacting on the error path.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Git echoes the remote URL and, with `http.extraHeader`, sometimes the
 * header itself in `GIT_TRACE`-ish output. Anything that could carry a
 * credential is scrubbed before it can reach a log line or the
 * `push_events.last_error` column.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(Authorization:\s*\S+\s+)\S+/gi, "$1***")
    .replace(/(GIT_CONFIG_VALUE_\d+\s*=\s*)\S+/g, "$1***")
    .replace(/(https?:\/\/)[^/\s@]+@/g, "$1***@")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+/g, "gh*_***");
}

/**
 * The only vehicle carrying an authorization all the way to `git`.
 *
 * `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` is the
 * documented way to set `http.extraHeader` without a configuration file
 * (git ≥ 2.31). The token is then readable in `/proc/<pid>/environ` (root or
 * the same uid) but **not** in `cmdline`, and nothing is written to disk: the
 * two properties jalon-0 P3 asks for.
 *
 * Used by the relay (push to the forge) **and** by the seeding of the staging
 * repository (fetch of the student's repository in lab mode, of the template
 * in exam mode). The second one was missing, and that is what made the
 * workspace empty on the first real attempt in production: the student's
 * repository is private.
 */
export function gitAuthEnv(authorization: string): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`,
  };
}

export interface GitRunOptions {
  /** Extra environment; never put a credential in `args`. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
  ) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * Runs `git <args>` and returns stdout. `HOME` is cleared so a developer's
 * `~/.gitconfig` (aliases, `insteadOf`, a credential helper) cannot change
 * what the portal does on a student's repository.
 */
export async function git(args: string[], opts: GitRunOptions = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: "/nonexistent",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ASKPASS: "/bin/true",
        ...opts.env,
      },
      maxBuffer: 32 * 1024 * 1024,
      ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new GitError(redactSecrets(String(e.stderr || e.message || err)), args);
  }
}

/** `git --git-dir=<gitDir> <args>` on a bare repository. */
export const gitBare = (gitDir: string, args: string[], opts: GitRunOptions = {}) =>
  git(["--git-dir", gitDir, ...args], opts);
