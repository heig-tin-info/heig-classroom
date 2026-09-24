import { describe, expect, it } from "vitest";

import { GITHUB_REPO_NAME_MAX, groupRepoName, pickStudentRepo } from "./groupRepo.js";

describe("groupRepoName", () => {
  it("joins the assignment slug and the group slug", () => {
    expect(groupRepoName("labo-1", "group-2")).toBe("labo-1-group-2");
  });

  it("appends the disambiguator", () => {
    expect(groupRepoName("labo-1", "group-2", "3f2a9c1e")).toBe("labo-1-group-2-3f2a9c1e");
  });

  it("stays within GitHub's limit and keeps the disambiguator whole", () => {
    const long = "a".repeat(60);
    expect(groupRepoName(long, long)).toHaveLength(GITHUB_REPO_NAME_MAX);
    const named = groupRepoName(long, long, "3f2a9c1e");
    expect(named.length).toBeLessThanOrEqual(GITHUB_REPO_NAME_MAX);
    expect(named.endsWith("-3f2a9c1e")).toBe(true);
  });

  it("never leaves a dash where the cap cut", () => {
    const name = groupRepoName(`${"a".repeat(59)}-`, "b".repeat(60));
    expect(name.endsWith("-")).toBe(false);
  });
});

describe("pickStudentRepo", () => {
  const own = { id: "own", deletedAt: null };
  const group = { id: "group", deletedAt: null };
  const gone = { id: "gone", deletedAt: "2026-09-20T10:00:00Z" };

  it("reads the group repository when the student has no individual one", () => {
    expect(pickStudentRepo(undefined, group)).toBe(group);
  });

  it("keeps a live individual repository (lot-1 leftover) over the group one", () => {
    expect(pickStudentRepo(own, group)).toBe(own);
  });

  it("falls back to the group repository once the individual one is deleted", () => {
    expect(pickStudentRepo(gone, group)).toBe(group);
  });

  it("still shows a deleted individual repository when there is nothing else", () => {
    expect(pickStudentRepo(gone, undefined)).toBe(gone);
    expect(pickStudentRepo(undefined, undefined)).toBeUndefined();
  });
});
