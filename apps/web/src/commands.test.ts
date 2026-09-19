// @vitest-environment jsdom
import { ClipboardList, School } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import {
  buildCommands,
  capClassrooms,
  filterCommands,
  groupCommands,
  CLASSROOM_COMMAND_PREFIX,
  EMPTY_QUERY_CLASSROOM_CAP,
  type Command,
  type CommandContext,
} from "./commands";
import { DICTS, type Locale, type TFunction } from "./i18n";
import type { Route } from "./router";
import { makeClassroomSummary, makeMe } from "./test/fixtures";

/*
 * The registry behind the command palette: which command exists for which
 * viewer, what it is called, and what it does when it runs. Nothing renders
 * here — the whole point of `buildCommands` being a function of an explicit
 * context is that the context can be written down.
 *
 * jsdom rather than the node environment of the other `*.test.ts` files, for
 * one reason: the classroom tab commands write the address bar and dispatch a
 * `popstate`, and a hand-stubbed `window` would only prove the test's own
 * stub right. Still no React and no rendering.
 */

/** The real dictionaries, so a missing `fr` string fails a test instead of falling back silently. */
function makeT(locale: Locale): TFunction {
  return (key, vars) => {
    const raw = DICTS[locale][key as string] ?? String(key);
    return vars ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : raw;
  };
}

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  const locale = overrides.locale ?? "en";
  return {
    t: makeT(locale),
    locale,
    setLocale: vi.fn(),
    route: { view: "home" },
    navigate: vi.fn(),
    me: makeMe(),
    teacherUi: true,
    studentView: false,
    onToggleStudentView: vi.fn(),
    classrooms: [makeClassroomSummary()],
    themeChoice: "system",
    resolvedTheme: "light",
    setThemeChoice: vi.fn(),
    openHelp: vi.fn(),
    helpTopics: [{ topic: "roster", title: "Roster" }],
    signOut: vi.fn(),
    ...overrides,
  };
}

const ids = (commands: Command[]) => commands.map((c) => c.id);
const pick = (commands: Command[], id: string) => commands.find((c) => c.id === id);
/** The command with that id, or a failing expectation naming it. */
function need(commands: Command[], id: string): Command {
  const command = pick(commands, id);
  expect(command, `no command with id "${id}" (got ${ids(commands).join(", ")})`).toBeDefined();
  return command!;
}

const rooms = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    makeClassroomSummary({ id: `c${i + 1}`, name: `Classroom ${i + 1}`, orgLogin: `org-${i + 1}` }),
  );

