/**
 * The journal as the two audiences meet it (issue #45): what a student sees,
 * what the staff sees on top of it, and the one behaviour the rendered HTML
 * needs from React — a link between two pages must move the router and not
 * reload the app.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JournalPage as JournalPageData, JournalPayload } from "@hgc/contracts";

import { mockFetch, ok, renderWithProviders } from "../test/render";
import { JournalBody } from "./JournalBody";
import { JournalPage } from "./JournalPage";

afterEach(() => vi.restoreAllMocks());

const nav: JournalPayload["nav"] = [
  {
    path: "010-basics",
    title: "Basics",
    pagePath: "010-basics/README.md",
    children: [
      {
        path: "010-basics/020-pointers.md",
        title: "Pointers",
        pagePath: "010-basics/020-pointers.md",
        children: [],
      },
    ],
  },
  { path: "030-draft.md", title: "Threads", pagePath: "030-draft.md", children: [] },
];

const payload = (over: Partial<JournalPayload> = {}): JournalPayload => ({
  classroomId: "c1",
  classroomName: "PRG1 2026",
  orgLogin: "heig-prg1",
  staff: false,
  journal: {
    id: "j1",
    fullName: "heig-prg1/prg1-journal",
    ref: "main",
    htmlUrl: "https://github.com/heig-prg1/prg1-journal",
    cloneUrl: "git@github.com:heig-prg1/prg1-journal.git",
    syncStatus: "ok",
    syncError: null,
    lastSyncedAt: "2026-09-20T08:00:00.000Z",
    lastCommitSha: "abc",
    editable: true,
  },
  nav,
  homePath: "README.md",
  ...over,
});

const page = (over: Partial<JournalPageData> = {}): JournalPageData => ({
  path: "README.md",
  title: "The course",
  html: '<h1 id="the-course">The course</h1>\n<p>Welcome.</p>',
  toc: [{ id: "the-course", depth: 1, text: "The course" }],
  updatedAt: "2026-09-20T08:00:00.000Z",
  hidden: false,
  draft: false,
  visibleFrom: null,
  ...over,
});

const base = "/app/api/classrooms/c1/journal";

describe("JournalPage, as a student", () => {
  it("opens the front page when no page is named", async () => {
    mockFetch({
      [`GET ${base}`]: ok(payload()),
      [`GET ${base}/pages/README.md`]: ok(page()),
    });
    renderWithProviders(<JournalPage classroomId="c1" pagePath="" navigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "The course", level: 1 })).toBeInTheDocument();
  });

  it("shows no writing affordance at all", async () => {
    mockFetch({
      [`GET ${base}`]: ok(payload()),
      [`GET ${base}/pages/README.md`]: ok(page()),
    });
    renderWithProviders(<JournalPage classroomId="c1" pagePath="" navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "The course", level: 1 });
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /refresh/i })).not.toBeInTheDocument();
  });

  it("navigates within the journal when a navigation entry is clicked", async () => {
    const navigate = vi.fn();
    mockFetch({
      [`GET ${base}`]: ok(payload()),
      [`GET ${base}/pages/README.md`]: ok(page()),
    });
    renderWithProviders(<JournalPage classroomId="c1" pagePath="" navigate={navigate} />);
    await screen.findByRole("heading", { name: "The course", level: 1 });
    await userEvent.click(screen.getByRole("button", { name: "Pointers" }));
    expect(navigate).toHaveBeenCalledWith({
      view: "journal",
      classroomId: "c1",
      pagePath: "010-basics/020-pointers.md",
    });
  });

  it("names the classroom it belongs to", async () => {
    mockFetch({
      [`GET ${base}`]: ok(payload()),
      [`GET ${base}/pages/README.md`]: ok(page()),
    });
    renderWithProviders(<JournalPage classroomId="c1" pagePath="" navigate={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "PRG1 2026" })).toBeInTheDocument();
  });

  it("leaves the only 28 px title on the screen to the document itself", async () => {
    mockFetch({
      [`GET ${base}`]: ok(payload()),
      [`GET ${base}/pages/README.md`]: ok(page()),
    });
    renderWithProviders(<JournalPage classroomId="c1" pagePath="" navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "The course", level: 1 });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("says so, in the reader's language, when nothing is published", async () => {
    mockFetch({ [`GET ${base}`]: ok(payload({ nav: [], homePath: null })) });
    renderWithProviders(<JournalPage classroomId="c1" pagePath="" navigate={vi.fn()} />, {
      locale: "fr",
    });
    expect(await screen.findByText("Rien de publié pour l'instant")).toBeInTheDocument();
  });

  it("reports a page that does not exist without breaking the navigation", async () => {
    mockFetch({
      [`GET ${base}`]: ok(payload()),
      [`GET ${base}/pages/010-basics/030-gone.md`]: { status: 404, body: { error: "not_found" } },
    });
    renderWithProviders(
      <JournalPage classroomId="c1" pagePath="010-basics/030-gone.md" navigate={vi.fn()} />,
    );
    expect(await screen.findByText("This page does not exist")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pointers" })).toBeInTheDocument();
  });
});

describe("JournalPage, as staff", () => {
  const staffPayload = payload({
    staff: true,
    hiddenCount: 1,
    hiddenPaths: ["030-draft.md"],
    warningCount: 0,
  });

  it("offers Edit and Refresh", async () => {
    mockFetch({
      [`GET ${base}`]: ok(staffPayload),
      [`GET ${base}/pages/README.md`]: ok(page({ markdown: "# The course\n", blobSha: "s1" })),
    });
    renderWithProviders(<JournalPage classroomId="c1" pagePath="" navigate={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
  });

  it("opens the editor on the markdown source, and leaves on cancel", async () => {
    mockFetch({
      [`GET ${base}`]: ok(staffPayload),
      [`GET ${base}/pages/README.md`]: ok(page({ markdown: "# The course\n", blobSha: "s1" })),
    });
    renderWithProviders(<JournalPage classroomId="c1" pagePath="" navigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    const area = await screen.findByLabelText("Markdown source of README.md");
    expect(area).toHaveValue("# The course\n");
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByLabelText("Markdown source of README.md")).not.toBeInTheDocument();
  });

  it("marks a page the students do not see", async () => {
    mockFetch({
      [`GET ${base}`]: ok(staffPayload),
      [`GET ${base}/pages/030-draft.md`]: ok(
        page({ path: "030-draft.md", hidden: true, draft: true, markdown: "", blobSha: "s2" }),
      ),
    });
    renderWithProviders(
      <JournalPage classroomId="c1" pagePath="030-draft.md" navigate={vi.fn()} />,
    );
    expect(await screen.findByText("Not visible to students")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
  });

  it("shows the ingestion warnings of a page, which a student never sees", async () => {
    mockFetch({
      [`GET ${base}`]: ok(staffPayload),
      [`GET ${base}/pages/README.md`]: ok(
        page({ warnings: ["`p.svg` points at p.svg, which is not in the journal."] }),
      ),
    });
    renderWithProviders(<JournalPage classroomId="c1" pagePath="" navigate={vi.fn()} />);
    expect(await screen.findByText("This page has warnings")).toBeInTheDocument();
  });

  it("hides the writing affordances while a teacher looks through the student view", async () => {
    mockFetch({
      [`GET ${base}`]: ok(staffPayload),
      [`GET ${base}/pages/README.md`]: ok(page()),
    });
    renderWithProviders(
      <JournalPage classroomId="c1" pagePath="" navigate={vi.fn()} readOnly />,
    );
    await screen.findByRole("heading", { name: "The course", level: 1 });
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
  });

  it("saves the page with the blob sha it was opened at", async () => {
    const fetchMock = mockFetch({
      [`GET ${base}`]: ok(staffPayload),
      [`GET ${base}/pages/README.md`]: ok(page({ markdown: "# A\n", blobSha: "s1" })),
      [`PUT ${base}/pages/README.md`]: ok({ path: "README.md", blobSha: "s2" }),
    });
    renderWithProviders(<JournalPage classroomId="c1" pagePath="" navigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    const area = await screen.findByLabelText("Markdown source of README.md");
    await userEvent.type(area, "B");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(
        fetchMock.calls.some(
          (c) =>
            c.method === "PUT" &&
            (c.body as { baseSha?: string }).baseSha === "s1" &&
            typeof (c.body as { markdown?: string }).markdown === "string",
        ),
      ).toBe(true),
    );
  });

  it("keeps the draft and explains itself when GitHub refuses the write", async () => {
    mockFetch({
      [`GET ${base}`]: ok(staffPayload),
      [`GET ${base}/pages/README.md`]: ok(page({ markdown: "# A\n", blobSha: "s1" })),
      [`PUT ${base}/pages/README.md`]: {
        status: 409,
        body: { error: "conflict", message: "README.md changed on GitHub since it was opened" },
      },
    });
    renderWithProviders(<JournalPage classroomId="c1" pagePath="" navigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    await userEvent.type(await screen.findByLabelText("Markdown source of README.md"), "B");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(
      await screen.findByText("This page changed on GitHub since you opened it"),
    ).toBeInTheDocument();
    // The text is still on screen: nothing was lost and nothing was merged.
    expect(await screen.findByLabelText("Markdown source of README.md")).toHaveValue("# A\nB");
  });
});

describe("JournalBody", () => {
  it("routes a relative link between two pages instead of reloading", async () => {
    const navigate = vi.fn();
    renderWithProviders(
      <JournalBody
        html='<p><a href="../020-tooling/010-make.md">Make</a></p>'
        navigate={navigate}
      />,
      { route: "/classrooms/c1/journal/010-basics/020-pointers.md" },
    );
    await userEvent.click(screen.getByRole("link", { name: "Make" }));
    expect(navigate).toHaveBeenCalledWith({
      view: "journal",
      classroomId: "c1",
      pagePath: "020-tooling/010-make.md",
    });
  });

  it("leaves an external link and an in-page anchor to the browser", async () => {
    const navigate = vi.fn();
    renderWithProviders(
      <JournalBody
        html={
          '<p><a href="https://heig-vd.ch" target="_blank" rel="noreferrer">HEIG</a>' +
          '<a href="#the-stack">The stack</a></p>'
        }
        navigate={navigate}
      />,
      { route: "/classrooms/c1/journal/README.md" },
    );
    await userEvent.click(screen.getByRole("link", { name: "HEIG" }));
    await userEvent.click(screen.getByRole("link", { name: "The stack" }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("leaves an asset link alone: it is served by the API, not by the router", async () => {
    const navigate = vi.fn();
    renderWithProviders(
      <JournalBody
        html='<p><a href="/app/api/journals/j1/assets/handout.pdf">Handout</a></p>'
        navigate={navigate}
      />,
      { route: "/classrooms/c1/journal/README.md" },
    );
    await userEvent.click(screen.getByRole("link", { name: "Handout" }));
    expect(navigate).not.toHaveBeenCalled();
  });
});
