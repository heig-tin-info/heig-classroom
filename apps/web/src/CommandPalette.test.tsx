import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ClassroomSummary } from "@hgc/contracts";

import { CommandPalette } from "./CommandPalette";
import type { CommandContext } from "./commands";
import { useI18n, type Locale } from "./i18n";
import { makeClassroomSummary, makeMe } from "./test/fixtures";
import { renderWithProviders } from "./test/render";

/*
 * Ctrl/⌘+K. The palette never moves the focus off its own input: the rows are
 * selected through `aria-activedescendant`, which is the only thing telling a
 * screen reader what Enter is about to run. Most of what follows is that
 * contract, plus the two ways out (Escape, the backdrop) and the French
 * strings — a suite that only ever reads English cannot catch a missing `fr`.
 *
 * `commands.test.ts` owns which command exists for which viewer; here the
 * registry is only the material the keyboard walks.
 */

const rooms = (n: number): ClassroomSummary[] =>
  Array.from({ length: n }, (_, i) =>
    makeClassroomSummary({ id: `c${i + 1}`, name: `Classroom ${i + 1}`, orgLogin: `org-${i + 1}` }),
  );

const TOPICS = [
  { topic: "roster", title: "Roster" },
  { topic: "timeline", title: "Timeline" },
];

type ContextOverrides = Partial<Omit<CommandContext, "t" | "locale" | "setLocale">>;

/**
 * Renders the palette the way the Shell does — mounted only while open, `t`
 * and the locale straight from the provider — behind a trigger button, so the
 * focus has somewhere to come back to.
 *
 * With the defaults the list holds 13 commands in three groups: Navigation
 * (home, settings, three classrooms), Actions (theme, language, student view,
 * sign out) and Help (two external links, two topics).
 */
function renderPalette(
  options: {
    /** The `open` prop; false keeps the component mounted and rendering nothing. */
    open?: boolean;
    /** Start with the palette closed, to assert what opening it does. */
    startClosed?: boolean;
    locale?: Locale;
  } & ContextOverrides = {},
) {
  const { open = true, startClosed = false, locale = "en", ...ctx } = options;
  // `onClose` is deliberately not part of the spread below: the harness has to
  // wrap it to unmount the palette, the way the Shell does.
  const onClose = vi.fn();
  const spies = {
    navigate: vi.fn(),
    setThemeChoice: vi.fn(),
    openHelp: vi.fn(),
    signOut: vi.fn(),
    onToggleStudentView: vi.fn(),
  };

  function Harness() {
    const [mounted, setMounted] = useState(!startClosed);
    const i18n = useI18n();
    return (
      <>
        <button type="button" onClick={() => setMounted(true)}>
          Open palette
        </button>
        {mounted ? (
          <CommandPalette
            open={open}
            onClose={() => {
              setMounted(false);
              onClose();
            }}
            t={i18n.t}
            locale={i18n.locale}
            setLocale={i18n.setLocale}
            route={{ view: "home" }}
            me={makeMe()}
            teacherUi
            studentView={false}
            classrooms={rooms(3)}
            themeChoice="system"
            resolvedTheme="light"
            helpTopics={TOPICS}
            {...spies}
            {...ctx}
          />
        ) : null}
      </>
    );
  }

  return { ...renderWithProviders(<Harness />, { locale }), onClose, ...spies };
}

const combobox = () => screen.getByRole("combobox");
const options = () => screen.queryAllByRole("option");
/** The one row `aria-selected`; fails loudly if the palette ever selects two. */
function selectedOption(): HTMLElement {
  const marked = options().filter((o) => o.getAttribute("aria-selected") === "true");
  expect(marked).toHaveLength(1);
  return marked[0]!;
}
const groupNamed = (name: string) => screen.getByRole("group", { name });
/**
 * The polite live region. It carries no role of its own — an `aria-live` node
 * is not a landmark — so it is found by the attribute, scoped to the panel
 * because the toast host renders one too.
 */
const liveRegion = () =>
  screen.getByRole("dialog").querySelector<HTMLElement>('[aria-live="polite"]')!;