describe("buildCommands: who gets which command", () => {
  it("gives a teacher the navigation, the classrooms and the actions, but not Administration", () => {
    const commands = buildCommands(makeContext({ classrooms: rooms(2) }));
    expect(ids(commands)).toEqual(
      expect.arrayContaining(["nav:home", "nav:settings", "classroom:c1", "classroom:c2"]),
    );
    expect(pick(commands, "nav:admin")).toBeUndefined();
  });

  it("offers Administration to an admin reading the teacher UI", () => {
    const commands = buildCommands(makeContext({ me: makeMe({ role: "admin" }) }));
    expect(need(commands, "nav:admin").group).toBe("navigate");
  });

  it("hides Administration from an admin who switched to the student view", () => {
    const commands = buildCommands(
      makeContext({ me: makeMe({ role: "admin" }), teacherUi: false, studentView: true }),
    );
    expect(pick(commands, "nav:admin")).toBeUndefined();
  });

  it("gives a student no classroom entry and no administration", () => {
    const commands = buildCommands(
      makeContext({
        me: makeMe({ role: "student" }),
        teacherUi: false,
        classrooms: [],
        // A plain student has no other view to switch to.
        onToggleStudentView: undefined,
      }),
    );
    expect(ids(commands).some((id) => id.startsWith(CLASSROOM_COMMAND_PREFIX))).toBe(false);
    expect(pick(commands, "nav:admin")).toBeUndefined();
    expect(pick(commands, "action:student-view")).toBeUndefined();
    expect(need(commands, "nav:settings").label).toBe("Settings");
  });

  it("keeps the classrooms out of the list while the teacher reads the student view", () => {
    const commands = buildCommands(
      makeContext({ teacherUi: false, studentView: true, classrooms: rooms(3) }),
    );
    expect(ids(commands).some((id) => id.startsWith(CLASSROOM_COMMAND_PREFIX))).toBe(false);
  });

  it("offers the view toggle, named after the view it leads to, only to whoever has one", () => {
    const toTeacher = buildCommands(makeContext({ studentView: true, teacherUi: false }));
    expect(need(toTeacher, "action:student-view").label).toBe("Back to teacher view");
    const toStudent = buildCommands(makeContext());
    expect(need(toStudent, "action:student-view").label).toBe("Switch to student view");
  });

  it("runs the toggle it was handed", () => {
    const onToggleStudentView = vi.fn();
    const commands = buildCommands(makeContext({ onToggleStudentView }));
    need(commands, "action:student-view").run();
    expect(onToggleStudentView).toHaveBeenCalledTimes(1);
  });

  it("signs out through the callback of the context", () => {
    const signOut = vi.fn();
    buildCommands(makeContext({ signOut })).find((c) => c.id === "action:signout")!.run();
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

describe("buildCommands: the home command follows the UI it sits in", () => {
  it("names the teacher home Classrooms, with the sidebar's icon", () => {
    const home = need(buildCommands(makeContext()), "nav:home");
    expect(home.label).toBe("Classrooms");
    expect(home.icon).toBe(School);
  });

  it("names the student home My classrooms, with the student icon", () => {
    const home = need(buildCommands(makeContext({ teacherUi: false })), "nav:home");
    expect(home.label).toBe("My classrooms");
    expect(home.icon).toBe(ClipboardList);
  });

  it("navigates home and to the settings", () => {
    const navigate = vi.fn();
    const commands = buildCommands(makeContext({ navigate }));
    need(commands, "nav:home").run();
    need(commands, "nav:settings").run();
    expect(navigate).toHaveBeenNthCalledWith(1, { view: "home" });
    expect(navigate).toHaveBeenNthCalledWith(2, { view: "settings" });
  });
});

describe("buildCommands: one command per classroom", () => {
  it("names every classroom once, hinted by its GitHub organization", () => {
    const commands = buildCommands(makeContext({ classrooms: rooms(3) }));
    const entries = commands.filter((c) => c.id.startsWith(CLASSROOM_COMMAND_PREFIX));
    expect(entries).toHaveLength(3);
    expect(ids(entries)).toEqual(["classroom:c1", "classroom:c2", "classroom:c3"]);
    expect(entries[0]).toMatchObject({
      label: "Open classroom Classroom 1",
      hint: "org-1",
      // The org login is searchable as well as shown: a teacher types it.
      keywords: "org-1",
    });
  });

  it("opens the classroom it names", () => {
    const navigate = vi.fn();
    const commands = buildCommands(makeContext({ navigate, classrooms: rooms(3) }));
    need(commands, "classroom:c2").run();
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "c2" });
  });
});

describe("buildCommands: the classroom group has a subject or does not exist", () => {
  const tabIds = ["tab:assignments", "tab:students", "tab:staff", "tab:settings"];
  const groupOf = (route: Route) =>
    groupCommands(buildCommands(makeContext({ route, classrooms: rooms(3) }))).find(
      (g) => g.group === "classroom",
    );

  it("offers the four tabs on a classroom route", () => {
    const group = groupOf({ view: "classroom", id: "c2" });
    expect(ids(group!.commands)).toEqual(tabIds);
    expect(group!.commands[0]!.label).toBe("Open the assignments");
    // No hint: four rows repeating one classroom name under the Classroom
    // heading distinguish nothing and cost the label its width on a phone.
    expect(group!.commands.map((c) => c.hint)).toEqual([undefined, undefined, undefined, undefined]);
  });

  /*
   * Dropping the hint took the classroom name out of what the row shows, not
   * out of what the fuzzy match sees: typing the classroom still gathers the
   * whole classroom — its entry and the four tabs of it — instead of the
   * entry alone.
   *
   * The name goes last in the match key and `fuzzyScore` matches an ordered
   * subsequence, so it is reached by "prg1", not by "prg1 students": the
   * keywords widen which queries find a row, they do not reorder it.
   */
  it("still finds the tabs by the classroom name the rows no longer show", () => {
    const commands = buildCommands(
      makeContext({
        route: { view: "classroom", id: "c2" },
        classrooms: [makeClassroomSummary({ id: "c2", name: "PRG1 2026", orgLogin: "heig-prg1" })],
      }),
    );
    expect(ids(filterCommands("prg1", commands))).toEqual(
      expect.arrayContaining(["classroom:c2", ...tabIds]),
    );
  });

  // Which classroom they point at is asserted where they are run, below.
  it("offers them on an assignment route too", () => {
    const group = groupOf({ view: "assignment", classroomId: "c3", assignmentId: "a1" });
    expect(ids(group!.commands)).toEqual(tabIds);
  });

  it("has nothing to point at on the home or the settings page", () => {
    expect(groupOf({ view: "home" })).toBeUndefined();
    expect(groupOf({ view: "settings" })).toBeUndefined();
  });

  /*
   * The route alone is not enough. A student who opens a link to
   * `/classrooms/c1` (App.tsx renders StudentHome there) and a teacher who
   * reloads that URL with the student view still stored both land on a
   * classroom route without the teacher UI, and neither of them is ever shown
   * the page these four tabs deep-link into.
   */
  it("keeps the teacher tabs out of the palette outside the teacher UI", () => {
    const commands = buildCommands(
      makeContext({
        me: makeMe({ role: "student" }),
        teacherUi: false,
        classrooms: [],
        route: { view: "classroom", id: "c1" },
      }),
    );
    expect(pick(commands, "tab:staff")).toBeUndefined();
    expect(ids(commands).some((id) => id.startsWith("tab:"))).toBe(false);
    expect(
      groupCommands(commands).find((g) => g.group === "classroom"),
    ).toBeUndefined();
  });
});

describe("buildCommands: the classroom tab deep link", () => {
  /*
   * The riskiest line of the palette. `ClassroomView` is not remounted when
   * the classroom id does not change, and `useSearchParam` only ever replaces
   * the query string from inside the page, so the command has to push the
   * whole URL itself and then wake both hooks with a `popstate`. All three
   * steps are asserted, because dropping any one of them leaves the address
   * bar and the page saying different things.
   */
  const runTab = (route: Route, id: string) => {
    window.history.replaceState(null, "", "/classrooms/c1");
    const navigate = vi.fn();
    const popstate = vi.fn();
    window.addEventListener("popstate", popstate);
    try {
      need(buildCommands(makeContext({ route, navigate, classrooms: rooms(3) })), id).run();
    } finally {
      window.removeEventListener("popstate", popstate);
    }
    return { navigate, popstate };
  };

  it("writes the tab into the address bar, moves the app state and re-reads both", () => {
    const { navigate, popstate } = runTab({ view: "classroom", id: "c1" }, "tab:students");
    expect(window.location.pathname).toBe("/classrooms/c1");
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("students");
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "c1" });
    expect(popstate).toHaveBeenCalledTimes(1);
  });

  it("leaves an assignment page for its own classroom", () => {
    window.history.replaceState(null, "", "/classrooms/c3/assignments/a1");
    const navigate = vi.fn();
    const commands = buildCommands(
      makeContext({
        route: { view: "assignment", classroomId: "c3", assignmentId: "a1" },
        navigate,
        classrooms: rooms(3),
      }),
    );
    need(commands, "tab:staff").run();
    expect(window.location.pathname + window.location.search).toBe("/classrooms/c3?tab=staff");
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "c3" });
  });

  /*
   * `useSearchParam` promises that writing a tab replaces the entry so that
   * Back still leaves the page, and the palette has to keep that promise:
   * three hops between the tabs of the classroom on screen used to cost four
   * Back presses to get out of it.
   */
  it("replaces the entry while it hops between the tabs of the page on screen", () => {
    window.history.replaceState(null, "", "/classrooms/c1");
    const before = window.history.length;
    const commands = buildCommands(
      makeContext({ route: { view: "classroom", id: "c1" }, classrooms: rooms(3) }),
    );
    need(commands, "tab:students").run();
    need(commands, "tab:staff").run();
    need(commands, "tab:settings").run();
    expect(window.history.length).toBe(before);
    expect(window.location.pathname + window.location.search).toBe(
      "/classrooms/c1?tab=settings",
    );
  });

  it("pushes exactly one entry when the hop leaves the page it was opened on", () => {
    window.history.replaceState(null, "", "/classrooms/c3/assignments/a1");
    const before = window.history.length;
    const commands = buildCommands(
      makeContext({
        route: { view: "assignment", classroomId: "c3", assignmentId: "a1" },
        classrooms: rooms(3),
      }),
    );
    need(commands, "tab:staff").run();
    expect(window.history.length).toBe(before + 1);
    expect(window.location.pathname + window.location.search).toBe("/classrooms/c3?tab=staff");
  });

  it("writes the default tab as no parameter at all, the way the page does", () => {
    window.history.replaceState(null, "", "/classrooms/c1?tab=staff");
    const commands = buildCommands(
      makeContext({ route: { view: "classroom", id: "c1" }, classrooms: rooms(3) }),
    );
    need(commands, "tab:assignments").run();
    expect(window.location.pathname + window.location.search).toBe("/classrooms/c1");
  });
});

