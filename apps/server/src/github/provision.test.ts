import { describe, expect, it, vi } from "vitest";

import type { Octokit } from "octokit";

import { provisionStudentRepo } from "./provision.js";

/** Octokit's own shape for an HTTP failure: only `status` and `message` matter here. */
function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

/**
 * Replays the branch where the repository already exists with its default
 * branch pushed: every step is an API call, so no git command runs.
 */
function fakeOctokit(routes: Record<string, (opts: never) => unknown>) {
  const request = vi.fn(async (route: string, opts: never) => {
    const handler = routes[route];
    if (!handler) throw new Error(`unexpected route ${route}`);
    return handler(opts);
  });
  return { octokit: { request } as unknown as Octokit, request };
}

const REPO = { id: 42, full_name: "Prog-D-2026/labo-00-x", default_branch: "main" };

function baseRoutes() {
  return {
    "POST /orgs/{org}/repos": () => {
      throw httpError(422, "name already exists on this account");
    },
    "GET /repos/{owner}/{repo}": () => ({ data: REPO }),
    "GET /repos/{owner}/{repo}/git/matching-refs/{ref}": () => ({
      data: [{ ref: "refs/heads/main" }],
    }),
    "PUT /repos/{owner}/{repo}/collaborators/{username}": () => ({ status: 201 }),
  } as Record<string, (opts: never) => unknown>;
}

function provision(octokit: Octokit) {
  return provisionStudentRepo({
    octokit,
    token: "t",
    org: "Prog-D-2026",
    squashedRepo: "labo-00-squashed",
    targetRepo: "labo-00-x",
    branches: ["main"],
    defaultBranch: "main",
    studentLogin: "student",
  });
}

describe("provisionStudentRepo", () => {
  it("protects the repository when the plan serves rulesets", async () => {
    const { octokit, request } = fakeOctokit({
      ...baseRoutes(),
      "GET /repos/{owner}/{repo}/rulesets": () => ({ data: [] }),
      "POST /repos/{owner}/{repo}/rulesets": () => ({ data: { id: 7 } }),
    });

    const result = await provision(octokit);

    expect(result.rulesetId).toBe(7);
    expect(result.invitationStatus).toBe("pending");
    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/rulesets",
      expect.objectContaining({ name: "hgc-protect" }),
    );
  });

  it("still hands the repository over on a plan without rulesets", async () => {
    const { octokit, request } = fakeOctokit({
      ...baseRoutes(),
      "GET /repos/{owner}/{repo}/rulesets": () => {
        throw httpError(
          403,
          "Upgrade to GitHub Pro or make this repository public to enable this feature. - https://docs.github.com/rest/repos/rules#get-all-repository-rulesets",
        );
      },
    });

    const result = await provision(octokit);

    // Degraded mode: no protection, but the student gets their repository.
    expect(result.rulesetId).toBeNull();
    expect(result.fullName).toBe(REPO.full_name);
    expect(result.invitationStatus).toBe("pending");
    expect(request).toHaveBeenCalledWith(
      "PUT /repos/{owner}/{repo}/collaborators/{username}",
      expect.objectContaining({ username: "student", permission: "push" }),
    );
  });

  it("fails loudly on a 403 that is not a plan restriction", async () => {
    const { octokit, request } = fakeOctokit({
      ...baseRoutes(),
      "GET /repos/{owner}/{repo}/rulesets": () => {
        throw httpError(403, "Resource not accessible by integration");
      },
    });

    await expect(provision(octokit)).rejects.toThrow("Resource not accessible by integration");
    expect(request).not.toHaveBeenCalledWith(
      "PUT /repos/{owner}/{repo}/collaborators/{username}",
      expect.anything(),
    );
  });
});
