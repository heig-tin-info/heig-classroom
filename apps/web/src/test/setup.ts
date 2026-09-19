import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

/*
 * jsdom setup for the component suite (the `dom` project in vite.config.ts).
 * Kept as small as the components allow: every stub below exists because a
 * primitive genuinely reads that browser API.
 */

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
