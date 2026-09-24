import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import type { NoticeKind } from "@hgc/contracts";

import { useNotify } from "./notify";

/**
 * Queries whose endpoint reads live repository states from GitHub: every
 * refetch costs up to two GitHub calls per repository, against the org's
 * hourly quota. On 2026-09-24 a Prog-C lab (99 webhooks in 15 minutes)
 * refetched them on every hint and exhausted that quota.
 */
export const GITHUB_BACKED_QUERIES = new Set(["assignment-detail", "student-classrooms"]);
/** Hints arriving within this window are merged into one refetch. */
export const COALESCE_MS = 1_000;
/** GitHub-backed queries refetch at most once per this interval. */
export const GITHUB_BACKED_MIN_INTERVAL_MS = 30_000;

const githubBacked = (queryKey: readonly unknown[]) =>
  GITHUB_BACKED_QUERIES.has(queryKey[0] as string);

/**
 * Turns a stream of refresh hints into invalidations: cheap queries refetch
 * once per burst, GitHub-backed ones at most once per interval, with a
 * trailing refetch so the last hint of a burst is never lost.
 */
export function createRefreshScheduler(qc: QueryClient) {
  let cheapTimer: ReturnType<typeof setTimeout> | null = null;
  let githubTimer: ReturnType<typeof setTimeout> | null = null;
  let githubLast = -Infinity;

  const refreshGithub = () => {
    githubTimer = null;
    githubLast = Date.now();
    void qc.invalidateQueries({ predicate: (q) => githubBacked(q.queryKey) });
  };

  return {
    hint() {
      cheapTimer ??= setTimeout(() => {
        cheapTimer = null;
        void qc.invalidateQueries({ predicate: (q) => !githubBacked(q.queryKey) });
      }, COALESCE_MS);
      if (githubTimer) return;
      const wait = Math.max(COALESCE_MS, githubLast + GITHUB_BACKED_MIN_INTERVAL_MS - Date.now());
      githubTimer = setTimeout(refreshGithub, wait);
    },
    dispose() {
      if (cheapTimer) clearTimeout(cheapTimer);
      if (githubTimer) clearTimeout(githubTimer);
    },
  };
}

/**
 * Live updates over SSE (no WebSocket — ADR-005). Events are refresh hints,
 * never data: they invalidate the active queries (through the scheduler
 * above) and TanStack Query refetches through the authorized endpoints.
 * Reconnection (native to EventSource) also triggers a refetch — no replay
 * needed.
 *
 * Events may carry a typed notice; those surface as toasts (bottom left),
 * filtered by the user's notification preferences.
 */
export function useLiveUpdates(enabled: boolean) {
  const qc = useQueryClient();
  const notify = useNotify();
  useEffect(() => {
    if (!enabled) return;
    const scheduler = createRefreshScheduler(qc);
    const es = new EventSource("/app/events");
    es.onmessage = (e) => {
      scheduler.hint();
      try {
        const data = JSON.parse(e.data as string) as {
          notice?: { kind: NoticeKind; message: string } | null;
        };
        if (data.notice) notify(data.notice.kind, data.notice.message);
      } catch {
        // hint without payload: nothing else to do
      }
    };
    es.onopen = () => scheduler.hint();
    return () => {
      es.close();
      scheduler.dispose();
    };
  }, [enabled, qc, notify]);
}
