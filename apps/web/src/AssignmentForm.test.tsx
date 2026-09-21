import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Assignment, Me, OrgRepo, RepoTree } from "@hgc/contracts";

import { AssignmentForm } from "./AssignmentForm";
import { DAY, at, makeAssignment, makeMe } from "./test/fixtures";
import { mockFetch, ok, renderWithProviders } from "./test/render";

/*
 * The assignment creation sheet. Three things are worth a test: the guard on
 * the submit button (a half-filled assignment must not reach the server), the
 * controls that appear and disappear with the publication mode, and the exact
 * payload of the manual + duration case, which is the one where the form
 * deliberately sends no date at all.
 */

const BASE = "/app/api/classrooms/c1";
const REPO = "labo-02-quadratic";

const repos: OrgRepo[] = [{ name: REPO, defaultBranch: "main" }];

const tree: RepoTree = {
  name: REPO,
  defaultBranch: "main",
  branches: ["main"],
  headSha: "a".repeat(40),
  headDate: at(-DAY),
  tree: [
    { path: "README.md", type: "blob" },
    { path: "criteria.yml", type: "blob" },
  ],
  truncated: false,
  suggestedProtected: ["criteria.yml"],
};

const renderForm = ({
  onDone = vi.fn(),
  me = makeMe(),
  existing,
}: {
  onDone?: ReturnType<typeof vi.fn>;
  /** Session: the online work modes only show up with the grant. */
  me?: Me;
  /** Edit instead of create. */
  existing?: Assignment;
} = {}) => {
  const stub = mockFetch({
    "GET /app/api/me": ok(me),
    [`GET ${BASE}/org-repos`]: ok(repos),
    [`GET ${BASE}/org-repos/${REPO}/tree`]: ok(tree),
    [`POST ${BASE}/assignments`]: ok(makeAssignment()),
    [`PATCH ${BASE}/assignments/a1`]: ok(makeAssignment()),
  });
  renderWithProviders(
    <AssignmentForm classroomId="c1" existing={existing} onDone={onDone} />,
    { route: "/classrooms/c1" },
  );
  return { ...stub, onDone };
};

const submitButton = () => screen.getByRole("button", { name: "Create assignment" });

/** Picks the source repository and waits for its tree to land. */
const pickSource = async () => {
  await screen.findByRole("option", { name: REPO });
  await userEvent.selectOptions(screen.getByLabelText("Source repository"), REPO);
  // The tree query fills the protected files and the branch.
  await screen.findByText(/2 files · 1 protected/);
};

/** First calendar cell for that day number (two months are rendered). */
const pickDay = async (day: string) => {
  const cells = screen.getAllByRole("button", { name: day });
  await userEvent.click(cells[0]!);
};

describe("AssignmentForm guard", () => {
  it("refuses to submit until a source repository and a deadline are both set", async () => {
    renderForm();
    await screen.findByRole("option", { name: REPO });
    expect(submitButton()).toBeDisabled();

    await pickSource();
    // A source alone is not enough: there is still no deadline.
    expect(submitButton()).toBeDisabled();
    expect(screen.getByText("Pick the deadline day in the calendar.")).toBeVisible();

    await pickDay("15");
    expect(submitButton()).toBeEnabled();
  });

  it("names the assignment after the repository, and keeps the name editable", async () => {
    renderForm();
    await pickSource();
    const name = screen.getByLabelText("Name");
    expect(name).toHaveValue("Labo 02 Quadratic");
    await userEvent.clear(name);
    await userEvent.type(name, "Lab 1 — Pointers");
    expect(name).toHaveValue("Lab 1 — Pointers");
  });

  it("refuses a duration under a quarter of an hour", async () => {
    renderForm();
    await pickSource();
    await userEvent.click(screen.getByRole("radio", { name: "Duration" }));
    const days = screen.getByLabelText("Days");
    await userEvent.clear(days);
    await userEvent.type(days, "0");
    expect(screen.getByText("At least 15 minutes")).toBeVisible();
    expect(submitButton()).toBeDisabled();
  });
});

describe("AssignmentForm publication mode", () => {
  it("shows the deadline shape only while the publication is manual", async () => {
    renderForm();
    await pickSource();
    // Manual is the default: the teacher chooses between a date and a duration,
    // and the calendar picks a deadline only (the start is the Publish click).
    expect(screen.getByRole("radio", { name: "Fixed date" })).toBeChecked();
    expect(screen.getByText("When you press Publish")).toBeVisible();
    expect(screen.queryByLabelText("Start time (auto-publish)")).toBeNull();

    await userEvent.click(screen.getByRole("radio", { name: "On a date" }));
    // Scheduled: no deadline shape to choose, and the range gains a start.
    expect(screen.queryByRole("radio", { name: "Fixed date" })).toBeNull();
    expect(screen.getByText("At the start date, automatically")).toBeVisible();
    expect(screen.getByLabelText("Start time (auto-publish)")).toBeInTheDocument();
  });

  it("replaces the calendar with days and hours when the deadline is a duration", async () => {
    renderForm();
    await pickSource();
    expect(screen.getByLabelText("Deadline time")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: "Duration" }));
    expect(screen.getByLabelText("Days")).toHaveValue(7);
    expect(screen.getByLabelText("Hours")).toHaveValue(0);
    expect(screen.queryByLabelText("Deadline time")).toBeNull();
    expect(screen.getByText("→ due 7 d after you publish")).toBeVisible();
  });
});

