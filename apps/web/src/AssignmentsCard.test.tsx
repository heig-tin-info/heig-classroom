import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AssignmentsSection } from "./AssignmentsCard";
import { makeAssignment, makeMe } from "./test/fixtures";
import { fail, mockFetch, noContent, ok, renderWithProviders } from "./test/render";

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

/*
 * Publishing a group assignment: the server refuses (409) while someone is
 * out of every group, and hands back the names. The row has to turn that
 * into the list and the two ways out, not into a red line.
 */
describe("AssignmentsSection publish guard for group assignments", () => {
  const draft = makeAssignment({ state: "draft", groupMode: true, publishMode: "manual" });
  const refusal = {
    error: "unassigned_students",
    message: "2 students are not in any group",
    students: [
      { enrollmentId: "e-1", nom: "Rochat", prenom: "Lucas" },
      { enrollmentId: "e-2", nom: "Favre", prenom: "Emma" },
    ],
  };

  const publishRefused = async (extra: Parameters<typeof mockFetch>[0] = {}) => {
    const onOpenGroups = vi.fn();
    const stub = mockFetch({
      "GET /app/api/me": ok(makeMe()),
      [`GET ${LIST}`]: ok([draft]),
      [`POST ${LIST}/a1/publish`]: fail(409, refusal),
      ...extra,
    });
    renderWithProviders(
      <AssignmentsSection
        classroomId="c1"
        appInstalled
        onOpenAssignment={vi.fn()}
        onOpenGroups={onOpenGroups}
      />,
      { route: "/classrooms/c1" },
    );
    await screen.findByText("Labo 02 quadratic");
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    // The ordinary publish confirmation comes first.
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    return { ...stub, onOpenGroups };
  };

  it("names the students instead of printing the server message", async () => {
    await publishRefused();
    expect(await screen.findByText("2 students have no group")).toBeVisible();
    expect(screen.getByText("Lucas Rochat")).toBeVisible();
    expect(screen.getByText("Emma Favre")).toBeVisible();
    // The dialog carries it: no duplicate red line under the row.
    expect(screen.queryByText("2 students are not in any group")).toBeNull();
  });

  it("puts them in groups of one and publishes again", async () => {
    // The first publish is the refusal; the one after the fix goes through.
    let attempts = 0;
    const { calls } = await publishRefused({
      [`POST ${LIST}/a1/publish`]: () =>
        (attempts += 1) === 1 ? fail(409, refusal) : noContent(),
      [`POST ${LIST}/a1/groups/singles`]: ok({ groups: [], unassigned: [] }),
    });
    await screen.findByText("2 students have no group");
    await userEvent.click(screen.getByRole("button", { name: /Put them in individual groups/ }));
    // Groups of one first, then the publish that was refused.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const posts = calls.filter((c) => c.method === "POST").map((c) => c.url);
    expect(posts).toEqual([
      `${LIST}/a1/publish`,
      `${LIST}/a1/groups/singles`,
      `${LIST}/a1/publish`,
    ]);
    // The refused publish is settled with it: its message must not survive
    // as a red line under an assignment that just went live.
    expect(screen.queryByText("2 students are not in any group")).toBeNull();
  });

  it("drops the refusal when the dialog is closed", async () => {
    await publishRefused();
    await screen.findByText("2 students have no group");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("2 students are not in any group")).toBeNull();
  });

  it("offers only the groups screen when the refusal names nobody", async () => {
    // Group mode with no group at all (or an empty roster): groups of one
    // would create nothing and meet the very same 409 for ever.
    await publishRefused({
      [`POST ${LIST}/a1/publish`]: fail(409, {
        error: "unassigned_students",
        message: "This assignment has no group yet — form at least one before publishing.",
        students: [],
      }),
    });
    expect(await screen.findByText("No group yet")).toBeVisible();
    expect(screen.getByText(/form at least one before publishing/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Put them in individual groups/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Open groups/ })).toBeVisible();
  });

  it("hands the teacher over to the groups screen", async () => {
    const { onOpenGroups } = await publishRefused();
    await screen.findByText("2 students have no group");
    await userEvent.click(screen.getByRole("button", { name: /Open groups/ }));
    expect(onOpenGroups).toHaveBeenCalledWith("a1");
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
