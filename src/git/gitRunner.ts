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
    .replace(/(https?:\/\/)[^/\s@]+@/g, "$1***@")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+/g, "gh*_***");
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
