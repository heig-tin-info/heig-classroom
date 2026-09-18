import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AssignmentDetail } from "./AssignmentDetail";
import {
  at,
  makeAssignmentDetail,
  makeClassroomDetail,
  makeDetailRepo,
  makeDetailStudent,
  makeGrade,
} from "./test/fixtures";
import { fail, mockFetch, noContent, ok, renderWithProviders } from "./test/render";

/*
 * The assignment page: the figures at the top must be the payload's own, the
 * search must narrow the table, and the two per-row actions must hit the
 * endpoint (and the verb) the server expects: those are POSTs nobody wants
 * to discover wrong in production.
 */

const BASE = "/app/api/classrooms/c1";
const ASSIGNMENT = `${BASE}/assignments/a1`;

const students = [
  makeDetailStudent({
    enrollmentId: "e-1",
    nom: "Rochat",
    prenom: "Lucas",
    repo: makeDetailRepo({ id: "r-1", ciStatus: "pass", grade: makeGrade({ points: 5 }) }),
  }),
  makeDetailStudent({
    enrollmentId: "e-2",
    nom: "Favre",
    prenom: "Emma",
    githubLogin: "emma-favre",
    repo: makeDetailRepo({ id: "r-2", ciStatus: "fail", grade: makeGrade({ points: 3 }) }),
  }),
  // Never accepted: no repository at all.
  makeDetailStudent({
    enrollmentId: "e-3",
    nom: "Bovet",
    prenom: "Noah",
    claimStatus: "pending",
    githubLogin: null,
    repo: null,
  }),
];

const routes = (
  overrides: Parameters<typeof mockFetch>[0] = {},
): Parameters<typeof mockFetch>[0] => ({
  [`GET ${BASE}`]: ok(makeClassroomDetail()),
  [`GET ${ASSIGNMENT}/detail`]: ok(makeAssignmentDetail({}, students)),
  [`GET ${ASSIGNMENT}/milestones`]: ok([]),
  ...overrides,
});

const renderDetail = (overrides: Parameters<typeof mockFetch>[0] = {}) => {
  const stub = mockFetch(routes(overrides));
  renderWithProviders(
    <AssignmentDetail classroomId="c1" assignmentId="a1" navigate={vi.fn()} />,
    { route: "/classrooms/c1/assignments/a1" },
  );
  return stub;
};

/**
 * The row of one student. The identity cell holds "<first> <last>" plus a
 * couple of icons, so it is matched on the row's text rather than on a text
 * node, which the icons would split.
 */
const rowOf = async (name: string) => {
  await screen.findByRole("table");
  const row = screen
    .getAllByRole("row")
    .find((r) => (r.textContent ?? "").includes(name));
  expect(row, `no row for ${name}`).toBeDefined();
  return within(row!);
};

/** The student rows, header excluded. */
const bodyRows = () => screen.getAllByRole("row").slice(1);

describe("AssignmentDetail stats", () => {
  it("counts what the payload says, not what the table shows", async () => {
    renderDetail();
    expect(await screen.findByText("Accepted")).toBeVisible();
    // Two of the three students have a provisioned repository.
    expect(screen.getByText("2 / 3")).toBeVisible();
    // One of those two passes the CI.
    expect(screen.getByText("1 / 2")).toBeVisible();
    // (5 + 3) / 2, rounded to one decimal.
    expect(screen.getByText("4.0")).toBeVisible();
    expect(screen.getByText("2 claimed their seat")).toBeVisible();
    expect(screen.getByText(/2 graded/)).toBeVisible();
  });

  it("hides every grade figure when the assignment is not graded", async () => {
    renderDetail({
      [`GET ${ASSIGNMENT}/detail`]: ok(makeAssignmentDetail({ gradingMode: "none" }, students)),
    });
    expect(await screen.findByText("Accepted")).toBeVisible();
    expect(screen.queryByText("Average grade")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: /Grade/ })).toBeNull();
  });
});

