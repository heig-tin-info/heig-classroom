import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { GroupsPage } from "./GroupsPage";
import { makeGroup, makeGroupMember, makeGroupsPayload } from "./test/fixtures";
import { fail, mockFetch, ok, renderWithProviders } from "./test/render";

/*
 * The group-formation screen. What it has to keep true: the payload is what
 * the two panes show, a click on the left really posts a membership to the
 * SELECTED group, the ✕ really deletes one, and a group whose repository
 * exists offers neither — those are the calls nobody wants to discover wrong
 * against a live classroom.
 */

const GROUPS = "/app/api/classrooms/c1/assignments/a1/groups";

const lucas = makeGroupMember({ enrollmentId: "e-1", nom: "Rochat", prenom: "Lucas" });
const emma = makeGroupMember({ enrollmentId: "e-2", nom: "Favre", prenom: "Emma" });
const noah = makeGroupMember({
  enrollmentId: "e-3",
  nom: "Bovet",
  prenom: "Noah",
  claimStatus: "pending",
  githubLogin: null,
});

const payload = makeGroupsPayload({
  assignment: { id: "a1", name: "Lab 5", state: "draft", groupMode: true, groupMaxSize: 2 },
  groups: [
    makeGroup({ id: "g-1", name: "Les Castors", slug: "les-castors", members: [lucas] }),
    makeGroup({ id: "g-2", name: "Group 2", members: [] }),
  ],
  unassigned: [noah, emma],
  copySources: [{ id: "a2", name: "Lab 4", groups: 3 }],
});

const renderPage = (overrides: Parameters<typeof mockFetch>[0] = {}) => {
  const stub = mockFetch({ [`GET ${GROUPS}`]: ok(payload), ...overrides });
  const navigate = vi.fn();
  renderWithProviders(
    <GroupsPage classroomId="c1" assignmentId="a1" navigate={navigate} />,
    { route: "/classrooms/c1/assignments/a1/groups" },
  );
  return { ...stub, navigate };
};

const card = (name: string) => screen.getByRole("button", { name: `Group ${name}` });
/** A row of the left pane, scoped so a member chip's ✕ never matches it. */
const waiting = (name: RegExp) =>
  within(screen.getByRole("list", { name: "Unassigned students" })).queryByRole("button", {
    name,
  });

