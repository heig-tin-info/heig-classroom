import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AssignmentsSection } from "./AssignmentsCard";
import { makeAssignment, makeMe } from "./test/fixtures";
import { fail, mockFetch, ok, renderWithProviders } from "./test/render";

/*
 * The assignments section of a classroom. What it has to keep true: the way
 * to create an assignment does not vanish because a query is slow or broken,
 * the missing GitHub App is said once and not only on an empty list, and an
 * archived assignment keeps a way back to its repositories on GitHub.
 */

const LIST = "/app/api/classrooms/c1/assignments";

const renderSection = (
  routes: Parameters<typeof mockFetch>[0],
  { appInstalled = true }: { appInstalled?: boolean } = {},
) => {
  const stub = mockFetch({ "GET /app/api/me": ok(makeMe()), ...routes });
  renderWithProviders(
    <AssignmentsSection
      classroomId="c1"
      appInstalled={appInstalled}
      onOpenAssignment={vi.fn()}
    />,
    { route: "/classrooms/c1" },
  );
  return stub;
};

const createButton = () => screen.queryByRole("button", { name: /Create assignment/ });

describe("AssignmentsSection header action", () => {
  it("offers Create assignment beside a loaded list", async () => {
    renderSection({ [`GET ${LIST}`]: ok([makeAssignment()]) });
    expect(await screen.findByText("Labo 02 quadratic")).toBeVisible();
    expect(createButton()).toBeVisible();
  });

  it("keeps it while the list is still loading", () => {
    renderSection({ [`GET ${LIST}`]: ok([makeAssignment()]) });
    // Nothing has resolved yet: `list.data` is undefined, which used to hide
    // the button as if the list were empty.
    expect(createButton()).toBeVisible();
  });

  it("keeps it when the list failed to load", async () => {
    renderSection({ [`GET ${LIST}`]: fail(500, { message: "database is down" }) });
    expect(await screen.findByText("Could not load the assignments")).toBeVisible();
    expect(createButton()).toBeVisible();
  });

  it("hands it over to the empty state on a genuinely empty list", async () => {
    renderSection({ [`GET ${LIST}`]: ok([]) });
    expect(await screen.findByText("No assignments yet")).toBeVisible();
    // Exactly one, in the empty state: two accent buttons for one action is
    // one too many.
    expect(screen.getAllByRole("button", { name: /Create assignment/ })).toHaveLength(1);
  });
});

describe("AssignmentsSection without the GitHub App", () => {
  it("says so above the list, whatever state the list is in", async () => {
    renderSection({ [`GET ${LIST}`]: ok([makeAssignment()]) }, { appInstalled: false });
    expect(await screen.findByText("Assignments need the GitHub App")).toBeVisible();
    expect(createButton()).toBeNull();
  });

  it("still says so when the list failed", async () => {
    renderSection(
      { [`GET ${LIST}`]: fail(500, { message: "database is down" }) },
      { appInstalled: false },
    );
    expect(await screen.findByText("Assignments need the GitHub App")).toBeVisible();
  });

  it("says it once when the list is empty: the empty state already carries it", async () => {
    renderSection({ [`GET ${LIST}`]: ok([]) }, { appInstalled: false });
    expect(await screen.findAllByText("Assignments need the GitHub App")).toHaveLength(1);
  });
});

describe("AssignmentsSection archives", () => {
  const openArchives = async () => {
    const stub = renderSection({
      [`GET ${LIST}`]: ok([makeAssignment()]),
      [`GET ${LIST}?archived=1`]: ok([makeAssignment({ name: "Labo 01 hello" })]),
      [`POST ${LIST}/a1/unarchive`]: ok(),
    });
    await screen.findByText("Labo 02 quadratic");
    await userEvent.click(screen.getByRole("button", { name: "Archives" }));
    await screen.findByText("Labo 01 hello");
    return stub;
  };

  it("keeps the repository links on an archived row, not just Restore", async () => {
    await openArchives();
    await userEvent.click(screen.getByRole("button", { name: "Actions for Labo 01 hello" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Restore" })).toBeVisible();
    // Archiving does not delete anything on GitHub, so the way there stays.
    expect(within(menu).getByRole("menuitem", { name: "Source repository" })).toHaveAttribute(
      "href",
      "https://github.com/heig-prg1-2026/labo-02-quadratic",
    );
    expect(
      within(menu).getByRole("menuitem", { name: "Distributed repository" }),
    ).toHaveAttribute("href", "https://github.com/heig-prg1-2026/labo-02-quadratic-squashed");
  });

  it("restores from that menu", async () => {
    const { calls } = await openArchives();
    await userEvent.click(screen.getByRole("button", { name: "Actions for Labo 01 hello" }));
    await userEvent.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "Restore" }),
    );
    expect(calls).toContainEqual({ url: `${LIST}/a1/unarchive`, method: "POST", body: null });
  });
});