describe("AssignmentDetail table", () => {
  it("lists one row per student and says how many are shown", async () => {
    renderDetail();
    await screen.findByRole("table");
    expect(bodyRows()).toHaveLength(3);
    expect(screen.getByText("3 students")).toBeVisible();
  });

  it("filters on the search, by name or by GitHub login", async () => {
    renderDetail();
    await screen.findByRole("table");
    const search = screen.getByRole("searchbox", { name: "Search students…" });
    await userEvent.type(search, "emma-fav");
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0]!.textContent).toContain("Emma Favre");
    expect(screen.getByText("1 of 3 students")).toBeVisible();
  });

  it("explains a search that matches no student", async () => {
    renderDetail();
    await screen.findByRole("table");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search students…" }), "zzz");
    expect(screen.getByText("No student matches")).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says the classroom is empty rather than showing an empty table", async () => {
    renderDetail({ [`GET ${ASSIGNMENT}/detail`]: ok(makeAssignmentDetail({}, [])) });
    expect(await screen.findByText("No students in this classroom")).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("AssignmentDetail row actions", () => {
  it("locks a repository through its own endpoint", async () => {
    const { calls } = renderDetail({
      [`POST ${ASSIGNMENT}/repos/r-1/lock`]: noContent(),
    });
    const row = await rowOf("Lucas Rochat");
    await userEvent.click(row.getByRole("button", { name: "Lock repository (block pushes)" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: `${ASSIGNMENT}/repos/r-1/lock`,
        method: "POST",
        body: null,
      }),
    );
  });

  it("unlocks the repository that is locked, through the other endpoint", async () => {
    const { calls } = renderDetail({
      [`GET ${ASSIGNMENT}/detail`]: ok(
        makeAssignmentDetail({}, [
          makeDetailStudent({
            nom: "Rochat",
            repo: makeDetailRepo({ id: "r-1", lockedAt: at(-1000) }),
          }),
        ]),
      ),
      [`POST ${ASSIGNMENT}/repos/r-1/unlock`]: noContent(),
    });
    const row = await rowOf("Lucas Rochat");
    await userEvent.click(
      row.getByRole("button", { name: "Unlock repository (allow pushes again)" }),
    );
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: `${ASSIGNMENT}/repos/r-1/unlock`,
        method: "POST",
        body: null,
      }),
    );
  });

  it("starts a grading run on demand", async () => {
    const { calls } = renderDetail({
      [`POST ${ASSIGNMENT}/repos/r-2/grade-now`]: noContent(),
    });
    const row = await rowOf("Emma Favre");
    await userEvent.click(row.getByRole("button", { name: /Grade now/ }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: `${ASSIGNMENT}/repos/r-2/grade-now`,
        method: "POST",
        body: null,
      }),
    );
  });

  it("gives a student with no repository no row action at all", async () => {
    renderDetail();
    const row = await rowOf("Noah Bovet");
    expect(row.queryByRole("button", { name: /Lock repository/ })).toBeNull();
    expect(row.queryByRole("button", { name: /Grade now/ })).toBeNull();
  });

  it("links the repository of an accepted student to GitHub", async () => {
    renderDetail();
    const row = await rowOf("Lucas Rochat");
    expect(
      row.getByRole("link", {
        name: "Open heig-prg1-2026/labo-02-quadratic-lucas on GitHub",
      }),
    ).toHaveAttribute("href", "https://github.com/heig-prg1-2026/labo-02-quadratic-lucas");
  });
});

describe("AssignmentDetail validation", () => {
  it("offers no validation before the grades are frozen", async () => {
    renderDetail();
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: /Validate grades/ })).toBeNull();
  });

  it("asks before validating, then posts it", async () => {
    const { calls } = renderDetail({
      [`GET ${ASSIGNMENT}/detail`]: ok(
        makeAssignmentDetail({ state: "locked", frozenAt: at(-1000) }, students),
      ),
      [`POST ${ASSIGNMENT}/validate-grades`]: noContent(),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Validate grades" }));
    const dialog = await screen.findByRole("dialog");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Validate grades" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: `${ASSIGNMENT}/validate-grades`,
        method: "POST",
        body: null,
      }),
    );
  });
});

describe("AssignmentDetail states", () => {
  it("offers a way back when the assignment does not exist", async () => {
    const navigate = vi.fn();
    mockFetch({
      [`GET ${BASE}`]: ok(makeClassroomDetail()),
      [`GET ${ASSIGNMENT}/detail`]: fail(404, { message: "not found" }),
    });
    renderWithProviders(
      <AssignmentDetail classroomId="c1" assignmentId="a1" navigate={navigate} />,
      { route: "/classrooms/c1/assignments/a1" },
    );
    expect(await screen.findByText("Assignment not found")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back to the classroom" }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "c1" });
  });

  it("shows the server's message when the load fails for another reason", async () => {
    mockFetch({
      [`GET ${BASE}`]: ok(makeClassroomDetail()),
      [`GET ${ASSIGNMENT}/detail`]: fail(502, { message: "GitHub timed out" }),
    });
    renderWithProviders(
      <AssignmentDetail classroomId="c1" assignmentId="a1" navigate={vi.fn()} />,
      { route: "/classrooms/c1/assignments/a1" },
    );
    expect(await screen.findByText("Could not load this assignment")).toBeVisible();
    expect(screen.getByText("GitHub timed out")).toBeVisible();
  });
});
