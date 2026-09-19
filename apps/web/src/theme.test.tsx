import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { UserMenu } from "./Header";
import { SettingsPage } from "./SettingsPage";
import { makeMe } from "./test/fixtures";
import { mockFetch, ok, renderWithProviders } from "./test/render";
import { applyTheme, getThemeChoice, setThemeChoice } from "./theme";

/*
 * The theme lives in one store, not in a `useState` per surface. Two places
 * show it — the account menu's light/dark toggle and the three-way control on
 * the settings page — and when each kept its own copy, changing one left the
 * other showing the previous value and its toggle became a no-op.
 */

const openAccountMenu = async () => {
  await userEvent.click(screen.getByRole("button", { name: "User menu" }));
  return screen.getByRole("menu");
};

describe("theme store", () => {
  it("reads the choice back from storage, and defaults to following the OS", () => {
    expect(getThemeChoice()).toBe("system");
    setThemeChoice("dark");
    expect(getThemeChoice()).toBe("dark");
    expect(document.documentElement).toHaveClass("dark");
    setThemeChoice("system");
    expect(getThemeChoice()).toBe("system");
    // matchMedia is stubbed to "not dark" in the jsdom setup.
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("drops the key an earlier release used", () => {
    localStorage.setItem("hgc-ui-theme", "dark");
    applyTheme("light");
    expect(localStorage.getItem("hgc-ui-theme")).toBeNull();
  });
});

describe("theme surfaces stay in step", () => {
  const renderBoth = () => {
    mockFetch({ "GET /app/api/me": ok(makeMe()) });
    return renderWithProviders(
      <>
        <UserMenu me={makeMe()} onOpenSettings={vi.fn()} />
        <SettingsPage me={makeMe()} />
      </>,
    );
  };

  it("relabels the menu toggle after the settings control picked dark", async () => {
    renderBoth();
    expect(within(await openAccountMenu()).getByRole("menuitem", { name: "Dark theme" })).toBeVisible();
    await userEvent.keyboard("{Escape}");

    await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
    // Without the shared store the menu was still offering "Dark theme" here,
    // and picking it did nothing at all.
    expect(within(await openAccountMenu()).getByRole("menuitem", { name: "Light theme" })).toBeVisible();
  });

  it("moves the settings control when the menu toggle flips the theme", async () => {
    renderBoth();
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();

    await userEvent.click(
      within(await openAccountMenu()).getByRole("menuitem", { name: "Dark theme" }),
    );
    // The toggle has two labels, so it stores an explicit choice: "system"
    // cannot be expressed by flipping between light and dark.
    await waitFor(() => expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked());
    expect(document.documentElement).toHaveClass("dark");

    await userEvent.click(
      within(await openAccountMenu()).getByRole("menuitem", { name: "Light theme" }),
    );
    await waitFor(() => expect(screen.getByRole("radio", { name: "Light" })).toBeChecked());
    expect(document.documentElement).not.toHaveClass("dark");
  });
});
