import { describe, expect, it, vi } from "vitest";

import { ThrottledOctokit } from "./app.js";

/** A fetch that answers "quota exhausted, resets in an hour", then 200. */
function quotaFetch() {
  let calls = 0;
  const fetch = vi.fn(async () => {
    calls += 1;
    if (calls > 1) return new Response("[]", { status: 200 });
    return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      },
    });
  });
  return fetch;
}

describe("ThrottledOctokit", () => {
  const log = { debug() {}, info() {}, warn() {}, error() {} };

  it("fails at once on an exhausted quota when the request opts out of waiting", async () => {
    const fetch = quotaFetch();
    const octokit = new ThrottledOctokit({ request: { fetch }, log });
    const started = Date.now();
    await expect(
      octokit.request("GET /repos/{owner}/{repo}/commits", {
        owner: "o",
        repo: "r",
        request: { retries: 0, noRateLimitWait: true },
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("still waits out the limit for other requests (background jobs)", async () => {
    const fetch = quotaFetch();
    const octokit = new ThrottledOctokit({ request: { fetch }, log });
    const warn = vi.spyOn(octokit.log, "warn");
    const pending = octokit
      .request("GET /repos/{owner}/{repo}/commits", { owner: "o", repo: "r" })
      .catch(() => undefined);
    // The retry is scheduled an hour out: the request is still pending.
    const raced = await Promise.race([
      pending.then(() => "settled"),
      new Promise((r) => setTimeout(() => r("waiting"), 300)),
    ]);
    expect(raced).toBe("waiting");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Request quota exhausted"));
  });
});
