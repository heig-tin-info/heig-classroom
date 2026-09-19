import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RosterTable } from "./RosterTable";
import { makeRosterEntry } from "./test/fixtures";
import { renderWithProviders } from "./test/render";

/*
 * The roster rows. Revoking a claim and removing a student are the two
 * destructive actions of this table: they go through the confirm dialog, and
 * while one is in flight the row says so and refuses to fire it a second
 * time. `mockFetch` answers at once, which is the one thing a pending state
 * cannot be tested against, so this file stubs a fetch that never answers.
 */

const UNCLAIM = "/app/api/classrooms/c1/roster/e-1/unclaim";

/** Records every call and never answers: the mutation stays pending. */
function hangingFetch() {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Promise<Response>(() => {});
    }),
  );
  return urls;
}

const openRowMenu = async () => {
  await userEvent.click(screen.getByRole("button", { name: "Actions for Lucas Rochat" }));
  return screen.getByRole("menu");
};

describe("RosterTable pending actions", () => {
  it("shows the row is busy and refuses a second revoke while the first runs", async () => {
    const urls = hangingFetch();
    renderWithProviders(<RosterTable classroomId="c1" roster={[makeRosterEntry()]} />, {
      route: "/classrooms/c1?tab=students",
    });

    await userEvent.click(
      within(await openRowMenu()).getByRole("menuitem", { name: "Revoke claim" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));

    // The menu closed on the click, so the row itself has to carry the fact
    // that something is running.
    await waitFor(() => expect(screen.getByLabelText("Working…")).toBeVisible());
    expect(urls.filter((u) => u === UNCLAIM)).toHaveLength(1);

    const item = within(await openRowMenu()).getByRole("menuitem", { name: "Revoke claim" });
    expect(item).toBeDisabled();
    await userEvent.click(item).catch(() => {
      // user-event refuses a disabled control; that is exactly the point.
    });
    expect(urls.filter((u) => u === UNCLAIM)).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables Remove from roster the same way", async () => {
    const urls = hangingFetch();
    renderWithProviders(<RosterTable classroomId="c1" roster={[makeRosterEntry()]} />, {
      route: "/classrooms/c1?tab=students",
    });

    await userEvent.click(
      within(await openRowMenu()).getByRole("menuitem", { name: "Remove from roster" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByLabelText("Working…")).toBeVisible());

    expect(
      within(await openRowMenu()).getByRole("menuitem", { name: "Remove from roster" }),
    ).toBeDisabled();
    expect(urls).toHaveLength(1);
  });
});
