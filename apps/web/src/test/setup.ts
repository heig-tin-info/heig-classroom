import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

/*
 * jsdom setup for the component suite (the `dom` project in vite.config.ts).
 * Kept as small as the components allow: every stub below exists because a
 * primitive genuinely reads that browser API.
 */

/*
 * Testing Library gives `findBy*` and `waitFor` one second, which assumes a
 * machine running this suite and nothing else. `pnpm -r test` runs four
 * workspaces at once, and under that contention a React Query round trip
 * through a stubbed fetch — resolve, re-render, assert — misses the deadline:
 * TeacherHome's first `findByRole` failed about two runs in three once the
 * command palette suites grew the `dom` project by seventy tests. Nothing is
 * slow on purpose and no query fails to land; only the budget was wrong, and
 * it was wrong before those tests existed, they just made it visible.
 *
 * Five seconds leaves room for a loaded CI runner while keeping a genuinely
 * broken expectation failing promptly.
 */
configure({ asyncUtilTimeout: 5_000 });

/**
 * jsdom runs no layout, so every element reports `offsetWidth`/`offsetHeight`
 * of 0. `focusableIn` (ui.tsx) filters on exactly those to skip hidden
 * controls, so with the real zeros every panel would look empty and the whole
 * focus contract of Modal, Sheet, the drawers and the confirm dialog would be
 * untestable. Connected elements therefore report 1 px. The cost is that a
 * control hidden by CSS still counts as focusable here; no test relies on
 * CSS-hiding, they unmount instead.
 */
for (const prop of ["offsetWidth", "offsetHeight"] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get(this: HTMLElement) {
      return this.isConnected ? 1 : 0;
    },
  });
}

/** `Tabs` observes its scroll strip to decide which edge to fade. */
class ResizeObserverStub implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

/** `theme.ts` asks the OS for its colour scheme; `UserMenu` reads it on mount. */
vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
}));

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  // No test may reach the network. A test that expects a call installs its
  // own stub (`mockFetch`); anything else fails loudly instead of leaving.
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      throw new Error(`Unexpected fetch in a test: ${String(input)}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // Modal and Sheet lock the page scroll; a crashed test must not leak it.
  document.body.style.overflow = "";
});
