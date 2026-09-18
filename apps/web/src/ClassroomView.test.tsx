import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ClassroomView } from "./ClassroomView";
import { makeAssignment, makeClassroomDetail, makeMe, makeRosterEntry } from "./test/fixtures";
import { fail, mockFetch, noContent, ok, renderWithProviders } from "./test/render";

/*
 * The classroom page: the tab strip that survives a reload through `?tab=`,
 * and the destructive actions of the settings tab, which must go through the
 * confirm dialog before anything is sent.
 */

const DETAIL = "/app/api/classrooms/c1";

const baseRoutes = (): Parameters<typeof mockFetch>[0] => ({
  [`GET ${DETAIL}`]: ok(makeClassroomDetail({ roster: [makeRosterEntry()] })),
  [`GET ${DETAIL}/assignments`]: ok([makeAssignment()]),
  "GET /app/api/me": ok(makeMe()),
  [`POST ${DETAIL}/archive`]: noContent(),
  [`DELETE ${DETAIL}`]: noContent(),
});

const renderClassroom = (
  routes: Parameters<typeof mockFetch>[0] = baseRoutes(),
  navigate = vi.fn(),
) => {
  const stub = mockFetch(routes);
  renderWithProviders(<ClassroomView id="c1" navigate={navigate} />, {
    route: "/classrooms/c1",
  });
  return { ...stub, navigate };
};

