/**
 * Source → squashed → student repositories synchronization (GH-50..53).
 * The squashed repo is brought up to date first (fast-forward for the
 * `whole` strategy, one primary commit for `squash`, GH-13), then each
 * student repository receives the squashed branch on its `sync/<branch>`
 * ref. That bot-only ref is the single place where a forced update is
 * allowed; the selected branches are never touched directly.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(cwd: string, ...args: string[]) {
  return (
    execFileSync(
      "git",
      ["-C", cwd, "-c", "user.name=hgc", "-c", "user.email=bot@hgc.local", ...args],
      { stdio: "pipe" },
    )?.toString() ?? ""
  );
}

/** Bare repository: explicit `--git-dir` (compatible with `safe.bareRepository=explicit`). */
function gitBare(gitDir: string, ...args: string[]) {
  return (
    execFileSync(
      "git",
      ["--git-dir", gitDir, "-c", "user.name=hgc", "-c", "user.email=bot@hgc.local", ...args],
      { stdio: "pipe" },
    )?.toString() ?? ""
  );
}

const authUrl = (token: string, org: string, repo: string) =>
  `https://x-access-token:${token}@github.com/${org}/${repo}.git`;

export interface SquashedUpdate {
  /** New squashed head per branch (the content students will receive). */
  heads: Record<string, string>;
  /** Source head per branch at the time of the update. */
  sourceHeads: Record<string, string>;
  /** Branches whose squashed content actually changed. */
  changed: string[];
}

/** GH-51 step 1: bring the squashed repo up to date with the source. */
export function updateSquashedRepo(opts: {
  token: string;
  org: string;
  sourceRepo: string;
  squashedRepo: string;
  strategy: "whole" | "squash";
  branches: string[];
}): SquashedUpdate {
  const { token, org, sourceRepo, squashedRepo, strategy, branches } = opts;
  const work = mkdtempSync(join(tmpdir(), "hgc-sync-"));
  try {
    const heads: Record<string, string> = {};
    const sourceHeads: Record<string, string> = {};
    const changed: string[] = [];

    if (strategy === "whole") {
      git(work, "clone", "--quiet", "--bare", authUrl(token, org, sourceRepo), "src.git");
      const src = join(work, "src.git");
      for (const b of branches) {
        sourceHeads[b] = gitBare(src, "rev-parse", `refs/heads/${b}`).trim();
      }
      // Fast-forward only: the squashed repo is never rewritten (GH-13).
      const refspecs = branches.map((b) => `refs/heads/${b}:refs/heads/${b}`);
      const before = squashedBranchHeads(token, org, squashedRepo, branches, work);
      gitBare(src, "push", "--quiet", authUrl(token, org, squashedRepo), ...refspecs);
      for (const b of branches) {
        heads[b] = sourceHeads[b]!;
        if (before[b] !== heads[b]) changed.push(b);
      }
      return { heads, sourceHeads, changed };
    }

    // `squash` strategy: one primary commit per branch replaying the source
    // tree on top of the squashed history (students merge a single commit).
    for (const branch of branches) {
      const safe = branch.replace(/[^a-zA-Z0-9]/g, "_");
      const sqDir = join(work, `sq-${safe}`);
      const srcDir = join(work, `src-${safe}`);
      git(work, "clone", "--quiet", "--branch", branch, authUrl(token, org, squashedRepo), sqDir);
      git(work, "clone", "--quiet", "--depth", "1", "--branch", branch, authUrl(token, org, sourceRepo), srcDir);
      sourceHeads[branch] = git(srcDir, "rev-parse", "HEAD").trim();

      // Replace the working tree with the source content, keep .git.
      for (const entry of readdirSync(sqDir)) {
        if (entry !== ".git") rmSync(join(sqDir, entry), { recursive: true, force: true });
      }
      for (const entry of readdirSync(srcDir)) {
        if (entry !== ".git") cpSync(join(srcDir, entry), join(sqDir, entry), { recursive: true });
      }
      git(sqDir, "add", "-A");
      if (git(sqDir, "status", "--porcelain").trim() === "") {
        heads[branch] = git(sqDir, "rev-parse", "HEAD").trim();
        continue; // already up to date
      }
      git(
        sqDir,
        "commit",
        "-q",
        "-m",
        `Assignment update (${sourceHeads[branch]!.slice(0, 7)})`,
      );
      git(sqDir, "push", "-q", authUrl(token, org, squashedRepo), `${branch}:${branch}`);
      heads[branch] = git(sqDir, "rev-parse", "HEAD").trim();
      changed.push(branch);
    }
    return { heads, sourceHeads, changed };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function squashedBranchHeads(
  token: string,
  org: string,
  squashedRepo: string,
  branches: string[],
  work: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of git(work, "ls-remote", authUrl(token, org, squashedRepo)).split("\n")) {
    const [sha, ref] = line.split("\t");
    const b = ref?.replace("refs/heads/", "");
    if (sha && b && branches.includes(b)) out[b] = sha;
  }
  return out;
}

/**
 * GH-51 step 2: a workspace holding one bare clone of the squashed repo,
 * reused to push `sync/<branch>` to every student repository (forced update
 * allowed on this bot-only ref).
 */
export interface SyncWorkspace {
  pushSyncRef: (studentRepo: string, branch: string) => string;
  dispose: () => void;
}

export function openSyncWorkspace(opts: {
  token: string;
  org: string;
  squashedRepo: string;
}): SyncWorkspace {
  const { token, org, squashedRepo } = opts;
  const work = mkdtempSync(join(tmpdir(), "hgc-syncpush-"));
  git(work, "clone", "--quiet", "--bare", authUrl(token, org, squashedRepo), "sq.git");
  const sq = join(work, "sq.git");
  return {
    pushSyncRef(studentRepo: string, branch: string): string {
      gitBare(
        sq,
        "push",
        "--quiet",
        "--force",
        authUrl(token, org, studentRepo),
        `refs/heads/${branch}:refs/heads/sync/${branch}`,
      );
      return gitBare(sq, "rev-parse", `refs/heads/${branch}`).trim();
    },
    dispose() {
      rmSync(work, { recursive: true, force: true });
    },
  };
}
