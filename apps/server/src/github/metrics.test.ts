import type { Octokit } from "octokit";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cachedRepoLiveState,
  forgetRepoLiveState,
  LIVE_STATE_MAX_STALE_MS,
  LIVE_STATE_TTL_MS,
  readRepoLiveState,
  resetLiveStateCache,
} from "./metrics.js";

/** An Octokit whose `request` answers the two live-state calls. */
function fakeOctokit(fail?: unknown, sha = "abc") {
  const request = vi.fn(async (route: string, params: { request?: unknown }) => {
    if (fail) throw fail;
    if (route.endsWith("/check-runs")) {
      return { data: { check_runs: [{ status: "completed", conclusion: "success" }] }, params };
    }
    return {
      data: [{ sha, commit: { committer: { date: "2026-09-24T12:00:00Z" } } }],
      headers: {},
    };
  });
  return { octokit: { request } as unknown as Octokit, request };
}

const quotaExhausted = Object.assign(new Error("API rate limit exceeded"), {
  status: 403,
  response: { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000" } },
});

describe("cachedRepoLiveState", () => {
  beforeEach(() => resetLiveStateCache());

  it("asks GitHub not to wait out a rate limit", async () => {
    const { octokit, request } = fakeOctokit();
    await cachedRepoLiveState(octokit, 1, "org/repo", 0);
    expect(request.mock.calls[0]![1]).toMatchObject({
      request: { retries: 0, noRateLimitWait: true },
    });
  });

  it("serves concurrent and repeated reads from one fetch within the TTL", async () => {
    const { octokit, request } = fakeOctokit();
    const [a, b] = await Promise.all([
      cachedRepoLiveState(octokit, 1, "org/repo", 0),
      cachedRepoLiveState(octokit, 1, "Org/Repo", 0),
    ]);
    await cachedRepoLiveState(octokit, 1, "org/repo", LIVE_STATE_TTL_MS - 1);
    expect(a).toEqual(b);
    expect(a?.ciStatus).toBe("pass");
    expect(request).toHaveBeenCalledTimes(2); // commits + check-runs, once
  });

  it("refetches after the TTL, or once a webhook forgets the repository", async () => {
    const { octokit, request } = fakeOctokit();
    await cachedRepoLiveState(octokit, 1, "org/repo", 0);
    await cachedRepoLiveState(octokit, 1, "org/repo", LIVE_STATE_TTL_MS);
    forgetRepoLiveState("ORG/repo");
    await cachedRepoLiveState(octokit, 1, "org/repo", LIVE_STATE_TTL_MS);
    expect(request).toHaveBeenCalledTimes(6);
  });

  it("falls back on a rate limit and skips the installation until the reset", async () => {
    const limited = fakeOctokit(quotaExhausted);
    expect(await cachedRepoLiveState(limited.octokit, 1, "org/a", 0)).toBeNull();
    expect(await cachedRepoLiveState(limited.octokit, 1, "org/b", 1_999_999)).toBeNull();
    expect(limited.request).toHaveBeenCalledTimes(1);

    // Another installation keeps its own quota.
    const other = fakeOctokit();
    expect(await cachedRepoLiveState(other.octokit, 2, "other/a", 1_999_999)).not.toBeNull();

    // After the reset, the installation is queried again.
    const healed = fakeOctokit();
    expect(await cachedRepoLiveState(healed.octokit, 1, "org/a", 2_000_000)).not.toBeNull();
  });

  it("rethrows other errors and does not cache them", async () => {
    const broken = fakeOctokit(Object.assign(new Error("boom"), { status: 500 }));
    await expect(cachedRepoLiveState(broken.octokit, 1, "org/repo", 0)).rejects.toThrow("boom");
    const { octokit, request } = fakeOctokit();
    await cachedRepoLiveState(octokit, 1, "org/repo", 0);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("serves the last state at once past the TTL and refreshes it in the background", async () => {
    const first = fakeOctokit(undefined, "old");
    await readRepoLiveState(first.octokit, 1, "org/repo", 0);

    const next = fakeOctokit(undefined, "new");
    const read = await readRepoLiveState(next.octokit, 1, "org/repo", LIVE_STATE_TTL_MS);
    expect(read).toMatchObject({ stale: true, state: { lastCommitSha: "old" } });
    // While the refresh is in flight, other readers get the old value too.
    const during = await readRepoLiveState(next.octokit, 1, "org/repo", LIVE_STATE_TTL_MS + 1);
    expect(during.stale).toBe(true);

    await vi.waitFor(() => expect(next.request).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    const after = await readRepoLiveState(next.octokit, 1, "org/repo", LIVE_STATE_TTL_MS + 2);
    expect(after).toMatchObject({ stale: false, state: { lastCommitSha: "new" } });
    expect(next.request).toHaveBeenCalledTimes(2); // one refresh, not one per reader
  });

  it("waits for GitHub again once the state is older than MAX_STALE", async () => {
    await readRepoLiveState(fakeOctokit(undefined, "old").octokit, 1, "org/repo", 0);
    const next = fakeOctokit(undefined, "new");
    const read = await readRepoLiveState(next.octokit, 1, "org/repo", LIVE_STATE_MAX_STALE_MS);
    expect(read).toMatchObject({ stale: false, state: { lastCommitSha: "new" } });
  });

  it("keeps the last state when the background refresh hits the rate limit", async () => {
    await readRepoLiveState(fakeOctokit(undefined, "old").octokit, 1, "org/repo", 0);
    const limited = fakeOctokit(quotaExhausted);
    await readRepoLiveState(limited.octokit, 1, "org/repo", LIVE_STATE_TTL_MS);
    await new Promise((r) => setTimeout(r, 0));
    const read = await readRepoLiveState(limited.octokit, 1, "org/repo", LIVE_STATE_TTL_MS + 1);
    expect(read.state?.lastCommitSha).toBe("old");
    expect(limited.request).toHaveBeenCalledTimes(1);
  });
});
