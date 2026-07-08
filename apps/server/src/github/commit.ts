/**
 * Bot-signed empty commit (GH-42, deadline commit strategy): same tree as
 * the head commit, pushed as a non-forced fast-forward; a race with a
 * student push fails cleanly and the job retries.
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
    // Branch absent from the student repository: nothing to mark.
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

/** ISO instant with Europe/Zurich offset (GH-42, C-02): `2026-07-03T23:59:00+02:00`. */
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
