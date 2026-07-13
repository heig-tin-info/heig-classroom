import type { Commit } from "@hgc/contracts";

/**
 * Git-graph lane layout (newest first). Each lane holds the sha it expects
 * next; a commit lands on the first lane waiting for it (extra waiting lanes
 * close — they converge here), or opens a lane. Extra parents of a merge get
 * their own expectation so the branch is visible until its tip.
 * Lane palette validated (dataviz six checks, light+dark; the commit list is
 * the table view covering the dark-contrast warning).
 */
export const LANE_COLORS = ["#b41f24", "#1d4ed8", "#0d9488", "#b45309", "#7e22ce"];
export const laneColor = (l: number) => LANE_COLORS[l % LANE_COLORS.length]!;

export function buildGraph(commits: Commit[]) {
  const rowOf = new Map(commits.map((c, i) => [c.sha, i]));
  const laneOf = new Map<string, number>();
  const lanes: (string | null)[] = [];
  for (const c of commits) {
    const waiting = lanes.flatMap((s, i) => (s === c.sha ? [i] : []));
    let lane: number;
    if (waiting.length > 0) {
      lane = waiting[0]!;
      for (const l of waiting.slice(1)) lanes[l] = null;
    } else {
      const free = lanes.indexOf(null);
      lane = free >= 0 ? free : lanes.length;
      if (free < 0) lanes.push(null);
    }
    laneOf.set(c.sha, lane);
    const [first, ...rest] = c.parents;
    lanes[lane] = first && !laneOf.has(first) ? first : null;
    for (const p of rest) {
      if (laneOf.has(p) || lanes.includes(p)) continue;
      const free = lanes.indexOf(null);
      if (free >= 0) lanes[free] = p;
      else lanes.push(p);
    }
  }
  const edges: { r1: number; l1: number; r2: number; l2: number }[] = [];
  for (const c of commits) {
    for (const p of c.parents) {
      const r2 = rowOf.get(p);
      if (r2 === undefined) continue; // parent beyond the fetched window
      edges.push({ r1: rowOf.get(c.sha)!, l1: laneOf.get(c.sha)!, r2, l2: laneOf.get(p)! });
    }
  }
  return { laneOf, edges, laneCount: lanes.length };
}
