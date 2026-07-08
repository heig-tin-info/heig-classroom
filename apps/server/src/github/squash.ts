/**
 * Creation of the squashed source repository (GH-10..13) when the
 * assignment is created. Two strategies:
 * - `whole`  : the full history of the selected branches is pushed as is;
 * - `squash` : each selected branch is reduced to a single initial commit.
 * Git operations use the installation token (GH-03).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Octokit } from "octokit";

/** Bare repository: explicit `--git-dir` (compatible with `safe.bareRepository=explicit`). */
function gitBare(gitDir: string, ...args: string[]) {
  return (
    execFileSync("git", ["--git-dir", gitDir, "-c", "user.name=hgc", "-c", "user.email=bot@hgc.local", ...args], {
      stdio: "pipe",
    })?.toString() ?? ""
  );
}

function git(cwd: string, ...args: string[]) {
  return (
    execFileSync("git", ["-C", cwd, "-c", "user.name=hgc", "-c", "user.email=bot@hgc.local", ...args], {
      stdio: "pipe",
    })?.toString() ?? ""
  );
}

export interface SquashedResult {
  repoId: number;
  fullName: string;
  /** Head SHA per branch of the squashed repo (base of future primary_commits). */
  heads: Record<string, string>;
}

export async function createSquashedRepo(opts: {
  octokit: Octokit;
  token: string;
  org: string;
  sourceRepo: string;
  targetRepo: string;
  strategy: "whole" | "squash";
  branches: string[];
}): Promise<SquashedResult> {
  const { octokit, token, org, sourceRepo, targetRepo, strategy, branches } = opts;
  const auth = (repo: string) =>
    `https://x-access-token:${token}@github.com/${org}/${repo}.git`;

  // Creation of the target repository; refused if already taken (the name
  // derives from the slug, unique per classroom; a collision is a real error).
  const { data: created } = await octokit.request("POST /orgs/{org}/repos", {
    org,
    name: targetRepo,
    private: true,
    has_issues: false,
    has_wiki: false,
    has_projects: false,
    auto_init: false,
  });

  const work = mkdtempSync(join(tmpdir(), "hgc-squash-"));
  try {
    const heads: Record<string, string> = {};
    if (strategy === "whole") {
      git(work, "clone", "--quiet", "--bare", auth(sourceRepo), "src.git");
      const src = join(work, "src.git");
      const refspecs = branches.map((b) => `refs/heads/${b}:refs/heads/${b}`);
      gitBare(src, "push", "--quiet", auth(targetRepo), ...refspecs);
      for (const b of branches) {
        heads[b] = gitBare(src, "rev-parse", `refs/heads/${b}`).trim();
      }
    } else {
      for (const branch of branches) {
        const dir = join(work, `b-${branch.replace(/[^a-zA-Z0-9]/g, "_")}`);
        git(work, "clone", "--quiet", "--depth", "1", "--branch", branch, auth(sourceRepo), dir);
        // A single initial commit: replay the head tree without history.
        rmSync(join(dir, ".git"), { recursive: true, force: true });
        git(dir, "init", "-q", "-b", branch);
        git(dir, "add", "-A");
        git(dir, "commit", "-q", "-m", "Initial assignment commit");
        git(dir, "push", "-q", auth(targetRepo), `${branch}:${branch}`);
        heads[branch] = git(dir, "rev-parse", "HEAD").trim();
      }
    }
    return { repoId: created.id, fullName: created.full_name, heads };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
