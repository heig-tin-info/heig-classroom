import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COALESCE_MS, createRefreshScheduler, GITHUB_BACKED_MIN_INTERVAL_MS } from "./live";

/** Keys invalidated so far, one entry per invalidateQueries call. */
function recorder() {
  const qc = new QueryClient();
  qc.setQueryData(["assignment-detail", "a1"], {});
  qc.setQueryData(["student-classrooms"], {});
  qc.setQueryData(["classroom", "c1"], {});
  const calls: string[][] = [];
  vi.spyOn(qc, "invalidateQueries").mockImplementation(async (filters) => {
    const keys = qc
      .getQueryCache()
      .findAll(filters)
      .map((q) => q.queryKey[0] as string);
    calls.push(keys);
  });
  return { qc, calls };
}

describe("createRefreshScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("merges a burst of hints into one refetch of the cheap queries", () => {
    const { qc, calls } = recorder();
    const s = createRefreshScheduler(qc);
    for (let i = 0; i < 20; i++) s.hint();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(calls).toEqual([["classroom"], ["assignment-detail", "student-classrooms"]]);
  });

  it("refetches GitHub-backed queries at most once per interval, with a trailing refetch", () => {
    const { qc, calls } = recorder();
    const s = createRefreshScheduler(qc);
    const github = () => calls.filter((c) => c.includes("assignment-detail")).length;

    s.hint();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(github()).toBe(1);

    // A hint every 2 s for a whole minute: 99 webhooks during a lab.
    for (let t = 0; t < 60_000; t += 2_000) {
      s.hint();
      vi.advanceTimersByTime(2_000);
    }
    expect(github()).toBeLessThanOrEqual(1 + 60_000 / GITHUB_BACKED_MIN_INTERVAL_MS);
    expect(calls.filter((c) => c.includes("classroom")).length).toBeGreaterThan(20);

    // A hint right after a refetch is deferred, not dropped.
    const before = github();
    s.hint();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(github()).toBe(before);
    vi.advanceTimersByTime(GITHUB_BACKED_MIN_INTERVAL_MS);
    expect(github()).toBe(before + 1);
  });

  it("stops its timers on dispose", () => {
    const { qc, calls } = recorder();
    const s = createRefreshScheduler(qc);
    s.hint();
    s.dispose();
    vi.advanceTimersByTime(GITHUB_BACKED_MIN_INTERVAL_MS);
    expect(calls).toEqual([]);
  });
});