describe("AssignmentForm submission", () => {
  it("posts a duration and no date at all in the manual + duration case", async () => {
    const { calls, onDone } = renderForm();
    await pickSource();
    await userEvent.click(screen.getByRole("radio", { name: "Duration" }));
    expect(submitButton()).toBeEnabled();
    await userEvent.click(submitButton());

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const post = calls.find((c) => c.method === "POST" && c.url === `${BASE}/assignments`);
    expect(post?.body).toEqual({
      name: "Labo 02 Quadratic",
      sourceRepo: REPO,
      publishMode: "manual",
      // Seven days, counted from the moment the teacher publishes: no startAt
      // and no deadlineAt are sent at all.
      durationMinutes: 7 * 24 * 60,
      sourceStrategy: "squash",
      deadlineStrategy: "lock",
      gradingMode: "auto",
      branches: ["main"],
      protectedFiles: ["criteria.yml"],
      groupMode: false,
      groupMaxSize: null,
    });
  });

  it("posts absolute dates when the publication is scheduled", async () => {
    const { calls, onDone } = renderForm();
    await pickSource();
    await userEvent.click(screen.getByRole("radio", { name: "On a date" }));
    // The range calendar takes the start first, then the deadline.
    await pickDay("10");
    await pickDay("20");
    expect(submitButton()).toBeEnabled();
    await userEvent.click(submitButton());

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const post = calls.find((c) => c.method === "POST" && c.url === `${BASE}/assignments`);
    const body = post?.body as Record<string, unknown>;
    expect(body.publishMode).toBe("scheduled");
    expect(body).not.toHaveProperty("durationMinutes");
    expect(String(body.startAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(String(body.deadlineAt) > String(body.startAt)).toBe(true);
  });

  it("sends no work-mode field for a teacher without the online grant", async () => {
    const { calls, onDone } = renderForm();
    await pickSource();
    await userEvent.click(screen.getByRole("radio", { name: "Duration" }));
    await userEvent.click(submitButton());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const post = calls.find((c) => c.method === "POST" && c.url === `${BASE}/assignments`);
    expect(post?.body).not.toHaveProperty("workMode");
    // The choice itself is not even offered: the Work mode section is still
    // there, because group work lives in it and every teacher has that one.
    expect(screen.queryByText("Students work")).toBeNull();
    expect(screen.getByRole("switch", { name: "Group work" })).toBeVisible();
  });
});

/*
 * Group work (issue #2). The two rules the form has to keep: it belongs to
 * the free work mode only, and it is frozen once the assignment is live.
 */
describe("AssignmentForm group work", () => {
  it("sends the switch and the size hint", async () => {
    const { calls, onDone } = renderForm();
    await pickSource();
    await userEvent.click(screen.getByRole("radio", { name: "Duration" }));
    await userEvent.click(screen.getByRole("switch", { name: "Group work" }));
    await userEvent.type(screen.getByLabelText("Max group size"), "3");
    await userEvent.click(submitButton());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const post = calls.find((c) => c.method === "POST" && c.url === `${BASE}/assignments`);
    expect(post?.body).toMatchObject({ groupMode: true, groupMaxSize: 3 });
  });

  it("hides the switch in the online work mode and sends it off", async () => {
    const { calls, onDone } = renderForm({
      me: makeMe({ codespace: { enabled: true, maxActiveSessions: 20 } }),
    });
    await pickSource();
    await userEvent.click(screen.getByRole("radio", { name: "Duration" }));
    await userEvent.click(screen.getByRole("switch", { name: "Group work" }));
    // Going online takes the whole row away — and the flag with it.
    await userEvent.click(screen.getByRole("radio", { name: "Online" }));
    expect(screen.queryByRole("switch", { name: "Group work" })).toBeNull();
    await userEvent.click(submitButton());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const post = calls.find((c) => c.method === "POST" && c.url === `${BASE}/assignments`);
    expect(post?.body).toMatchObject({ workMode: "online", groupMode: false });
  });

  it("stops blocking Save once the size field is off screen", async () => {
    renderForm();
    await pickSource();
    await userEvent.click(screen.getByRole("radio", { name: "Duration" }));
    await userEvent.click(screen.getByRole("switch", { name: "Group work" }));
    await userEvent.type(screen.getByLabelText("Max group size"), "99");
    expect(submitButton()).toBeDisabled();
    // Group work off takes the field away: nothing on screen could explain a
    // disabled Save any more, and the value is not sent either.
    await userEvent.click(screen.getByRole("switch", { name: "Group work" }));
    expect(screen.queryByLabelText("Max group size")).toBeNull();
    expect(submitButton()).toBeEnabled();
  });

  it("freezes the switch on a published assignment", async () => {
    renderForm({
      existing: makeAssignment({ state: "published", groupMode: true, groupMaxSize: 2 }),
    });
    const toggle = await screen.findByRole("switch", { name: "Group work" });
    expect(toggle).toBeDisabled();
    expect(screen.getByText("Fixed at publication — the repositories already exist")).toBeVisible();
    // The advisory size stays editable: it blocks nothing on the server.
    expect(screen.getByLabelText("Max group size")).toBeEnabled();
  });
});