describe("buildCommands: the theme commands", () => {
  it("offers the theme the reader is not looking at, and stores it as a choice", () => {
    const setThemeChoice = vi.fn();
    const onLight = need(
      buildCommands(makeContext({ resolvedTheme: "light", setThemeChoice })),
      "action:theme",
    );
    expect(onLight.label).toBe("Dark theme");
    onLight.run();
    expect(setThemeChoice).toHaveBeenCalledWith("dark");

    const onDark = need(
      buildCommands(makeContext({ resolvedTheme: "dark", setThemeChoice })),
      "action:theme",
    );
    expect(onDark.label).toBe("Light theme");
    onDark.run();
    expect(setThemeChoice).toHaveBeenLastCalledWith("light");
  });

  it("hides the way back to the system theme when the system theme is already in force", () => {
    const commands = buildCommands(makeContext({ themeChoice: "system" }));
    expect(pick(commands, "action:theme-system")).toBeUndefined();
  });

  it("offers the way back once a theme has been picked", () => {
    const setThemeChoice = vi.fn();
    for (const themeChoice of ["light", "dark"] as const) {
      const command = need(
        buildCommands(makeContext({ themeChoice, setThemeChoice })),
        "action:theme-system",
      );
      expect(command.label).toBe("Follow the system theme");
      command.run();
      expect(setThemeChoice).toHaveBeenLastCalledWith("system");
    }
  });
});