describe("GroupsPage rendering", () => {
  it("shows the groups, their members and who is left", async () => {
    renderPage();
    expect(await screen.findByRole("button", { name: "Group Les Castors" })).toBeVisible();
    expect(within(card("Les Castors")).getByText("Lucas Rochat")).toBeVisible();
    expect(within(card("Group 2")).getByText("No members yet.")).toBeVisible();
    // The left pane counts what the payload sent, not what a filter shows.
    expect(screen.getByText("Unassigned")).toBeVisible();
    expect(waiting(/Noah Bovet/)).toBeVisible();
    expect(waiting(/Emma Favre/)).toBeVisible();
  });

  it("selects the first group by default, so a click on the left lands somewhere", async () => {
    renderPage();
    await screen.findByRole("button", { name: "Group Les Castors" });
    expect(card("Les Castors")).toHaveAttribute("aria-pressed", "true");
    expect(card("Group 2")).toHaveAttribute("aria-pressed", "false");
    // The affordance, not the colour, says where the next click goes.
    expect(
      within(card("Les Castors")).getByText("Click a student in the Unassigned list to add them here."),
    ).toBeVisible();
  });

  it("warns when a group is over the size hint", async () => {
    renderPage({
      [`GET ${GROUPS}`]: ok(
        makeGroupsPayload({
          assignment: { id: "a1", name: "Lab 5", state: "draft", groupMode: true, groupMaxSize: 1 },
          groups: [makeGroup({ id: "g-1", name: "Group 1", members: [lucas, emma] })],
        }),
      ),
    });
    expect(await screen.findByText("over the hint")).toBeVisible();
    expect(screen.getByText("2 / 1")).toBeVisible();
  });

  it("answers, rather than fails, when the assignment is not in group mode", async () => {
    const { navigate } = renderPage({
      [`GET ${GROUPS}`]: fail(409, { error: "group_mode_off", message: "not in group mode" }),
    });
    expect(await screen.findByText("This assignment is individual")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back to the assignment" }));
    expect(navigate).toHaveBeenCalledWith({
      view: "assignment",
      classroomId: "c1",
      assignmentId: "a1",
    });
  });

  it("offers a retry on a real failure", async () => {
    renderPage({ [`GET ${GROUPS}`]: fail(500, { message: "database is down" }) });
    expect(await screen.findByText("Could not load the groups")).toBeVisible();
    expect(screen.getByText("database is down")).toBeVisible();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeVisible();
  });

  it("hands the empty case its one action", async () => {
    renderPage({ [`GET ${GROUPS}`]: ok(makeGroupsPayload({ groups: [] })) });
    expect(await screen.findByText("No group yet")).toBeVisible();
    // Exactly one, in the empty state: the toolbar hands its primary over
    // rather than showing the same accent button twice.
    expect(screen.getAllByRole("button", { name: /Add group/ })).toHaveLength(1);
  });
});

describe("GroupsPage membership", () => {
  it("puts a clicked student in the selected group", async () => {
    const { calls } = renderPage({
      [`POST ${GROUPS}/g-2/members`]: ok(
        makeGroupsPayload({
          groups: [
            makeGroup({ id: "g-1", name: "Les Castors", members: [lucas] }),
            makeGroup({ id: "g-2", name: "Group 2", members: [emma] }),
          ],
          unassigned: [noah],
        }),
      ),
    });
    await screen.findByRole("button", { name: "Group Group 2" });
    await userEvent.click(card("Group 2"));
    await userEvent.click(waiting(/Emma Favre/)!);
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: `${GROUPS}/g-2/members`,
        method: "POST",
        body: { enrollmentId: "e-2" },
      }),
    );
    // The answer is the whole payload: both panes re-render from it.
    expect(within(card("Group 2")).getByText("Emma Favre")).toBeVisible();
    expect(waiting(/Emma Favre/)).toBeNull();
  });

  it("removes a member from the ✕ of their chip", async () => {
    const { calls } = renderPage({
      [`DELETE ${GROUPS}/g-1/members/e-1`]: ok(
        makeGroupsPayload({
          groups: [makeGroup({ id: "g-1", name: "Les Castors", members: [] })],
          unassigned: [lucas],
        }),
      ),
    });
    await screen.findByRole("button", { name: "Group Les Castors" });
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Lucas Rochat from the group" }),
    );
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: `${GROUPS}/g-1/members/e-1`,
        method: "DELETE",
        body: null,
      }),
    );
  });

  it("leaves a locked group no rename and no way to delete it", async () => {
    renderPage({
      [`GET ${GROUPS}`]: ok(
        makeGroupsPayload({
          groups: [
            makeGroup({
              id: "g-1",
              name: "Les Castors",
              members: [lucas],
              repo: { fullName: "heig/lab5-les-castors", provisionStatus: "ok" },
            }),
          ],
        }),
      ),
    });
    expect(await screen.findByText("repository exists")).toBeVisible();
    // The name is text now, not a button that opens an input.
    expect(screen.queryByRole("button", { name: "Les Castors" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Actions for Les Castors" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Rename" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(menu).getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("asks before removing a member from a group with a repository (lot 2 revokes)", async () => {
    const locked = makeGroupsPayload({
      groups: [
        makeGroup({
          id: "g-1",
          name: "Les Castors",
          members: [lucas],
          repo: { fullName: "heig/lab5-les-castors", provisionStatus: "ok" },
        }),
      ],
    });
    const { calls } = renderPage({
      [`GET ${GROUPS}`]: ok(locked),
      [`DELETE ${GROUPS}/g-1/members/e-1`]: ok(
        makeGroupsPayload({
          groups: [makeGroup({ id: "g-1", name: "Les Castors", members: [] })],
          unassigned: [lucas],
        }),
      ),
    });
    await screen.findByText("repository exists");
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Lucas Rochat from the group" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/lose their access to heig\/lab5-les-castors/)).toBeVisible();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: `${GROUPS}/g-1/members/e-1`,
        method: "DELETE",
        body: null,
      }),
    );
  });

  it("says why a removal was refused, on the group it was refused for", async () => {
    renderPage({
      [`DELETE ${GROUPS}/g-1/members/e-1`]: fail(409, {
        error: "has_repo",
        message: "the repository exists",
      }),
    });
    await screen.findByRole("button", { name: "Group Les Castors" });
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Lucas Rochat from the group" }),
    );
    expect(await screen.findByText(/already has a repository/)).toBeVisible();
  });
});

describe("GroupsPage toolbar", () => {
  it("adds a group and selects it", async () => {
    const { calls } = renderPage({
      [`POST ${GROUPS}`]: ok(makeGroup({ id: "g-3", name: "Group 3" })),
      // The create path invalidates rather than adopting a payload.
      [`GET ${GROUPS}`]: ok(payload),
    });
    await screen.findByRole("button", { name: "Group Les Castors" });
    await userEvent.click(screen.getAllByRole("button", { name: /Add group/ })[0]!);
    await waitFor(() =>
      expect(calls).toContainEqual({ url: GROUPS, method: "POST", body: {} }),
    );
  });

  it("puts the rest in groups of one", async () => {
    const { calls } = renderPage({
      [`POST ${GROUPS}/singles`]: ok(makeGroupsPayload({ unassigned: [] })),
    });
    await screen.findByRole("button", { name: "Group Les Castors" });
    await userEvent.click(screen.getByRole("button", { name: /Everyone else alone/ }));
    await waitFor(() =>
      expect(calls).toContainEqual({ url: `${GROUPS}/singles`, method: "POST", body: null }),
    );
  });

  it("splits the remaining students by the size picked in the menu", async () => {
    const { calls } = renderPage({
      [`POST ${GROUPS}/split`]: ok(makeGroupsPayload({ unassigned: [] })),
    });
    await screen.findByRole("button", { name: "Group Les Castors" });
    await userEvent.click(screen.getByRole("button", { name: /Split remaining/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Groups of 3/ }));
    await waitFor(() =>
      expect(calls).toContainEqual({ url: `${GROUPS}/split`, method: "POST", body: { size: 3 } }),
    );
  });

  it("asks before replacing every group with a copy", async () => {
    const { calls } = renderPage({
      [`POST ${GROUPS}/copy`]: ok(makeGroupsPayload()),
    });
    await screen.findByRole("button", { name: "Group Les Castors" });
    await userEvent.click(screen.getByRole("button", { name: /Copy from…/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Lab 4/ }));
    // A replacement is destructive: it goes through the confirm dialog.
    expect(await screen.findByRole("dialog")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Replace the groups" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: `${GROUPS}/copy`,
        method: "POST",
        body: { fromAssignmentId: "a2" },
      }),
    );
  });
});
