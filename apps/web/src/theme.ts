/**
 * Light/dark theme. "system" follows the OS and reacts to its changes; an
 * explicit choice is persisted in this browser.
 */

export type ThemeChoice = "light" | "dark" | "system";
export type Theme = "light" | "dark";

const KEY = "hgc-theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export function initialTheme(): ThemeChoice {
  const stored = localStorage.getItem(KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

/** The theme actually on screen for a choice. */
export function resolveTheme(choice: ThemeChoice): Theme {
  return choice === "system" ? (media().matches ? "dark" : "light") : choice;
}

let unsubscribe: (() => void) | null = null;

export function applyTheme(choice: ThemeChoice) {
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
    const onChange = () => set(m.matches ? "dark" : "light");
    m.addEventListener("change", onChange);
    unsubscribe = () => m.removeEventListener("change", onChange);
  }
}