describe("buildCommands: the language command", () => {
  it("names the other language, in that language, from English", () => {
    const setLocale = vi.fn();
    const command = need(buildCommands(makeContext({ locale: "en", setLocale })), "action:locale");
    expect(command.label).toBe("Switch to Français");
    command.run();
    expect(setLocale).toHaveBeenCalledWith("fr");
  });

  it("names the other language from French", () => {
    const setLocale = vi.fn();
    const command = need(buildCommands(makeContext({ locale: "fr", setLocale })), "action:locale");
    expect(command.label).toBe("Passer en English");
    command.run();
    expect(setLocale).toHaveBeenCalledWith("en");
  });
});

describe("buildCommands: the help group", () => {
  const topics = [
    { topic: "roster", title: "Roster" },
    { topic: "timeline", title: "Timeline" },
  ];

  it("lists the two external pages and every help topic", () => {
    const commands = buildCommands(makeContext({ helpTopics: topics }));
    const help = commands.filter((c) => c.group === "help");
    expect(ids(help)).toEqual(["help:docs", "help:sources", "help:roster", "help:timeline"]);
    expect(help[0]!.hint).toBe("External link");
    expect(help[1]!.hint).toBe("External link");
    expect(help[2]).toMatchObject({ label: "Roster", hint: "Help" });
  });

  it("opens the drawer on the topic it names", () => {
    const openHelp = vi.fn();
    const commands = buildCommands(makeContext({ helpTopics: topics, openHelp }));
    need(commands, "help:timeline").run();
    expect(openHelp).toHaveBeenCalledWith("timeline");
  });

  it("opens an external page without handing it this one", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    need(buildCommands(makeContext()), "help:sources").run();
    expect(open).toHaveBeenCalledWith(
      "https://github.com/heig-tin-info/heig-classroom",
      "_blank",
      "noopener,noreferrer",
    );
    vi.unstubAllGlobals();
  });
});

