import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RosterImport } from "./RosterImport";
import { fail, mockFetch, ok, renderWithProviders } from "./test/render";

/*
 * The "Add students" sheet. Its one hard case is a partly rejected import:
 * the offending lines have to be readable next to where the file was given,
 * and the footer has to say something rather than stay blank.
 */

const ROSTER = "/app/api/classrooms/c1/roster";

const errors = [
  { line: 3, message: "missing e-mail" },
  { line: 7, message: "duplicate e-mail" },
];

const openSheet = (reply: ReturnType<typeof ok>) => {
  const stub = mockFetch({ [`POST ${ROSTER}`]: reply });
  renderWithProviders(<RosterImport classroomId="c1" onClose={vi.fn()} />, {
    route: "/classrooms/c1?tab=students",
  });
  return stub;
};

const pasteAndImport = async () => {
  await userEvent.type(screen.getByLabelText("Roster CSV"), "Dupont,Marie,marie@heig-vd.ch");
  await userEvent.click(screen.getByRole("button", { name: /Import CSV/ }));
};

describe("RosterImport rejected lines", () => {
  it("lists them under the drop zone and counts them in the footer", async () => {
    openSheet(fail(422, { message: "Some lines were rejected", errors }));
    await pasteAndImport();

    const first = await screen.findByText(/line 3: missing e-mail/);
    expect(screen.getByText(/line 7: duplicate e-mail/)).toBeVisible();
    // Under the drop zone, where the file was let go: at the bottom of the
    // sheet the list was off screen on a phone.
    const dropZone = screen.getByRole("button", { name: "Drop a roster file" });
    expect(dropZone.parentElement?.contains(first)).toBe(true);

    // The footer used to show nothing at all in this case.
    expect(screen.getByText("2 lines rejected — see above.")).toBeVisible();
  });

  it("keeps the plain failure line when the server names no line", async () => {
    openSheet(fail(500, { message: "database is down" }));
    await pasteAndImport();
    expect(await screen.findByText("Import failed.")).toBeVisible();
  });

  it("says the import is done when it went through", async () => {
    openSheet(ok({ imported: 1 }));
    await pasteAndImport();
    await waitFor(() => expect(screen.getByText("Import done")).toBeVisible());
  });
});
