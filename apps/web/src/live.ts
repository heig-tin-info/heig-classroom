import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useNotify, type NoticeKind } from "./notify";

/**
 * Live updates over SSE (no WebSocket — ADR-005). Events are refresh hints,
 * never data: on any event we invalidate the active queries and TanStack
 * Query refetches through the authorized endpoints. Reconnection (native to
 * EventSource) also triggers a full refetch — no replay needed.
 *
 * Events may carry a typed notice; those surface as toasts (bottom left),
 * filtered by the user's notification preferences.
 */
export function useLiveUpdates(enabled: boolean) {
  const qc = useQueryClient();
  const notify = useNotify();
  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource("/app/events");
    es.onmessage = (e) => {
      void qc.invalidateQueries();
      try {
        const data = JSON.parse(e.data as string) as {
          notice?: { kind: NoticeKind; message: string } | null;
        };
        if (data.notice) notify(data.notice.kind, data.notice.message);
      } catch {
        // hint without payload: nothing else to do
      }
    };
    es.onopen = () => void qc.invalidateQueries();
    return () => es.close();
  }, [enabled, qc, notify]);
}