describe("filterCommands", () => {
  const commands = buildCommands(
    makeContext({
      classrooms: [
        makeClassroomSummary({ id: "c1", name: "PRG1 2026", orgLogin: "heig-prg1-2026" }),
        makeClassroomSummary({ id: "c2", name: "Advanced topics", orgLogin: "zzyzx-lab" }),
      ],
    }),
  );

  it("finds a classroom by the organization login its name never mentions", () => {
    // "Advanced topics" shares nothing with "zzyzx-lab"; only the hidden
    // keywords make this query land.
    const found = filterCommands("zzyzx", commands);
    expect(ids(found)).toEqual(["classroom:c2"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterCommands("qwxjvk", commands)).toEqual([]);
  });

  it("returns every command, in the order it was given them, on an empty query", () => {
    expect(filterCommands("", commands)).toEqual(commands);
    expect(filterCommands("   ", commands)).toEqual(commands);
  });
});

describe("groupCommands", () => {
  const stub = (id: string, group: Command["group"]): Command => ({
    id,
    label: id,
    icon: School,
    group,
    run: () => {},
  });

  it("puts the groups in their fixed order whatever order the filter returned", () => {
    const scrambled = [
      stub("h", "help"),
      stub("a", "action"),
      stub("n", "navigate"),
      stub("c", "classroom"),
    ];
    expect(groupCommands(scrambled).map((g) => g.group)).toEqual([
      "navigate",
      "classroom",
      "action",
      "help",
    ]);
  });

  it("keeps the filter's order inside a group", () => {
    const group = groupCommands([stub("n2", "navigate"), stub("n1", "navigate")])[0]!;
    expect(ids(group.commands)).toEqual(["n2", "n1"]);
  });

  it("skips the groups nothing matched, so no empty heading is printed", () => {
    expect(groupCommands([stub("h", "help")]).map((g) => g.group)).toEqual(["help"]);
    expect(groupCommands([])).toEqual([]);
  });
});

describe("capClassrooms", () => {
  const commands = buildCommands(makeContext({ classrooms: rooms(30) }));
  const classroomIds = (list: Command[]) =>
    ids(list).filter((id) => id.startsWith(CLASSROOM_COMMAND_PREFIX));
  const otherIds = (list: Command[]) =>
    ids(list).filter((id) => !id.startsWith(CLASSROOM_COMMAND_PREFIX));

  it("shows only the first few classrooms while nothing is typed", () => {
    const capped = capClassrooms(commands, "");
    expect(classroomIds(capped)).toHaveLength(EMPTY_QUERY_CLASSROOM_CAP);
    expect(classroomIds(capped)).toEqual(classroomIds(commands).slice(0, EMPTY_QUERY_CLASSROOM_CAP));
  });

  it("drops nothing but classrooms", () => {
    expect(otherIds(capClassrooms(commands, ""))).toEqual(otherIds(commands));
  });

  it("puts every classroom back as soon as a query is typed", () => {
    expect(capClassrooms(commands, "c")).toBe(commands);
    expect(classroomIds(capClassrooms(commands, "classroom"))).toHaveLength(30);
  });

  it("treats a query of spaces as an empty one", () => {
    expect(classroomIds(capClassrooms(commands, "  "))).toHaveLength(EMPTY_QUERY_CLASSROOM_CAP);
  });
});
