import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ClassroomSummary } from "@hgc/contracts";

import { Shell } from "./Shell";
import { makeClassroomSummary, makeMe } from "./test/fixtures";
import { makeQueryClient, renderWithProviders } from "./test/render";
import type { Route } from "./router";

/*
 * The application frame. The classroom list comes from a seeded query cache
 * rather than from fetch: the point here is the navigation the teacher reads,
 * not the endpoint (which `api.ts` owns).
 *
 * The desktop sidebar and the mobile drawer render the same <Nav>, and both
 * are in the DOM at once while the drawer is open (only CSS hides one), so
 * every drawer assertion is scoped to the drawer dialog.
 */

const rooms = (n: number): ClassroomSummary[] =>
  Array.from({ length: n }, (_, i) =>
    makeClassroomSummary({ id: `c${i + 1}`, name: `Classroom ${i + 1}` }),
  );

function renderShell({
  route = { view: "home" } as Route,
  classrooms = rooms(3),
  teacherUi = true,
  studentView = false,
  me = makeMe(),
  navigate = vi.fn(),
  onToggleStudentView = vi.fn(),
}: {
  route?: Route;
  classrooms?: ClassroomSummary[];
  teacherUi?: boolean;
  studentView?: boolean;
  me?: ReturnType<typeof makeMe>;
  navigate?: (r: Route) => void;
  onToggleStudentView?: () => void;
} = {}) {
  const queryClient = makeQueryClient();
  queryClient.setQueryData(["classrooms"], classrooms);
  renderWithProviders(
    <Shell
      me={me}
      route={route}
      navigate={navigate}
      teacherUi={teacherUi}
      studentView={studentView}
      onToggleStudentView={onToggleStudentView}
    >
      <p>Page content</p>
    </Shell>,
    { queryClient },
  );
  return { navigate, onToggleStudentView };
}

/** The sidebar of the desktop layout (the drawer renders the same nav). */
const sidebar = () => screen.getAllByRole("navigation")[0]!;

describe("Shell sidebar", () => {
  it("shows the teacher navigation and the classrooms of the query", () => {
    renderShell();
    const nav = within(sidebar());
    expect(nav.getByRole("button", { name: "Classrooms" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(nav.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(nav.getByRole("button", { name: "Classroom 1" })).toBeInTheDocument();
    expect(nav.getByRole("button", { name: "Classroom 3" })).toBeInTheDocument();
  });

  it("keeps Administration out of a plain teacher's navigation", () => {
    renderShell();
    expect(within(sidebar()).queryByRole("button", { name: "Administration" })).toBeNull();
  });

  it("offers Administration to an admin", () => {
    renderShell({ me: makeMe({ role: "admin" }) });
    expect(
      within(sidebar()).getByRole("button", { name: "Administration" }),
    ).toBeInTheDocument();
  });

  it("marks the classroom being read with aria-current", () => {
    renderShell({ route: { view: "classroom", id: "c2" } });
    const nav = within(sidebar());
    expect(nav.getByRole("button", { name: "Classroom 2" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(nav.getByRole("button", { name: "Classroom 1" })).not.toHaveAttribute("aria-current");
    // The classroom page is not the home page.
    expect(nav.getByRole("button", { name: "Classrooms" })).not.toHaveAttribute("aria-current");
  });

  it("navigates when a classroom is picked", async () => {
    const { navigate } = renderShell();
    await userEvent.click(within(sidebar()).getByRole("button", { name: "Classroom 2" }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "c2" });
  });

  it("caps the list at twelve and unfolds it on Show all", async () => {
    renderShell({ classrooms: rooms(15) });
    const nav = within(sidebar());
    expect(nav.getByRole("button", { name: "Classroom 12" })).toBeInTheDocument();
    expect(nav.queryByRole("button", { name: "Classroom 13" })).toBeNull();
    await userEvent.click(nav.getByRole("button", { name: "Show all (15)" }));
    expect(nav.getByRole("button", { name: "Classroom 15" })).toBeInTheDocument();
    expect(nav.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("keeps the classroom being read visible past the cap", () => {
    renderShell({ classrooms: rooms(30), route: { view: "classroom", id: "c25" } });
    const nav = within(sidebar());
    expect(nav.getByRole("button", { name: "Classroom 25" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(nav.queryByRole("button", { name: "Classroom 24" })).toBeNull();
  });

  it("shows the student navigation, with no classroom list, outside the teacher UI", () => {
    renderShell({ teacherUi: false, me: makeMe({ role: "student" }) });
    const nav = within(sidebar());
    // "My classrooms" is the student heading; the teacher sections are gone.
    expect(nav.getByRole("button", { name: "My classrooms" })).toBeInTheDocument();
    expect(nav.queryByRole("button", { name: "Classroom 1" })).toBeNull();
  });
});

describe("Shell mobile drawer", () => {
  it("opens and closes from the top bar, as a modal dialog", async () => {
    renderShell();
    const open = screen.getByRole("button", { name: "Open menu" });
    expect(open).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(open);
    const drawer = screen.getByRole("dialog");
    expect(drawer).toHaveAttribute("aria-modal", "true");
    expect(drawer).toHaveAccessibleName("HEIG Classroom");
    expect(within(drawer).getByRole("button", { name: "Classroom 1" })).toBeInTheDocument();

    await userEvent.click(within(drawer).getByRole("button", { name: "Close menu" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape and after a navigation", async () => {
    const { navigate } = renderShell();
    await userEvent.click(screen.getByRole("button", { name: "Open menu" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Open menu" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Classroom 2" }),
    );
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "c2" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Shell student view banner", () => {
  it("stays out of the way while the teacher UI is on", () => {
    renderShell();
    expect(screen.queryByText(/viewing the portal as a student/)).toBeNull();
  });

  it("says the teacher is in the student view and offers the way back", async () => {
    const { onToggleStudentView } = renderShell({ studentView: true, teacherUi: false });
    expect(screen.getByText("You are viewing the portal as a student.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back to teacher view" }));
    expect(onToggleStudentView).toHaveBeenCalledTimes(1);
  });
});
