import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TeacherHome } from "./TeacherHome";
import { makeClassroomSummary } from "./test/fixtures";
import { fail, mockFetch, ok, renderWithProviders } from "./test/render";

/*
 * The teacher landing page, through its four states: loading, loaded, empty
 * and failed. Fetch is stubbed on the endpoint the page really calls, so the
 * test breaks if the URL moves.
 */

const CLASSROOMS = "/app/api/classrooms";

const rooms = [
  makeClassroomSummary({ id: "c1", name: "PRG1 2026", orgLogin: "heig-prg1-2026" }),
  makeClassroomSummary({
    id: "c2",
    name: "SYE 2026",
    orgLogin: "heig-sye-2026",
    students: 31,
    claimed: 12,
    isOwner: false,
  }),
];

const renderHome = (navigate = vi.fn()) => ({
  ...renderWithProviders(<TeacherHome navigate={navigate} />),
  navigate,
});

describe("TeacherHome", () => {
  it("renders one card per classroom once the query lands", async () => {
    mockFetch({ [`GET ${CLASSROOMS}`]: ok(rooms) });
    renderHome();
    expect(await screen.findByRole("heading", { name: "PRG1 2026" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "SYE 2026" })).toBeInTheDocument();
    // The header counts what the query returned.
    expect(screen.getByText("2 classrooms · 55 students")).toBeVisible();
    // A classroom the teacher only co-teaches says so.
    expect(screen.getByText("co-taught")).toBeVisible();
  });

  it("opens the classroom that was clicked", async () => {
    mockFetch({ [`GET ${CLASSROOMS}`]: ok(rooms) });
    const { navigate } = renderHome();
    await userEvent.click(await screen.findByRole("heading", { name: "SYE 2026" }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "c2" });
  });

  it("filters the cards as the teacher searches, and says so in the header", async () => {
    mockFetch({ [`GET ${CLASSROOMS}`]: ok(rooms) });
    renderHome();
    await screen.findByRole("heading", { name: "PRG1 2026" });
    await userEvent.type(screen.getByRole("searchbox", { name: "Search…" }), "sye");
    expect(screen.getByRole("heading", { name: "SYE 2026" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "PRG1 2026" })).toBeNull();
    expect(screen.getByText("1 of 2 classrooms")).toBeVisible();
  });

  it("explains a search that matches nothing, without offering an action", async () => {
    mockFetch({ [`GET ${CLASSROOMS}`]: ok(rooms) });
    renderHome();
    await screen.findByRole("heading", { name: "PRG1 2026" });
    await userEvent.type(screen.getByRole("searchbox", { name: "Search…" }), "zzz");
    expect(screen.getByText("No classroom matches")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "PRG1 2026" })).toBeNull();
  });

  it("offers exactly one way in when there is no classroom yet", async () => {
    mockFetch({ [`GET ${CLASSROOMS}`]: ok([]) });
    renderHome();
    expect(await screen.findByText("No classrooms")).toBeVisible();
    // The empty state carries the action, so the page header drops its own:
    // two accent buttons for the same thing is one too many.
    expect(screen.getAllByRole("button", { name: /Create classroom/ })).toHaveLength(1);
    // Nothing to search, sort or archive yet either.
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("opens the creation dialog from the empty state", async () => {
    mockFetch({ [`GET ${CLASSROOMS}`]: ok([]), "GET /app/api/orgs": ok(["heig-prg1-2026"]) });
    renderHome();
    // Wait for the empty state before reaching for the button: while the
    // query is in flight the page header still carries its own "Create
    // classroom", and that one is unmounted the moment the empty state lands.
    await screen.findByText("No classrooms");
    await userEvent.click(screen.getByRole("button", { name: /Create classroom/ }));
    expect(await screen.findByRole("dialog")).toHaveAccessibleName("New classroom");
    expect(screen.getByLabelText("GitHub organization")).toBeInTheDocument();
  });

  it("shows the query error with the server's message, and retries on demand", async () => {
    let attempt = 0;
    mockFetch({
      [`GET ${CLASSROOMS}`]: () => {
        attempt += 1;
        return attempt === 1 ? fail(503, { message: "GitHub is unavailable" }) : ok(rooms);
      },
    });
    renderHome();
    expect(await screen.findByText("Could not load your classrooms")).toBeVisible();
    expect(screen.getByText("GitHub is unavailable")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "PRG1 2026" })).toBeInTheDocument();
    await waitFor(() => expect(attempt).toBe(2));
    expect(screen.queryByText("Could not load your classrooms")).toBeNull();
  });

  it("switches to the list view and remembers the choice for the next visit", async () => {
    mockFetch({ [`GET ${CLASSROOMS}`]: ok(rooms) });
    renderHome();
    await screen.findByRole("heading", { name: "PRG1 2026" });
    await userEvent.click(screen.getByRole("radio", { name: "List view" }));
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Organization/ })).toBeInTheDocument();
    expect(localStorage.getItem("hgc-classrooms-view")).toBe("list");
  });

  it("shows the card skeleton while the classrooms are on their way", async () => {
    mockFetch({ [`GET ${CLASSROOMS}`]: ok(rooms) });
    const { container } = renderHome();
    // Synchronously after the first paint the query is still in flight: the
    // page must be a skeleton, never the "No classrooms" empty state, which
    // would flash at a teacher who does have classrooms.
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    expect(screen.queryByText("No classrooms")).toBeNull();
    expect(await screen.findByRole("heading", { name: "PRG1 2026" })).toBeInTheDocument();
  });

  it("browses the archives on demand, through their own endpoint", async () => {
    mockFetch({
      [`GET ${CLASSROOMS}`]: ok(rooms),
      [`GET ${CLASSROOMS}?archived=1`]: ok([
        makeClassroomSummary({ id: "c9", name: "PRG1 2025", archivedAt: new Date().toISOString() }),
      ]),
    });
    renderHome();
    await screen.findByRole("heading", { name: "PRG1 2026" });
    await userEvent.click(screen.getByRole("button", { name: "Archives" }));
    expect(await screen.findByRole("heading", { name: "PRG1 2025" })).toBeInTheDocument();
    // The active classrooms stay untouched behind the archive view.
    expect(screen.queryByRole("heading", { name: "SYE 2026" })).toBeNull();
  });
});
