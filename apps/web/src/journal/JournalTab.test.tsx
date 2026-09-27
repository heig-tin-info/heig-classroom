/**
 * The manage surface of the journal (issue #45): the state a teacher reads
 * before touching anything, and the three actions that change what the
 * classroom points at.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JournalPayload } from "@hgc/contracts";

import { mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { JournalTab } from "./JournalTab";

afterEach(() => vi.restoreAllMocks());

const base = "/app/api/classrooms/c1/journal";

const attached = (over: Partial<JournalPayload> = {}): JournalPayload => ({
  classroomId: "c1",
  classroomName: "PRG1 2026",
  orgLogin: "heig-prg1",
  staff: true,
  appInstalled: true,
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
  nav: [
    { path: "010-intro.md", title: "Intro", pagePath: "010-intro.md", children: [] },
    { path: "020-draft.md", title: "Threads", pagePath: "020-draft.md", children: [] },
  ],
  homePath: "README.md",
  hiddenCount: 1,
  hiddenPaths: ["020-draft.md"],
  warningCount: 0,
  ...over,
});

const none = (): JournalPayload => ({
  classroomId: "c1",
  classroomName: "PRG1 2026",
  orgLogin: "heig-prg1",
  staff: true,
  journal: null,
  nav: [],
  homePath: null,
  proposedName: "prg1-2026-journal",
  appInstalled: true,
});

describe("with no journal", () => {
  it("offers one primary action and names the organization", async () => {
    mockFetch({ [`GET ${base}`]: ok(none()) });
    renderWithProviders(<JournalTab classroomId="c1" navigate={vi.fn()} />);
    expect(await screen.findByText("No journal yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create the journal/i })).toBeInTheDocument();
    expect(screen.getByText("heig-prg1")).toBeInTheDocument();
  });

  it("creates it under the proposed name", async () => {
    const fetchMock = mockFetch({
      [`GET ${base}`]: ok(none()),
      [`POST ${base}`]: ok({ id: "j1", fullName: "heig-prg1/prg1-2026-journal" }),
    });
    renderWithProviders(<JournalTab classroomId="c1" navigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /create the journal/i }));
    expect(await screen.findByLabelText("Repository name")).toHaveValue("prg1-2026-journal");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() =>
      expect(
        fetchMock.calls.some(
          (c) => c.method === "POST" && (c.body as { name?: string }).name === "prg1-2026-journal",
        ),
      ).toBe(true),
    );
  });

  it("offers the deterministic fallback when the name is taken", async () => {
    mockFetch({
      [`GET ${base}`]: ok(none()),
      [`POST ${base}`]: {
        status: 409,
        body: {
          error: "name_taken",
          message: "heig-prg1/prg1-2026-journal already exists",
          suggestion: "prg1-2026-journal-0f1e2d3c",
        },
      },
    });
    renderWithProviders(<JournalTab classroomId="c1" navigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /create the journal/i }));
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await userEvent.click(
      await screen.findByRole("button", { name: /use prg1-2026-journal-0f1e2d3c/i }),
    );
    expect(screen.getByLabelText("Repository name")).toHaveValue("prg1-2026-journal-0f1e2d3c");
  });

  it("refuses to install what is not there", async () => {
    mockFetch({ [`GET ${base}`]: ok({ ...none(), appInstalled: false }) });
    renderWithProviders(<JournalTab classroomId="c1" navigate={vi.fn()} />);
    expect(await screen.findByText("The GitHub App is not installed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create the journal/i })).toBeDisabled();
  });
});

describe("with a journal", () => {
  it("shows its state and lists its pages in reading order", async () => {
    mockFetch({ [`GET ${base}`]: ok(attached()) });
    renderWithProviders(<JournalTab classroomId="c1" navigate={vi.fn()} />);
    expect(await screen.findByText("In sync")).toBeInTheDocument();
    expect(screen.getByText("heig-prg1/prg1-journal")).toBeInTheDocument();
    expect(screen.getByText("Front page")).toBeInTheDocument();
    expect(screen.getByText("Intro")).toBeInTheDocument();
  });

  it("marks the page the students do not see", async () => {
    mockFetch({ [`GET ${base}`]: ok(attached()) });
    renderWithProviders(<JournalTab classroomId="c1" navigate={vi.fn()} />);
    expect(await screen.findByText("hidden")).toBeInTheDocument();
    expect(screen.getByText("1 hidden")).toBeInTheDocument();
  });

  it("opens a page on the journal route", async () => {
    const navigate = vi.fn();
    mockFetch({ [`GET ${base}`]: ok(attached()) });
    renderWithProviders(<JournalTab classroomId="c1" navigate={navigate} />);
    await userEvent.click(await screen.findByText("Intro"));
    expect(navigate).toHaveBeenCalledWith({
      view: "journal",
      classroomId: "c1",
      pagePath: "010-intro.md",
    });
  });

  it("reports what GitHub refused on the last read", async () => {
    mockFetch({
      [`GET ${base}`]: ok(
        attached({
          journal: {
            ...attached().journal!,
            syncStatus: "error",
            syncError: "heig-prg1/prg1-journal has no commit on main",
          },
        }),
      ),
    });
    renderWithProviders(<JournalTab classroomId="c1" navigate={vi.fn()} />);
    expect(await screen.findByText("The last read from GitHub failed")).toBeInTheDocument();
    expect(
      screen.getByText("heig-prg1/prg1-journal has no commit on main"),
    ).toBeInTheDocument();
  });

  it("detaches only after a confirmation, and says the repository is untouched", async () => {
    const fetchMock = mockFetch({
      [`GET ${base}`]: ok(attached()),
      [`DELETE ${base}`]: noContent(),
    });
    renderWithProviders(<JournalTab classroomId="c1" navigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /journal actions/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /detach the journal/i }));
    expect(await screen.findByText("Detach the journal?")).toBeInTheDocument();
    expect(fetchMock.calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: /^detach$/i }));
    await waitFor(() => expect(fetchMock.calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("proposes the next file name in steps of ten", async () => {
    mockFetch({
      [`GET ${base}`]: ok(attached()),
      [`POST ${base}/pages`]: ok({ path: "030-threads.md" }),
    });
    renderWithProviders(<JournalTab classroomId="c1" navigate={vi.fn()} />);
    await userEvent.click((await screen.findAllByRole("button", { name: /add a page/i }))[0]!);
    await userEvent.type(await screen.findByLabelText("Title"), "Threads");
    expect(screen.getByLabelText("File")).toHaveAttribute("placeholder", "030-threads.md");
  });
});
