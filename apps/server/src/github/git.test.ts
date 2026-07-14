import { describe, expect, it } from "vitest";

import { gitRunner, redactTokens } from "./git.js";

describe("redactTokens", () => {
  it("strips the installation token from an authUrl echoed by git", () => {
    // Same shape as a real failed-push message (provision error, 2026-07-14),
    // with a made-up token — a real one trips GitHub's push protection.
    const msg =
      "Error: Command failed: git --git-dir /tmp/x/src.git push --quiet " +
      "https://x-access-token:ghs_0000000000FAKEFAKEFAKE0000000000000000@github.com/org/repo.git " +
      "refs/heads/master:refs/heads/master\nerror: RPC failed; curl 55";
    const clean = redactTokens(msg);
    expect(clean).not.toContain("ghs_0000");
    expect(clean).toContain("x-access-token:***@github.com/org/repo.git");
    expect(clean).toContain("RPC failed"); // diagnostics survive
  });

  it("strips bare GitHub tokens outside a URL", () => {
    expect(redactTokens("token ghp_abc123 leaked")).toBe("token gh*_*** leaked");
  });
});

describe("gitRunner", () => {
  it("throws a redacted error on failure", () => {
    const { git } = gitRunner();
    let message = "";
    try {
      git("/tmp", "push", "https://x-access-token:ghs_secret123@github.com/none/none.git");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("ghs_secret123");
  });
});
