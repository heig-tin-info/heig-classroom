import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { StudentHome } from "./StudentHome";
import {
  DAY,
  at,
  makeMe,
  makeStudentAssignment,
  makeStudentClassroom,
  makeStudentRepo,
} from "./test/fixtures";
import { fail, mockFetch, noContent, ok, renderWithProviders } from "./test/render";

/*
 * The student landing page. `rowAffordances` already has its pure test in
 * StudentHome.test.ts; what is checked here is that the rendering follows it,
 * that "Up next" points at the right assignment and that a student without a
 * GitHub account is told what to do about it.
 */

const ROOMS = "/app/api/student/classrooms";

const renderStudent = (me = makeMe({ role: "student" })) =>
  renderWithProviders(<StudentHome me={me} />);

/** The "Up next" card: the only card carrying that eyebrow. */
const upNextCard = (): HTMLElement =>
  screen.getByText("Up next").closest(".rounded-card") as HTMLElement;

describe("StudentHome", () => {
  it("puts the nearest assignment to accept in the Up next card", async () => {
    mockFetch({
      [`GET ${ROOMS}`]: ok([
        makeStudentClassroom({
          assignments: [
            makeStudentAssignment({ id: "a1", name: "Far away", deadlineAt: at(9 * DAY), repo: null }),
            makeStudentAssignment({ id: "a2", name: "Due first", deadlineAt: at(2 * DAY), repo: null }),
            // Already closed: never "up next", however near it is.
            makeStudentAssignment({ id: "a3", name: "Last week", deadlineAt: at(-DAY) }),
          ],
        }),
      ]),
    });
    renderStudent();
    await screen.findByText("Up next");
    expect(within(upNextCard()).getByText("Due first")).toBeVisible();
    expect(within(upNextCard()).queryByText("Far away")).toBeNull();
    // The page header counts the assignments still open.
    expect(screen.getByText("2 open assignments")).toBeVisible();
  });

  it("shows no Up next card for an accepted assignment still far from its deadline", async () => {
    mockFetch({
      [`GET ${ROOMS}`]: ok([
        makeStudentClassroom({
          assignments: [makeStudentAssignment({ name: "Just accepted", deadlineAt: at(9 * DAY) })],
        }),
      ]),
    });
    renderStudent();
    // Only the row: the card would repeat it and ask for nothing.
    expect(await screen.findAllByText("Just accepted")).toHaveLength(1);
    expect(screen.queryByText("Up next")).toBeNull();
  });

  it("reminds an accepted assignment in the Up next card within 48 hours", async () => {
    mockFetch({
      [`GET ${ROOMS}`]: ok([
        makeStudentClassroom({
          assignments: [makeStudentAssignment({ name: "Due tomorrow", deadlineAt: at(DAY) })],
        }),
      ]),
    });
    renderStudent();
    await screen.findByText("Up next");
    expect(within(upNextCard()).getByText("Due tomorrow")).toBeVisible();
  });

  it("gives the free-mode row a link to the repository and no Start", async () => {
    mockFetch({
      [`GET ${ROOMS}`]: ok([
        makeStudentClassroom({
          assignments: [makeStudentAssignment({ workMode: "free" })],
        }),
      ]),
    });
    renderStudent();
    const row = within((await screen.findAllByRole("listitem"))[0]!);
    expect(row.getByRole("link", { name: /Open your repository/ })).toHaveAttribute(
      "href",
      "https://github.com/heig-prg1-2026/labo-02-quadratic-lucas",
    );
    expect(row.queryByRole("link", { name: "Start" })).toBeNull();
    expect(row.queryByText("Online workspace")).toBeNull();
    // The name itself links to the repository in free mode.
    expect(row.getByRole("link", { name: "Labo 02 quadratic" })).toBeInTheDocument();
  });

  it("gives the online row Start instead of the repository button", async () => {
    mockFetch({
      [`GET ${ROOMS}`]: ok([
        makeStudentClassroom({
          assignments: [makeStudentAssignment({ workMode: "online" })],
        }),
      ]),
    });
    renderStudent();
    const row = within((await screen.findAllByRole("listitem"))[0]!);
    expect(row.getByRole("link", { name: /Start/ })).toHaveAttribute(
      "href",
      "/app/codespace/start/a1",
    );
    expect(row.queryByRole("link", { name: /Open your repository/ })).toBeNull();
    expect(row.getByText("Online workspace")).toBeVisible();
    // Read-only access, so the name stays a discreet link.
    expect(row.getByRole("link", { name: "Labo 02 quadratic" })).toBeInTheDocument();
  });

  it("gives the exam row no repository access at all", async () => {
    mockFetch({
      [`GET ${ROOMS}`]: ok([
        makeStudentClassroom({
          assignments: [makeStudentAssignment({ workMode: "online_seb" })],
        }),
      ]),
    });
    renderStudent();
    const row = within((await screen.findAllByRole("listitem"))[0]!);
    expect(row.getByText("Exam workspace")).toBeVisible();
    expect(row.getByRole("link", { name: /Start/ })).toBeInTheDocument();
    expect(row.queryByRole("link", { name: "Labo 02 quadratic" })).toBeNull();
    expect(row.getByText("Labo 02 quadratic")).toBeVisible();
  });

  it("offers Accept while the repository does not exist, and posts it", async () => {
    const { calls } = mockFetch({
      [`GET ${ROOMS}`]: ok([
        makeStudentClassroom({ assignments: [makeStudentAssignment({ repo: null })] }),
      ]),
      "POST /app/api/student/assignments/a1/accept": noContent(),
    });
    renderStudent();
    const row = within((await screen.findAllByRole("listitem"))[0]!);
    await userEvent.click(row.getByRole("button", { name: "Accept assignment" }));
    expect(calls).toContainEqual({
      url: "/app/api/student/assignments/a1/accept",
      method: "POST",
      body: null,
    });
  });

  it("locks the row when the assignment is locked: no Start, no acceptance", async () => {
    mockFetch({
      [`GET ${ROOMS}`]: ok([
        makeStudentClassroom({
          assignments: [
            makeStudentAssignment({
              workMode: "online",
              state: "locked",
              repo: makeStudentRepo({ lockedAt: at(-1000) }),
            }),
          ],
        }),
      ]),
    });
    renderStudent();
    const row = within((await screen.findAllByRole("listitem"))[0]!);
    expect(row.getByText("locked")).toBeVisible();
    expect(row.queryByRole("link", { name: /Start/ })).toBeNull();
    // The mode note stays: the student still needs to know where the work lives.
    expect(row.getByText("Online workspace")).toBeVisible();
  });

  it("tells a student with no GitHub account what to do first", async () => {
    mockFetch({ [`GET ${ROOMS}`]: ok([makeStudentClassroom()]) });
    renderStudent(makeMe({ role: "student", githubLogin: null }));
    const alert = (
      await screen.findByText(/Link your GitHub account/)
    ).closest("[role='status']") as HTMLElement;
    expect(within(alert).getByRole("link", { name: /Link GitHub account/ })).toHaveAttribute(
      "href",
      "/app/auth/github/link",
    );
  });

  it("disables acceptance while the GitHub account is not linked", async () => {
    mockFetch({
      [`GET ${ROOMS}`]: ok([
        makeStudentClassroom({ assignments: [makeStudentAssignment({ repo: null })] }),
      ]),
    });
    renderStudent(makeMe({ role: "student", githubLogin: null }));
    const row = within((await screen.findAllByRole("listitem"))[0]!);
    expect(row.getByRole("button", { name: "Accept assignment" })).toBeDisabled();
  });

  it("filters the rows as the student searches", async () => {
    mockFetch({
      [`GET ${ROOMS}`]: ok([
        makeStudentClassroom({
          assignments: [
            makeStudentAssignment({ id: "a1", name: "Pointers", repo: null }),
            makeStudentAssignment({ id: "a2", name: "Quadratic" }),
          ],
        }),
      ]),
    });
    renderStudent();
    // Two mentions at first: the row, and the Up next card above it.
    expect(await screen.findAllByText("Pointers")).toHaveLength(2);
    await userEvent.type(screen.getByRole("searchbox", { name: "Search…" }), "quad");
    expect(screen.getByText("Quadratic")).toBeVisible();
    expect(screen.queryByText("Pointers")).toBeNull();
    // Searching puts the Up next card away: the reader is looking for something.
    expect(screen.queryByText("Up next")).toBeNull();
  });

  it("says the student is on no roster yet instead of showing an empty table", async () => {
    mockFetch({ [`GET ${ROOMS}`]: ok([]) });
    renderStudent();
    expect(await screen.findByText("No classrooms yet")).toBeVisible();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("shows the failed query with the student's own fallback wording", async () => {
    mockFetch({ [`GET ${ROOMS}`]: fail(500, null) });
    renderStudent();
    expect(await screen.findByText("Could not load your classrooms")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
