import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

/**
 * Live updates over SSE (no WebSocket — ADR-005). Events are refresh hints,
 * never data: on any event we invalidate the active queries and TanStack
 * Query refetches through the authorized endpoints. Reconnection (native to
 * EventSource) also triggers a full refetch — no replay needed.
 */
export function useLiveUpdates(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource("/app/events");
    es.onmessage = () => void qc.invalidateQueries();
    es.onopen = () => void qc.invalidateQueries();
    return () => es.close();
  }, [enabled, qc]);
}
