/**
 * Provisionnement du dépôt étudiant à l'acceptation (GH-20..25), porté du
 * spike S2. Chaque étape vérifie l'état avant d'agir : le rejeu complet est
 * sûr (reprise après échec partiel, NFR-09).
 *
 * Leçon du spike : ne JAMAIS lister les refs d'un dépôt fraîchement créé
 * (409 « Git Repository is empty » que le plugin retry d'Octokit étire en
 * ~40 s de backoff) — et `retries: 0` partout où un 4xx est porteur de sens.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Octokit } from "octokit";

const PROTECT_RULESET = "hgc-protect";

function git(cwd: string, ...args: string[]) {
  return (
    execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" })?.toString() ?? ""
  );
}

/** Dépôt bare : `--git-dir` explicite (compatible `safe.bareRepository=explicit`). */
function gitBare(gitDir: string, ...args: string[]) {
  return (
    execFileSync("git", ["--git-dir", gitDir, ...args], { stdio: "pipe" })?.toString() ?? ""
  );
}

export interface ProvisionResult {
  repoId: number;
  fullName: string;
  defaultBranch: string;
  rulesetId: number | null;
  /** `pending` si une invitation a été créée, `accepted` si déjà collaborateur. */
  invitationStatus: "pending" | "accepted";
}

export async function provisionStudentRepo(opts: {
  octokit: Octokit;
  token: string;
  org: string;
  squashedRepo: string;
  targetRepo: string;
  branches: string[];
  defaultBranch: string;
  studentLogin: string;
}): Promise<ProvisionResult> {
  const { octokit, token, org, squashedRepo, targetRepo, branches, studentLogin } = opts;
  const auth = (repo: string) =>
    `https://x-access-token:${token}@github.com/${org}/${repo}.git`;

  // 1. Création (idempotente : 422 name already exists = étape déjà faite).
  let created = true;
  let repoId: number;
  let fullName: string;
  try {
    const { data } = await octokit.request("POST /orgs/{org}/repos", {
      org,
      name: targetRepo,
      private: true,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false,
      request: { retries: 0 },
    });
    repoId = data.id;
    fullName = data.full_name;
  } catch (err) {
    if ((err as { status?: number }).status !== 422) throw err;
    created = false;
    const { data } = await octokit.request("GET /repos/{owner}/{repo}", {
      owner: org,
      repo: targetRepo,
    });
    repoId = data.id;
    fullName = data.full_name;
  }

  // 2. Push des refs du squashed (skippé si la branche par défaut existe déjà).
  let needPush = true;
  if (!created) {
    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/git/matching-refs/{ref}",
        { owner: org, repo: targetRepo, ref: `heads/${opts.defaultBranch}`, request: { retries: 0 } },
      );
      needPush = data.length === 0;
    } catch (err) {
      if ((err as { status?: number }).status !== 409) throw err; // vide → push
    }
  }
  if (needPush) {
    const work = mkdtempSync(join(tmpdir(), "hgc-prov-"));
    try {
      git(work, "clone", "--quiet", "--bare", auth(squashedRepo), "src.git");
      const refspecs = branches.map((b) => `refs/heads/${b}:refs/heads/${b}`);
      gitBare(join(work, "src.git"), "push", "--quiet", auth(targetRepo), ...refspecs);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  // 3. Ruleset anti force-push / anti suppression (GH-21..23).
  const { data: rulesets } = await octokit.request("GET /repos/{owner}/{repo}/rulesets", {
    owner: org,
    repo: targetRepo,
  });
  let rulesetId =
    rulesets.find((r: { name: string; id: number }) => r.name === PROTECT_RULESET)?.id ?? null;
  if (rulesetId === null) {
    const { data } = await octokit.request("POST /repos/{owner}/{repo}/rulesets", {
      owner: org,
      repo: targetRepo,
      name: PROTECT_RULESET,
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [{ type: "non_fast_forward" }, { type: "deletion" }],
    });
    rulesetId = data.id;
  }

  // 4. Invitation de l'étudiant en push (idempotent : 204 = déjà collaborateur).
  const invite = await octokit.request(
    "PUT /repos/{owner}/{repo}/collaborators/{username}",
    { owner: org, repo: targetRepo, username: studentLogin, permission: "push" },
  );

  return {
    repoId,
    fullName,
    defaultBranch: opts.defaultBranch,
    rulesetId,
    invitationStatus: invite.status === 201 ? "pending" : "accepted",
  };
}
