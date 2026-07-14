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

/**
 * UI style, orthogonal to light/dark: "classic" is the historical look
 * (soft shadows, rounded-xl), "v2" the revamped one (thin borders, larger
 * squircle-ish radii — overrides scoped to html.ui-v2 in style.css).
 */
export type UiTheme = "classic" | "v2";

export function initialUiTheme(): UiTheme {
  return localStorage.getItem("hgc-ui-theme") === "v2" ? "v2" : "classic";
}

export function applyUiTheme(theme: UiTheme) {
  document.documentElement.classList.toggle("ui-v2", theme === "v2");
  localStorage.setItem("hgc-ui-theme", theme);
}
