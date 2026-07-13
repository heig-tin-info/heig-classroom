/** Portal API client: session cookies + double-submit CSRF header. */
import { useQuery } from "@tanstack/react-query";

import type { Me } from "@hgc/contracts";

function csrfToken(): string {
  return (
    document.cookie
      .split("; ")
      .find((c) => c.startsWith("hgc_csrf="))
      ?.slice("hgc_csrf=".length) ?? ""
  );
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API ${status}`);
  }
}

export async function api<T>(
  path: string,
  init: RequestInit & { csv?: string } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== "GET") {
    headers.set("x-csrf-token", csrfToken());
  }
  if (init.body instanceof Blob) {
    headers.set("content-type", init.body.type || "application/octet-stream");
  } else if (init.body && !init.csv) {
    headers.set("content-type", "application/json");
  }
  if (init.csv) {
    headers.set("content-type", "text/csv");
    init.body = init.csv;
  }
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!res.ok) {
    throw new ApiError(res.status, await res.json().catch(() => null));
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Server-provided error message of a failed call, or the fallback. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError
    ? ((err.body as { message?: string })?.message ?? fallback)
    : fallback;
}

/** Current session, or null when signed out (401). */
export function useMe() {
  return useQuery<Me | null>({
    queryKey: ["me"],
    retry: false,
    queryFn: async () => {
      try {
        return await api<Me>("/app/api/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
  });
}
