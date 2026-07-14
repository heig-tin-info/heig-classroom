/**
 * Student repository provisioning on acceptance (GH-20..25), ported from
 * spike S2. Each step checks the state before acting: a full replay is
 * safe (recovery after partial failure, NFR-09).
 *
 * Lesson from the spike: NEVER list the refs of a freshly created repository
 * (409 "Git Repository is empty" that Octokit's retry plugin stretches into
 * ~40 s of backoff), and `retries: 0` everywhere a 4xx carries meaning.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Octokit } from "octokit";

import { authUrl, gitRunner } from "./git.js";
import { pushWithRetry } from "./retry.js";

const PROTECT_RULESET = "hgc-protect";

// Provisioning only clones and pushes existing refs: no bot identity needed.
const { git, gitBare } = gitRunner();

export interface ProvisionResult {
  repoId: number;
  fullName: string;
  defaultBranch: string;
  rulesetId: number | null;
  /** `pending` if an invitation was created, `accepted` if already a collaborator. */
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
  const auth = (repo: string) => authUrl(token, org, repo);

  // 1. Creation (idempotent: 422 name already exists = step already done).
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

  // 2. Push of the squashed repo's refs (skipped if the default branch already exists).
  let needPush = true;
  if (!created) {
    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/git/matching-refs/{ref}",
        { owner: org, repo: targetRepo, ref: `heads/${opts.defaultBranch}`, request: { retries: 0 } },
      );
      needPush = data.length === 0;
    } catch (err) {
      if ((err as { status?: number }).status !== 409) throw err; // empty, so push
    }
  }
  if (needPush) {
    const work = mkdtempSync(join(tmpdir(), "hgc-prov-"));
    try {
      git(work, "clone", "--quiet", "--bare", auth(squashedRepo), "src.git");
      const refspecs = branches.map((b) => `refs/heads/${b}:refs/heads/${b}`);
      // The freshly created repository may still be provisioning on GitHub's
      // side: retry the push on transient failures instead of surfacing
      // "provisioning failed" to the student.
      await pushWithRetry(() =>
        gitBare(join(work, "src.git"), "push", "--quiet", auth(targetRepo), ...refspecs),
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  // 2b. Align the default branch with the assignment's first selected
  // branch. GitHub keeps the account-level default (`main`) on an empty
  // repo even when only `master` gets pushed; review commits then target a
  // branch that does not exist and fall to the backup branch (seen live
  // 2026-07-14: GRADING parked on `grading` for a main/master mismatch).
  try {
    const { data: meta } = await octokit.request("GET /repos/{owner}/{repo}", {
      owner: org,
      repo: targetRepo,
    });
    if (meta.default_branch !== opts.defaultBranch) {
      await octokit.request("PATCH /repos/{owner}/{repo}", {
        owner: org,
        repo: targetRepo,
        default_branch: opts.defaultBranch,
      });
    }
  } catch {
    // Best effort: a failed alignment must not fail the provisioning.
  }

  // 3. Ruleset against force-push / deletion (GH-21..23).
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

  // 4. Invite the student with push permission (idempotent: 204 = already a collaborator).
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
