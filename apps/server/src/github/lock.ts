/**
 * Locking/unlocking of a student repository via ruleset (GH-41), a
 * mechanism validated by spike S2: while locked, every push is refused
 * (App and org admin bypass), removal reopens the repository. Used by the
 * teacher's manual button (US-22: "one more push") and, in M4, by the
 * deadline job.
 */
import type { Octokit } from "octokit";

const LOCK_RULESET = "hgc-deadline-lock";

export async function lockStudentRepo(
  octokit: Octokit,
  org: string,
  repo: string,
): Promise<number> {
  const { data: rulesets } = await octokit.request("GET /repos/{owner}/{repo}/rulesets", {
    owner: org,
    repo,
  });
  const existing = rulesets.find((r: { name: string; id: number }) => r.name === LOCK_RULESET);
  if (existing) return existing.id;
  const { data } = await octokit.request("POST /repos/{owner}/{repo}/rulesets", {
    owner: org,
    repo,
    name: LOCK_RULESET,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
    rules: [{ type: "update" }, { type: "creation" }, { type: "deletion" }],
  });
  return data.id;
}

export async function unlockStudentRepo(
  octokit: Octokit,
  org: string,
  repo: string,
): Promise<void> {
  const { data: rulesets } = await octokit.request("GET /repos/{owner}/{repo}/rulesets", {
    owner: org,
    repo,
  });
  const existing = rulesets.find((r: { name: string; id: number }) => r.name === LOCK_RULESET);
  if (!existing) return; // already unlocked, idempotent
  await octokit.request("DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
    owner: org,
    repo,
    ruleset_id: existing.id,
  });
}
