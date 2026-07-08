/**
 * Live state of a student repository (GR-15): head commit + check-runs.
 * Shared between the detail view (fetch on open) and the periodic
 * reconciliation (ADR-011: a single update code path, two triggers).
 */
import type { Octokit } from "octokit";

export interface RepoLiveState {
  lastCommitSha: string | null;
  lastCommitAt: string | null;
  commitCount: number;
  checksPassed: number | null;
  checksTotal: number | null;
  ciStatus: "none" | "pending" | "pass" | "fail";
  missing?: boolean;
}

export async function fetchRepoLiveState(
  octokit: Octokit,
  fullName: string,
): Promise<RepoLiveState | null> {
  const [owner, repo] = fullName.split("/") as [string, string];
  try {
    const commits = await octokit.request("GET /repos/{owner}/{repo}/commits", {
      owner,
      repo,
      per_page: 1,
      request: { retries: 0 },
    });
    const head = commits.data[0];
    if (!head) throw Object.assign(new Error("empty"), { status: 409 });
    const lastPage = /[?&]page=(\d+)>; rel="last"/.exec(commits.headers.link ?? "");
    const commitCount = lastPage ? Number(lastPage[1]) : commits.data.length;
    const checks = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
      owner,
      repo,
      ref: head.sha,
      request: { retries: 0 },
    });
    // skipped/neutral (e.g. anti-bot condition GH-44) is not a failure.
    const runs = checks.data.check_runs.filter(
      (c) => !["skipped", "neutral"].includes(c.conclusion ?? ""),
    );
    const passed = runs.filter((c) => c.conclusion === "success").length;
    const pending = runs.some((c) => c.status !== "completed");
    return {
      lastCommitSha: head.sha,
      lastCommitAt: head.commit.committer?.date ?? head.commit.author?.date ?? null,
      commitCount,
      checksPassed: runs.length ? passed : null,
      checksTotal: runs.length ? runs.length : null,
      ciStatus:
        runs.length === 0 ? "none" : pending ? "pending" : passed === runs.length ? "pass" : "fail",
    };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 409) {
      // Empty repository: provisioned but no readable commit.
      return {
        lastCommitSha: null,
        lastCommitAt: null,
        commitCount: 0,
        checksPassed: null,
        checksTotal: null,
        ciStatus: "none",
      };
    }
    if (status === 404) {
      return {
        lastCommitSha: null,
        lastCommitAt: null,
        commitCount: 0,
        checksPassed: null,
        checksTotal: null,
        ciStatus: "none",
        missing: true,
      };
    }
    throw err;
  }
}
