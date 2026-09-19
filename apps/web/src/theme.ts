import { useSyncExternalStore } from "react";

/**
 * Light/dark theme. "system" follows the OS and reacts to its changes; an
 * explicit choice is persisted in this browser.
 *
 * The choice is module state behind a tiny subscribable store, not component
 * state: two surfaces show it (the account menu toggle and the Settings
 * segmented control), and a `useState` in each meant the one you did not
 * touch kept showing the old value and its toggle became a no-op.
 */

export type ThemeChoice = "light" | "dark" | "system";
export type Theme = "light" | "dark";

const KEY = "hgc-theme";
/** Key of an earlier release; cleaned up on the first applyTheme of a session. */
const LEGACY_KEY = "hgc-ui-theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export function initialTheme(): ThemeChoice {
  const stored = localStorage.getItem(KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

/** The theme actually on screen for a choice. */
export function resolveTheme(choice: ThemeChoice): Theme {
  return choice === "system" ? (media().matches ? "dark" : "light") : choice;
}

const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The choice in force. Storage is the state, not a module variable: the
 * snapshot is then a plain string, it survives a reload, and nothing can go
 * stale behind a test that clears localStorage.
 */
export function getThemeChoice(): ThemeChoice {
  return initialTheme();
}

/** Applies a choice, persists it and wakes every surface that shows it. */
export function setThemeChoice(next: ThemeChoice) {
  applyTheme(next);
  emit();
}

/** The stored choice (light / dark / system), for the Settings control. */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, getThemeChoice, getThemeChoice);
}

/**
 * The theme actually on screen, for the surfaces that offer a light/dark
 * toggle. It follows an OS change too, because the "system" listener below
 * emits: the choice is still "system" but the resolved value flipped.
 */
export function useResolvedTheme(): Theme {
  const snapshot = () => resolveTheme(getThemeChoice());
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

let unsubscribe: (() => void) | null = null;

export function applyTheme(choice: ThemeChoice) {
  localStorage.removeItem(LEGACY_KEY);
  const set = (theme: Theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
  };
  set(resolveTheme(choice));
  if (choice === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, choice);
  unsubscribe?.();
  unsubscribe = null;
  if (choice === "system") {
    const m = media();
    const onChange = () => {
      set(m.matches ? "dark" : "light");
      emit();
    };
    m.addEventListener("change", onChange);
    unsubscribe = () => m.removeEventListener("change", onChange);
  }
}
