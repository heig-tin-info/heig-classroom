import { describe, expect, it } from "vitest";

import { GITHUB_REPO_NAME_MAX, journalRepoName, repoName } from "./repoName.js";

describe("repoName", () => {
  it("returns the stem untouched when it fits", () => {
    expect(repoName("labo-01-group-1")).toBe("labo-01-group-1");
  });

  it("appends the disambiguator", () => {
    expect(repoName("labo-01-group-1", "a1b2c3d4")).toBe("labo-01-group-1-a1b2c3d4");
  });

  it("keeps the disambiguator whole and shortens the stem", () => {
    const name = repoName("x".repeat(200), "a1b2c3d4");
    expect(name).toHaveLength(GITHUB_REPO_NAME_MAX);
    expect(name.endsWith("-a1b2c3d4")).toBe(true);
  });

  it("never ends on the dash left by the cut", () => {
    // 92 characters then a dash: the cut lands exactly on it.
    const stem = `${"x".repeat(91)}-`;
    expect(repoName(stem, "a1b2c3d4")).toBe(`${"x".repeat(91)}-a1b2c3d4`);
  });
});

describe("journalRepoName", () => {
  it("is the classroom slug then the word journal", () => {
    expect(journalRepoName("prog-c-2026-2027")).toBe("prog-c-2026-2027-journal");
  });

  it("disambiguates with the suffix given", () => {
    expect(journalRepoName("prog-c", "0f1e2d3c")).toBe("prog-c-journal-0f1e2d3c");
  });

  it("stays inside GitHub's limit for a maximal classroom slug", () => {
    // `slugify` caps a classroom name at 60 characters.
    expect(journalRepoName("c".repeat(60), "0f1e2d3c").length).toBeLessThanOrEqual(
      GITHUB_REPO_NAME_MAX,
    );
  });
});