describe("CommandPalette", () => {
  it("renders nothing at all while it is closed", () => {
    renderPalette({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(options()).toHaveLength(0);
  });

  it("is a modal dialog with a name of its own", () => {
    renderPalette();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Command palette");
  });

  it("wires the input to the list it drives", () => {
    renderPalette();
    const input = combobox();
    const list = screen.getByRole("listbox");
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(list.id).not.toBe("");
    expect(input).toHaveAttribute("aria-controls", list.id);
    expect(list).toContainElement(options()[0]!);
  });

  it("selects exactly one row and names it in aria-activedescendant", async () => {
    const user = userEvent.setup();
    renderPalette();
    expect(combobox()).toHaveAttribute("aria-activedescendant", selectedOption().id);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(combobox()).toHaveAttribute("aria-activedescendant", selectedOption().id);
  });

  it("labels every group by the heading the reader sees", () => {
    renderPalette();
    const groups = screen.getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("aria-labelledby"))).not.toContain(null);
    for (const [group, heading] of groups.map(
      (g) => [g, document.getElementById(g.getAttribute("aria-labelledby")!)] as const,
    )) {
      expect(heading).not.toBeNull();
      expect(group).toHaveAccessibleName(heading!.textContent!);
    }
    expect(groupNamed("Navigation")).toBeInTheDocument();
    expect(groupNamed("Actions")).toBeInTheDocument();
    expect(groupNamed("Help")).toBeInTheDocument();
  });

  it("starts on the first row of the first group", () => {
    renderPalette();
    expect(selectedOption()).toBe(options()[0]);
    expect(groupNamed("Navigation")).toContainElement(selectedOption());
  });
});

