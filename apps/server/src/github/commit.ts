/**
 * Commit vide signé bot (GH-42, stratégie deadline commit) : même arbre que
 * le commit de tête, poussé en fast-forward non forcé — une course avec un
 * push étudiant échoue proprement et le job réessaie.
 */
import type { Octokit } from "octokit";

export async function pushEmptyCommit(opts: {
  octokit: Octokit;
  org: string;
  repo: string;
  branch: string;
  message: string;
}): Promise<string | null> {
  const { octokit, org, repo, branch, message } = opts;
  let headSha: string;
  try {
    const { data: ref } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner: org,
      repo,
      ref: `heads/${branch}`,
      request: { retries: 0 },
    });
    headSha = ref.object.sha;
  } catch (err) {
    // Branche absente du dépôt étudiant : rien à marquer.
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
  const { data: headCommit } = await octokit.request(
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
    { owner: org, repo, commit_sha: headSha },
  );
  const { data: commit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
    owner: org,
    repo,
    message,
    tree: headCommit.tree.sha,
    parents: [headSha],
  });
  await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
    owner: org,
    repo,
    ref: `heads/${branch}`,
    sha: commit.sha,
    force: false,
  });
  return commit.sha;
}

/** Instant ISO avec offset Europe/Zurich (GH-42, C-02) : `2026-07-03T23:59:00+02:00`. */
export function zurichIso(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const rawOffset = get("timeZoneName"); // "GMT+02:00"
  const offset = rawOffset === "GMT" ? "+00:00" : rawOffset.replace("GMT", "");
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}${offset}`;
}
