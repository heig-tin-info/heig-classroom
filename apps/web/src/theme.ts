/** Light/dark theme: follows the system by default, toggle is persisted. */

export type Theme = "light" | "dark";

export function initialTheme(): Theme {
  const stored = localStorage.getItem("hgc-theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
  localStorage.setItem("hgc-theme", theme);
}
