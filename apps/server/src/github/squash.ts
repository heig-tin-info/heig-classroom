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

/** Push errors worth retrying: GitHub's git backend provisions the fresh
 *  repository asynchronously and an immediate push can hit a transient 500
 *  ("the remote end hung up unexpectedly"). */
const TRANSIENT_PUSH =
  /error:? (500|502|503)|hung up unexpectedly|early EOF|RPC failed|Internal Server Error/i;

async function pushWithRetry(fn: () => void): Promise<void> {
  const delays = [1000, 2000, 4000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      fn();
      return;
    } catch (err) {
      const detail =
        String((err as { stderr?: Buffer | string }).stderr ?? "") + String(err);
      if (attempt >= delays.length || !TRANSIENT_PUSH.test(detail)) throw err;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
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

  // Creation of the target repository. A name collision (422) is tolerated
  // when the existing repository is EMPTY: it is the leftover of a previous
  // failed attempt, and reusing it makes "try again" actually work.
  let created: { id: number; full_name: string };
  try {
    const res = await octokit.request("POST /orgs/{org}/repos", {
      org,
      name: targetRepo,
      private: true,
      has_issues: false,
      has_wiki: false,
      has_projects: false,
      auto_init: false,
    });
    created = res.data;
  } catch (err) {
    if ((err as { status?: number }).status !== 422) throw err;
    const { data: existing } = await octokit.request("GET /repos/{owner}/{repo}", {
      owner: org,
      repo: targetRepo,
    });
    let empty = false;
    try {
      await octokit.request("GET /repos/{owner}/{repo}/commits", {
        owner: org,
        repo: targetRepo,
        per_page: 1,
        request: { retries: 0 },
      });
    } catch (probe) {
      empty = (probe as { status?: number }).status === 409; // 409 = empty git repository
    }
    if (!empty) throw err; // a real collision with content: surface the 422
    created = existing;
  }

  const work = mkdtempSync(join(tmpdir(), "hgc-squash-"));
  try {
    const heads: Record<string, string> = {};
    if (strategy === "whole") {
      git(work, "clone", "--quiet", "--bare", auth(sourceRepo), "src.git");
      const src = join(work, "src.git");
      const refspecs = branches.map((b) => `refs/heads/${b}:refs/heads/${b}`);
      await pushWithRetry(() => gitBare(src, "push", "--quiet", auth(targetRepo), ...refspecs));
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
        await pushWithRetry(() => git(dir, "push", "-q", auth(targetRepo), `${branch}:${branch}`));
        heads[branch] = git(dir, "rev-parse", "HEAD").trim();
      }
    }
    return { repoId: created.id, fullName: created.full_name, heads };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
