import { describe, expect, it } from "vitest";

import type { Commit } from "@hgc/contracts";

import { buildGraph, laneColor, LANE_COLORS } from "./graph";

const commit = (sha: string, parents: string[]): Commit => ({
  sha,
  message: sha,
  author: "t",
  date: null,
  parents,
});

describe("buildGraph", () => {
  it("lays a linear history on a single lane", () => {
    const commits = [commit("c3", ["c2"]), commit("c2", ["c1"]), commit("c1", [])];
    const { laneOf, edges, laneCount } = buildGraph(commits);
    expect(laneCount).toBe(1);
    expect([...laneOf.values()]).toEqual([0, 0, 0]);
    expect(edges).toEqual([
      { r1: 0, l1: 0, r2: 1, l2: 0 },
      { r1: 1, l1: 0, r2: 2, l2: 0 },
    ]);
  });

  it("opens a second lane for a merge and converges it on the fork point", () => {
    // M merges A (first parent) and B; both fork from C.
    const commits = [
      commit("M", ["A", "B"]),
      commit("A", ["C"]),
      commit("B", ["C"]),
      commit("C", []),
    ];
    const { laneOf, edges, laneCount } = buildGraph(commits);
    expect(laneCount).toBe(2);
    expect(laneOf.get("M")).toBe(0);
    expect(laneOf.get("A")).toBe(0); // first-parent line stays on lane 0
    expect(laneOf.get("B")).toBe(1); // the branch gets its own lane
    expect(laneOf.get("C")).toBe(0); // convergence closes the extra lane
    expect(edges).toContainEqual({ r1: 0, l1: 0, r2: 2, l2: 1 }); // M -> B crosses lanes
    expect(edges).toContainEqual({ r1: 2, l1: 1, r2: 3, l2: 0 }); // B -> C converges
  });

  it("skips edges to parents beyond the fetched window", () => {
    const commits = [commit("c2", ["c1"]), commit("c1", ["c0"])]; // c0 not fetched
    const { edges } = buildGraph(commits);
    expect(edges).toEqual([{ r1: 0, l1: 0, r2: 1, l2: 0 }]);
  });
});

describe("laneColor", () => {
  it("cycles through the validated palette", () => {
    expect(laneColor(0)).toBe(LANE_COLORS[0]);
    expect(laneColor(LANE_COLORS.length)).toBe(LANE_COLORS[0]);
    expect(laneColor(LANE_COLORS.length + 2)).toBe(LANE_COLORS[2]);
  });
});