describe("ClassroomView tabs", () => {
  it("opens on the assignments tab and names its panel", async () => {
    renderClassroom();
    expect(await screen.findByRole("heading", { name: "PRG1 2026", level: 1 })).toBeVisible();
    const tab = screen.getByRole("tab", { name: /Assignments/ });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(document.getElementById("classroom-panel-assignments")).not.toBeNull();
    expect(window.location.search).toBe("");
  });

  it("switches tab and writes it into the URL, so a reload lands on it", async () => {
    renderClassroom();
    await screen.findByRole("tab", { name: /Students/ });
    await userEvent.click(screen.getByRole("tab", { name: /Students/ }));
    expect(window.location.search).toBe("?tab=students");
    expect(screen.getByRole("tab", { name: /Students/ })).toHaveAttribute("aria-selected", "true");
    expect(document.getElementById("classroom-panel-students")).not.toBeNull();
    // The roster table splits the name in two columns (last, first).
    expect(screen.getByText("Rochat")).toBeVisible();
    expect(screen.getByText("Lucas")).toBeVisible();
  });

  it("restores the tab written in the URL", async () => {
    const stub = mockFetch(baseRoutes());
    renderWithProviders(<ClassroomView id="c1" navigate={vi.fn()} />, {
      route: "/classrooms/c1?tab=staff",
    });
    expect(await screen.findByRole("tab", { name: /Staff/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("No one else works on this classroom")).toBeVisible();
    expect(stub.calls.some((c) => c.url === `${DETAIL}/assignments`)).toBe(false);
  });

  it("drops the parameter again on the way back to the default tab", async () => {
    renderClassroom();
    await screen.findByRole("tab", { name: /Students/ });
    await userEvent.click(screen.getByRole("tab", { name: /Students/ }));
    expect(window.location.search).toBe("?tab=students");
    await userEvent.click(screen.getByRole("tab", { name: /Assignments/ }));
    expect(window.location.search).toBe("");
  });
});

describe("ClassroomView settings tab", () => {
  const openSettings = async () => {
    const stub = renderClassroom();
    await screen.findByRole("tab", { name: "Settings" });
    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    return stub;
  };

  it("asks before archiving, and sends nothing while the question is open", async () => {
    const { calls } = await openSettings();
    await userEvent.click(screen.getByRole("button", { name: /Archive classroom/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Archive “PRG1 2026”?");
    expect(
      within(dialog).getByText(/disappears for you and the students/),
    ).toBeVisible();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("archives once the teacher confirms, then leaves the classroom", async () => {
    const { calls, navigate } = await openSettings();
    await userEvent.click(screen.getByRole("button", { name: /Archive classroom/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive classroom" }));
    await waitFor(() =>
      expect(calls).toContainEqual({ url: `${DETAIL}/archive`, method: "POST", body: null }),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "home" }));
  });

  it("sends nothing when the teacher cancels the deletion", async () => {
    const { calls } = await openSettings();
    await userEvent.click(screen.getByRole("button", { name: /Delete permanently/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Delete permanently" })).toHaveClass(
      "bg-danger",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("keeps Rename disabled until the name actually changes", async () => {
    await openSettings();
    const field = screen.getByLabelText("Classroom name");
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
    await userEvent.type(field, " bis");
    expect(screen.getByRole("button", { name: "Rename" })).toBeEnabled();
  });
});

describe("ClassroomView states", () => {
  it("offers a way out when the classroom does not exist", async () => {
    const navigate = vi.fn();
    mockFetch({ [`GET ${DETAIL}`]: fail(404, { message: "not found" }) });
    renderWithProviders(<ClassroomView id="c1" navigate={navigate} />, {
      route: "/classrooms/c1",
    });
    expect(await screen.findByText("Classroom not found")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back to my classrooms" }));
    expect(navigate).toHaveBeenCalledWith({ view: "home" });
    // A 404 is an answer, not a failure: no retry alert on top of it.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows the failed query with a retry for anything that is not a 404", async () => {
    mockFetch({ [`GET ${DETAIL}`]: fail(500, { message: "database is down" }) });
    renderWithProviders(<ClassroomView id="c1" navigate={vi.fn()} />, {
      route: "/classrooms/c1",
    });
    expect(await screen.findByText("Could not load this classroom")).toBeVisible();
    expect(screen.getByText("database is down")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("walks the owner through the App installation while it is missing", async () => {
    mockFetch({
      ...baseRoutes(),
      [`GET ${DETAIL}`]: ok(
        makeClassroomDetail({
          org: {
            login: "heig-prg1-2026",
            installationId: null,
            githubOrgId: 99,
            plan: null,
            status: "active",
            exists: true,
            llmSecret: null,
          },
        }),
      ),
    });
    renderWithProviders(<ClassroomView id="c1" navigate={vi.fn()} />, {
      route: "/classrooms/c1",
    });
    expect(await screen.findByText("GitHub App not installed")).toBeVisible();
    expect(screen.getByRole("link", { name: /Install the GitHub App/ })).toHaveAttribute(
      "href",
      expect.stringContaining("target_id=99"),
    );
  });

  it("warns about the GitHub Free plan once the App is installed", async () => {
    mockFetch({
      ...baseRoutes(),
      [`GET ${DETAIL}`]: ok(
        makeClassroomDetail({
          org: {
            login: "heig-prg1-2026",
            installationId: 1,
            githubOrgId: 99,
            plan: "free",
            status: "active",
            exists: true,
            llmSecret: "ok",
          },
        }),
      ),
    });
    renderWithProviders(<ClassroomView id="c1" navigate={vi.fn()} />, {
      route: "/classrooms/c1",
    });
    expect(
      await screen.findByText("heig-prg1-2026 is on the GitHub Free plan"),
    ).toBeVisible();
  });

  it("removes a staff member only after the question, through the right endpoint", async () => {
    const stub = mockFetch({
      ...baseRoutes(),
      [`GET ${DETAIL}`]: ok(
        makeClassroomDetail({
          staff: [
            {
              id: "s-1",
              email: "jean.favre@heig-vd.ch",
              role: "assistant",
              givenName: "Jean",
              familyName: "Favre",
              claimed: true,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      ),
      [`DELETE ${DETAIL}/staff/s-1`]: noContent(),
    });
    renderWithProviders(<ClassroomView id="c1" navigate={vi.fn()} />, {
      route: "/classrooms/c1?tab=staff",
    });
    await screen.findByText("Jean Favre");
    await userEvent.click(screen.getByRole("button", { name: "Remove from the staff" }));
    await userEvent.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "Remove from the staff" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove from the staff" }),
    );
    await waitFor(() =>
      expect(stub.calls).toContainEqual({
        url: `${DETAIL}/staff/s-1`,
        method: "DELETE",
        body: null,
      }),
    );
  });
});
