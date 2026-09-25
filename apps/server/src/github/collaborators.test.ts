import { describe, expect, it, vi } from "vitest";

import type { Octokit } from "octokit";

import { currentLogin, isInvitationRefused } from "./collaborators.js";

/** Octokit's own shape for an HTTP failure: `status`, and the request's URL. */
function httpError(status: number, url = "https://api.github.com/user/1") {
  return Object.assign(new Error(`HTTP ${status}`), { status, request: { url } });
}

function octokitAnswering(answer: () => unknown) {
  return { request: vi.fn(async () => answer()) } as unknown as Octokit;
}

describe("currentLogin", () => {
  it("returns today's login of a renamed account", async () => {
    const octokit = octokitAnswering(() => ({ data: { id: 110348109, login: "remi-clerc" } }));
    expect(await currentLogin(octokit, 110348109)).toBe("remi-clerc");
  });

  it("returns null when the account no longer exists", async () => {
    const octokit = octokitAnswering(() => {
      throw httpError(404);
    });
    expect(await currentLogin(octokit, 1)).toBeNull();
  });

  it("rethrows any other failure", async () => {
    const octokit = octokitAnswering(() => {
      throw httpError(502);
    });
    await expect(currentLogin(octokit, 1)).rejects.toThrow("HTTP 502");
  });
});

describe("isInvitationRefused", () => {
  const invite = "https://api.github.com/repos/org/labo-01-Remcouz/collaborators/Remcouz";

  it("recognises a 403 or 404 on the collaborators endpoint", () => {
    expect(isInvitationRefused(httpError(403, invite))).toBe(true);
    expect(isInvitationRefused(httpError(404, invite))).toBe(true);
  });

  it("leaves other failures to the teacher", () => {
    expect(isInvitationRefused(httpError(403, "https://api.github.com/orgs/org/repos"))).toBe(false);
    expect(isInvitationRefused(httpError(422, invite))).toBe(false);
    expect(isInvitationRefused(new Error("git push failed"))).toBe(false);
  });
});
