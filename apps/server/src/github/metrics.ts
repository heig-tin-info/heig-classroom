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
  opts: { noRateLimitWait?: boolean } = {},
): Promise<RepoLiveState | null> {
  const [owner, repo] = fullName.split("/") as [string, string];
  const request = { retries: 0, noRateLimitWait: opts.noRateLimitWait === true };
  try {
    const commits = await octokit.request("GET /repos/{owner}/{repo}/commits", {
      owner,
      repo,
      per_page: 1,
      request,
    });
    const head = commits.data[0];
    if (!head) throw Object.assign(new Error("empty"), { status: 409 });
    const lastPage = /[?&]page=(\d+)>; rel="last"/.exec(commits.headers.link ?? "");
    const commitCount = lastPage ? Number(lastPage[1]) : commits.data.length;
    const checks = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
      owner,
      repo,
      ref: head.sha,
      request,
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

/**
 * Live state for the views (teacher detail, student dashboard), which every
 * SSE hint refetches. On 2026-09-24 a lab of Prog-C (64 acceptances, 99
 * webhooks in 15 minutes) turned those refetches into ~5,000 GitHub calls
 * and exhausted the org's hourly quota. Hence:
 * - a per-repository cache, shared by concurrent requests; webhooks that
 *   change the state drop the entry (`forgetRepoLiveState`);
 * - stale-while-revalidate: past the TTL, the last known state is served at
 *   once and refreshed in the background (a cold 20-repository view costs
 *   ~2 s of GitHub calls); past MAX_STALE it is fetched again;
 * - no waiting on a rate limit: the installation is skipped until the reset
 *   and the caller falls back to the stored state (`null`).
 */
export const LIVE_STATE_TTL_MS = 60_000;
export const LIVE_STATE_MAX_STALE_MS = 15 * 60_000;

interface LiveEntry {
  /** Start of the fetch that fills (or filled) this entry. */
  at: number;
  state: Promise<RepoLiveState | null>;
  /** Set once `state` has resolved. */
  settled?: { value: RepoLiveState | null };
  /** Previous value, served while this entry's fetch is in flight. */
  previous?: { value: RepoLiveState | null };
}
const liveCache = new Map<string, LiveEntry>();
const rateLimitedUntil = new Map<number, number>();

export function forgetRepoLiveState(fullName: string | null | undefined): void {
  if (fullName) liveCache.delete(fullName.toLowerCase());
}

/** Test hook: start from an empty cache and no rate-limited installation. */
export function resetLiveStateCache(): void {
  liveCache.clear();
  rateLimitedUntil.clear();
}

/** Epoch ms when a rate-limited request may be retried, or null. */
function rateLimitReset(err: unknown, now: number): number | null {
  const e = err as { status?: number; response?: { headers?: Record<string, string> } };
  if (e.status !== 403 && e.status !== 429) return null;
  const headers = e.response?.headers ?? {};
  if (headers["x-ratelimit-remaining"] === "0" && headers["x-ratelimit-reset"]) {
    return Number(headers["x-ratelimit-reset"]) * 1000;
  }
  if (headers["retry-after"]) return now + Number(headers["retry-after"]) * 1000;
  return null;
}

export interface LiveRead {
  state: RepoLiveState | null;
  /** Older than the TTL: a background refresh is under way. */
  stale: boolean;
}

export async function readRepoLiveState(
  octokit: Octokit,
  installationId: number,
  fullName: string,
  now = Date.now(),
): Promise<LiveRead> {
  const key = fullName.toLowerCase();
  const hit = liveCache.get(key);
  const limited = (rateLimitedUntil.get(installationId) ?? 0) > now;

  if (hit) {
    const age = now - hit.at;
    if (hit.settled) {
      if (age < LIVE_STATE_TTL_MS) return { state: hit.settled.value, stale: false };
      if (age < LIVE_STATE_MAX_STALE_MS) {
        if (!limited) refresh(octokit, installationId, key, fullName, now, hit.settled);
        return { state: hit.settled.value, stale: true };
      }
    } else if (hit.previous) {
      return { state: hit.previous.value, stale: true };
    } else if (age < LIVE_STATE_TTL_MS) {
      return { state: await hit.state, stale: false };
    }
  }
  if (limited) return { state: null, stale: false };
  const entry = refresh(octokit, installationId, key, fullName, now);
  return { state: await entry.state, stale: false };
}

/** Starts a fetch into a new entry; `previous` is served until it settles. */
function refresh(
  octokit: Octokit,
  installationId: number,
  key: string,
  fullName: string,
  now: number,
  previous?: { value: RepoLiveState | null },
): LiveEntry {
  if (liveCache.size > 5000) {
    for (const [k, v] of liveCache) {
      if (now - v.at >= LIVE_STATE_MAX_STALE_MS) liveCache.delete(k);
    }
  }
  const entry: LiveEntry = { at: now, state: Promise.resolve(null) };
  if (previous) entry.previous = previous;
  // The promise settles the same way for every concurrent caller: a rate
  // limit resolves to null (fallback), other errors reject.
  entry.state = fetchRepoLiveState(octokit, fullName, { noRateLimitWait: true }).then(
    (value) => {
      entry.settled = { value };
      return value;
    },
    (err: unknown) => {
      const reset = rateLimitReset(err, Date.now());
      if (reset !== null) {
        rateLimitedUntil.set(installationId, reset);
        // Rate-limited background refresh: keep serving the last value.
        if (previous) {
          entry.settled = previous;
          return previous.value;
        }
      }
      if (liveCache.get(key) === entry) liveCache.delete(key);
      if (reset === null) throw err;
      return null;
    },
  );
  // A background refresh has no awaiting caller: never an unhandled rejection.
  if (previous) entry.state.catch(() => undefined);
  liveCache.set(key, entry);
  return entry;
}

/** The state alone, for callers that do not report staleness. */
export async function cachedRepoLiveState(
  octokit: Octokit,
  installationId: number,
  fullName: string,
  now = Date.now(),
): Promise<RepoLiveState | null> {
  return (await readRepoLiveState(octokit, installationId, fullName, now)).state;
}
