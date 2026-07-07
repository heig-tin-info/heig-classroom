/**
 * Verrouillage/déverrouillage d'un dépôt étudiant par ruleset (GH-41),
 * mécanique validée par le spike S2 : pendant le lock tout push est refusé
 * (bypass App et org admin), le retrait rouvre le dépôt. Utilisé par le
 * bouton manuel du teacher (US-22 : « un push de plus ») et, en M4, par le
 * job de deadline.
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
  if (!existing) return; // déjà déverrouillé — idempotent
  await octokit.request("DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
    owner: org,
    repo,
    ruleset_id: existing.id,
  });
}
