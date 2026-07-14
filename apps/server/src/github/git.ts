/**
 * Single git CLI wrapper for the GitHub plumbing (squash, provision, sync).
 * `identity: true` sets the bot committer, needed wherever commits are
 * created; plain clone/push runners skip it.
 */
import { execFileSync } from "node:child_process";

const BOT_IDENTITY = ["-c", "user.name=hgc", "-c", "user.email=bot@hgc.local"];

/**
 * Git failures echo the remote URL, which embeds the installation token
 * (authUrl below): redact it before the message can reach the logs, the
 * `provision_error` column or a teacher-facing tooltip. Tokens expire after
 * an hour, but they must never be persisted at all.
 */
export function redactTokens(text: string): string {
  return text
    .replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@")
    .replace(/\bgh[a-z]_[A-Za-z0-9_]+/g, "gh*_***");
}

function run(args: string[]): string {
  try {
    return execFileSync("git", args, { stdio: "pipe" })?.toString() ?? "";
  } catch (err) {
    // execFileSync appends the captured stderr to the message: redact the
    // whole thing and drop the original error (its `cmd`/`stderr` fields
    // still carry the token).
    throw new Error(redactTokens(String((err as Error).message ?? err)));
  }
}

export interface GitRunner {
  git: (cwd: string, ...args: string[]) => string;
  /** Bare repository: explicit `--git-dir` (compatible with `safe.bareRepository=explicit`). */
  gitBare: (gitDir: string, ...args: string[]) => string;
}

export function gitRunner(opts: { identity?: boolean } = {}): GitRunner {
  const extra = opts.identity ? BOT_IDENTITY : [];
  return {
    git: (cwd, ...args) => run(["-C", cwd, ...extra, ...args]),
    gitBare: (gitDir, ...args) => run(["--git-dir", gitDir, ...extra, ...args]),
  };
}

/** Installation-token remote URL (GH-03). */
export const authUrl = (token: string, org: string, repo: string) =>
  `https://x-access-token:${token}@github.com/${org}/${repo}.git`;
