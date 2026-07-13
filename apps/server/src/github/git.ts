/**
 * Single git CLI wrapper for the GitHub plumbing (squash, provision, sync).
 * `identity: true` sets the bot committer, needed wherever commits are
 * created; plain clone/push runners skip it.
 */
import { execFileSync } from "node:child_process";

const BOT_IDENTITY = ["-c", "user.name=hgc", "-c", "user.email=bot@hgc.local"];

export interface GitRunner {
  git: (cwd: string, ...args: string[]) => string;
  /** Bare repository: explicit `--git-dir` (compatible with `safe.bareRepository=explicit`). */
  gitBare: (gitDir: string, ...args: string[]) => string;
}

export function gitRunner(opts: { identity?: boolean } = {}): GitRunner {
  const extra = opts.identity ? BOT_IDENTITY : [];
  return {
    git: (cwd, ...args) =>
      execFileSync("git", ["-C", cwd, ...extra, ...args], { stdio: "pipe" })?.toString() ?? "",
    gitBare: (gitDir, ...args) =>
      execFileSync("git", ["--git-dir", gitDir, ...extra, ...args], { stdio: "pipe" })?.toString() ??
      "",
  };
}

/** Installation-token remote URL (GH-03). */
export const authUrl = (token: string, org: string, repo: string) =>
  `https://x-access-token:${token}@github.com/${org}/${repo}.git`;
