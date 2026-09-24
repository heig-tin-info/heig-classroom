import { describe, expect, it } from "vitest";

import {
  GITHUB_REPO_NAME_MAX,
  groupRepoName,
  isLiveIndividualRepo,
  pickStudentRepo,
  type RepoLifeLike,
} from "./groupRepo.js";

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

const row = (o: Partial<RepoLifeLike> & { id: string }) => ({
  groupId: null,
  provisionStatus: "ok",
  fullName: `org/${o.id}`,
  deletedAt: null,
  ...o,
});

describe("isLiveIndividualRepo", () => {
  it("is a provisioned, named, undeleted repository of no group", () => {
    expect(isLiveIndividualRepo(row({ id: "a" }))).toBe(true);
  });

  it("is not a failed, pending, unnamed, deleted or group repository", () => {
    expect(isLiveIndividualRepo(row({ id: "a", provisionStatus: "error" }))).toBe(false);
    expect(isLiveIndividualRepo(row({ id: "a", provisionStatus: "pending" }))).toBe(false);
    expect(isLiveIndividualRepo(row({ id: "a", fullName: null }))).toBe(false);
    expect(isLiveIndividualRepo(row({ id: "a", deletedAt: "2026-09-20T10:00:00Z" }))).toBe(false);
    expect(isLiveIndividualRepo(row({ id: "a", groupId: "g" }))).toBe(false);
  });
});

describe("pickStudentRepo", () => {
  const own = row({ id: "own" });
  const group = row({ id: "group", groupId: "g" });
  const gone = row({ id: "gone", deletedAt: "2026-09-20T10:00:00Z" });
  const failed = row({ id: "failed", provisionStatus: "error", fullName: null });

  it("lets the group repository win over a failed lot-1 row", () => {
    expect(pickStudentRepo(failed, group)).toBe(group);
    expect(pickStudentRepo(failed, undefined)).toBe(failed);
  });

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
