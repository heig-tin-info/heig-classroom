/**
 * Création du dépôt source squashed (GH-10..13) au moment de la création de
 * l'assignment. Deux stratégies :
 * - `whole`  : tout l'historique des branches retenues est repoussé tel quel ;
 * - `squash` : chaque branche retenue est réduite à un unique commit initial.
 * Les opérations git utilisent le token d'installation (GH-03).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Octokit } from "octokit";

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
  /** SHA de tête par branche du squashed (base des futurs primary_commits). */
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

  // Création du dépôt cible — refus si déjà pris (le nom dérive du slug,
  // unique par classroom ; une collision est une vraie erreur).
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
      git(src, "push", "--quiet", auth(targetRepo), ...refspecs);
      for (const b of branches) {
        heads[b] = git(src, "rev-parse", `refs/heads/${b}`).trim();
      }
    } else {
      for (const branch of branches) {
        const dir = join(work, `b-${branch.replace(/[^a-zA-Z0-9]/g, "_")}`);
        git(work, "clone", "--quiet", "--depth", "1", "--branch", branch, auth(sourceRepo), dir);
        // Un seul commit initial : on rejoue l'arbre de tête sans historique.
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
