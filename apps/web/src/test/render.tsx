import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { vi } from "vitest";

import { ConfirmProvider } from "../confirm";
import { HelpProvider } from "../help";
import { I18nProvider, type Locale } from "../i18n";
import { ToastProvider } from "../notify";

/*
 * Test harness: the provider stack of main.tsx without main.tsx itself (which
 * boots the app into #root), plus a fetch stub so a component test never
 * leaves the process.
 */

/** Mirror of the private `STORE_KEY` of i18n.tsx (its provider reads it on init). */
const LOCALE_KEY = "hgc-locale";

/**
 * Queries never retry here: a failing test must fail at once, not in a second.
 * `staleTime: Infinity` keeps a cache seeded by the test from being refetched
 * behind its back; `invalidateQueries` and an explicit `refetch()` still run,
 * which is what the mutation and retry paths rely on.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

export interface ProviderOptions {
  /** Language of the student-facing strings; English by default. */
  locale?: Locale;
  /** Path (and query) the component reads through `window.location`. */
  route?: string;
  /** Pass a prefilled client to seed a query cache instead of stubbing fetch. */
  queryClient?: QueryClient;
}

/**
 * Renders `ui` under the same providers as the real app, in the same order.
 * Returns the usual RTL result plus the QueryClient, so a test can seed or
 * inspect the cache.
 */
export function renderWithProviders(ui: ReactElement, options: ProviderOptions = {}) {
  const { locale = "en", route = "/", queryClient = makeQueryClient() } = options;
  localStorage.setItem(LOCALE_KEY, locale);
  window.history.replaceState(null, "", route);
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <ToastProvider>
            <ConfirmProvider>
              <HelpProvider>{children}</HelpProvider>
            </ConfirmProvider>
          </ToastProvider>
        </I18nProvider>
      </QueryClientProvider>
    );
  }
  return { ...render(ui, { wrapper: Wrapper }), queryClient };
}

// --- fetch stub ---

export interface RecordedCall {
  url: string;
  method: string;
  /** JSON-parsed request body, or null when there was none. */
  body: unknown;
}

export interface Reply {
  status: number;
  /** Serialized as JSON; leave it out for a 204. */
  body?: unknown;
}

export type RouteHandler = Reply | ((call: RecordedCall) => Reply);

/** 200 with a JSON payload. */
export const ok = (body?: unknown): Reply => ({ status: 200, body });
/** 204, the shape `api()` turns into `undefined`. */
export const noContent = (): Reply => ({ status: 204 });
/** Any error status; `body` is what `apiErrorMessage` reads. */
export const fail = (status: number, body?: unknown): Reply => ({ status, body });

/**
 * Installs a `fetch` answering the given routes, keyed `"<METHOD> <url>"`
 * exactly as the app calls them (query string included). An unknown route
 * answers 404 with a message naming it, so a missed endpoint shows up as a
 * readable error state rather than a hang. Every call is recorded, in order,
 * for the tests that assert on the endpoint and the verb.
 */
export function mockFetch(routes: Record<string, RouteHandler>) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const call: RecordedCall = { url, method, body: parseBody(init.body) };
    calls.push(call);
    const handler = routes[`${method} ${url}`];
    const reply: Reply =
      handler === undefined
        ? { status: 404, body: { message: `No stubbed route for ${method} ${url}` } }
        : typeof handler === "function"
          ? handler(call)
          : handler;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