describe("CommandPalette keyboard", () => {
  it("keeps the caret in the search field while the arrows walk the list", async () => {
    const user = userEvent.setup();
    renderPalette();
    const input = combobox();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(input);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(document.activeElement).toBe(input);
  });

  it("moves the selection down and back up", async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard("{ArrowDown}");
    expect(selectedOption()).toBe(options()[1]);
    await user.keyboard("{ArrowDown}");
    expect(selectedOption()).toBe(options()[2]);
    await user.keyboard("{ArrowUp}");
    expect(selectedOption()).toBe(options()[1]);
  });

  it("wraps at both ends, across the group boundary", async () => {
    const user = userEvent.setup();
    renderPalette();
    // Up from the first row lands on the last one, which belongs to another
    // group: the list wraps as one list, not group by group.
    await user.keyboard("{ArrowUp}");
    expect(selectedOption()).toBe(options().at(-1));
    expect(groupNamed("Help")).toContainElement(selectedOption());
    await user.keyboard("{ArrowDown}");
    expect(selectedOption()).toBe(options()[0]);
    expect(groupNamed("Navigation")).toContainElement(selectedOption());
  });

  it("jumps to the ends with Home and End", async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard("{End}");
    expect(selectedOption()).toBe(options().at(-1));
    await user.keyboard("{Home}");
    expect(selectedOption()).toBe(options()[0]);
  });

  it("runs the selected command once and closes", async () => {
    const user = userEvent.setup();
    const { navigate, onClose } = renderPalette();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({ view: "settings" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does nothing on Enter when nothing matches, and stays open", async () => {
    const user = userEvent.setup();
    const { navigate, onClose } = renderPalette();
    await user.type(combobox(), "qwxjvk");
    expect(options()).toHaveLength(0);
    await user.keyboard("{Enter}");
    expect(navigate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("CommandPalette filtering", () => {
  it("narrows the list to what was typed, including by organization login", async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.type(combobox(), "org-2");
    expect(options()).toHaveLength(1);
    expect(options()[0]).toHaveTextContent("Open classroom Classroom 2");
    expect(screen.queryByRole("group", { name: "Actions" })).toBeNull();
  });

  it("puts the selection back on the first row at every keystroke", async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.keyboard("{End}");
    expect(selectedOption()).not.toBe(options()[0]);
    await user.type(combobox(), "org");
    expect(selectedOption()).toBe(options()[0]);
    // Backspacing changes the list under the finger just as much as typing.
    await user.keyboard("{End}");
    await user.keyboard("{Backspace}");
    expect(selectedOption()).toBe(options()[0]);
  });

  it("says what it found nothing for", async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.type(combobox(), "qwxjvk");
    expect(screen.getByText("No result for “qwxjvk”")).toBeVisible();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("announces the count, in the singular when there is one", async () => {
    const user = userEvent.setup();
    renderPalette({ classrooms: rooms(2) });
    expect(liveRegion()).toHaveTextContent(`${options().length} results`);
    await user.type(combobox(), "org-");
    expect(options()).toHaveLength(2);
    expect(liveRegion()).toHaveTextContent("2 results");
    await user.type(combobox(), "2");
    expect(options()).toHaveLength(1);
    expect(liveRegion()).toHaveTextContent("1 result");
    await user.clear(combobox());
    await user.type(combobox(), "qwxjvk");
    expect(liveRegion()).toHaveTextContent("0 results");
  });
});

describe("CommandPalette mouse", () => {
  it("runs the row that was clicked", async () => {
    const user = userEvent.setup();
    const { navigate, onClose } = renderPalette();
    await user.click(screen.getByRole("option", { name: /Open classroom Classroom 2/ }));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "c2" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves the selection under the pointer", async () => {
    const user = userEvent.setup();
    renderPalette();
    const row = screen.getByRole("option", { name: /Sign out/ });
    expect(selectedOption()).not.toBe(row);
    await user.hover(row);
    expect(selectedOption()).toBe(row);
  });

  it("closes on the backdrop but not on the panel itself", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette();
    const dialog = screen.getByRole("dialog");
    // The panel is the dialog; the backdrop is the full-screen parent it
    // floats on (the same shape ui.test.tsx asserts for Modal).
    const backdrop = dialog.parentElement!;

    await user.click(within(dialog).getByRole("listbox"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("CommandPalette layer contract", () => {
  it("closes on Escape and gives the focus back to whatever opened it", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette({ startClosed: true });
    const trigger = screen.getByRole("button", { name: "Open palette" });
    await user.click(trigger);
    // The field takes the focus on open; nothing else in the palette ever does.
    expect(document.activeElement).toBe(combobox());

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    // The restore is deferred by one frame, on purpose (see `useLayer`).
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe("CommandPalette in French", () => {
  it("speaks French from the field to the empty state", async () => {
    const user = userEvent.setup();
    renderPalette({ locale: "fr" });
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Palette de commandes");
    expect(combobox()).toHaveAttribute(
      "placeholder",
      "Rechercher une classe, une action, de l'aide…",
    );
    expect(groupNamed("Aide")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Ouvrir la classe Classroom 1/ })).toBeVisible();
    expect(screen.getByRole("option", { name: /Passer en English/ })).toBeVisible();

    await user.type(combobox(), "qwxjvk");
    expect(screen.getByText("Aucun résultat pour « qwxjvk »")).toBeVisible();
    expect(liveRegion()).toHaveTextContent("0 résultats");
  });

  it("writes the footer hints as French sentences, preposition included", () => {
    renderPalette({ locale: "fr" });
    // "↑ ↓ naviguer" is telegraphic, not French: the English strip keeps its
    // "to move" and the French one owes the reader its "pour".
    const panel = screen.getByRole("dialog").textContent!;
    expect(panel).toContain("pour naviguer");
    // "lancer" is not how French names running a command.
    expect(panel).toContain("pour exécuter");
    expect(panel).toContain("pour fermer");
  });

  it("names the classroom tabs in French, without naming the students themselves", () => {
    renderPalette({ locale: "fr", route: { view: "classroom", id: "c2" } });
    expect(
      screen.getByRole("option", { name: "Ouvrir la liste des étudiants" }),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: "Ouvrir l'équipe enseignante" })).toBeVisible();
  });
});
