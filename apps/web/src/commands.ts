import {
  BookOpen,
  CircleHelp,
  ClipboardList,
  GraduationCap,
  Languages,
  LogOut,
  Monitor,
  Moon,
  School,
  Settings as SettingsIcon,
  ShieldCheck,
  Sun,
  Users,
  UsersRound,
} from "lucide-react";

import type { ClassroomSummary, Me } from "@hgc/contracts";

import { fuzzyFilter } from "./fuzzy";
import { LOCALES, type Locale, type TFunction } from "./i18n";
import type { Route } from "./router";
import type { Theme, ThemeChoice } from "./theme";
import { GithubIcon, type IconType } from "./ui";

/*
 * What the command palette can do, as data. No JSX and no hook here on
 * purpose: the list is the part worth testing (which command shows up for
 * which viewer, what the fuzzy match sees), and a plain function of an
 * explicit context is testable by writing that context down.
 */

export type CommandGroupId = "navigate" | "classroom" | "action" | "help";

export interface Command {
  /** Stable id: used as the React key, the option DOM id and in tests. */
  id: string;
  /** Already localized by the builder. */
  label: string;
  /** Second, muted line (org login, "External link", …). Optional. */
  hint?: string;
  icon: IconType;
  group: CommandGroupId;
  /** Extra text the fuzzy match sees but the row does not show. */
  keywords?: string;
  run: () => void;
}

/** Everything a command needs to exist and to run, gathered by the Shell. */
export interface CommandContext {
  t: TFunction;
  locale: Locale;
  setLocale: (l: Locale, persist?: boolean) => void;
  route: Route;
  navigate: (r: Route) => void;
  me: Me;
  /** The teacher UI is on (false in student view and for students). */
  teacherUi: boolean;
  studentView: boolean;
  /** Absent for a plain student: they have no other view to switch to. */
  onToggleStudentView?: () => void;
  classrooms: ClassroomSummary[];
  themeChoice: ThemeChoice;
  resolvedTheme: Theme;
  setThemeChoice: (c: ThemeChoice) => void;
  openHelp: (topic: string) => void;
  helpTopics: { topic: string; title: string }[];
  signOut: () => void;
}

/** Id prefix of the per-classroom commands; the cap below recognizes them by it. */
export const CLASSROOM_COMMAND_PREFIX = "classroom:";

/**
 * How many classrooms the palette lists while nothing is typed. A teacher can
 * have thirty of them (the sidebar caps at twelve for the same reason): all of
 * them on an empty query would be a wall pushing the actions and the help out
 * of sight, and the palette would open on the one thing the reader did not
 * come for. Typing searches every classroom, so none is out of reach.
 */
export const EMPTY_QUERY_CLASSROOM_CAP = 6;

/**
 * The tabs of `ClassroomView`, as deep links. Copied rather than imported:
 * `ClassroomView` is a lazily loaded page chunk, and importing one constant
 * from it would pull the whole teacher page into the main bundle.
 */
const CLASSROOM_TABS = ["assignments", "students", "staff", "settings"] as const;

/** The tab `ClassroomView` shows without a `?tab=`; see `useSearchParam`. */
const DEFAULT_CLASSROOM_TAB: (typeof CLASSROOM_TABS)[number] = "assignments";

const TAB_ICONS: Record<(typeof CLASSROOM_TABS)[number], IconType> = {
  assignments: ClipboardList,
  students: Users,
  staff: UsersRound,
  settings: SettingsIcon,
};

const DOCS_URL = "https://heig-tin-info.github.io/heig-classroom/";
const SOURCES_URL = "https://github.com/heig-tin-info/heig-classroom";

/**
 * Deep link to one tab of a classroom.
 *
 * `useSearchParam` writes with `replaceState` only, from inside a page that is
 * already loaded, so the whole URL has to be written here; and `ClassroomView`
 * is not remounted when the id changes (nor, obviously, when it does not), so
 * its `?tab=` state would keep whatever it held. The `popstate` dispatched
 * afterwards is the one event both `useRoute` and `useSearchParam` already
 * listen to, and it makes them re-read the address bar we just wrote.
 *
 * Push or replace, on the same rule the tabs themselves follow: hopping
 * between the tabs of the classroom already on screen is not a navigation and
 * must not cost a Back press, while arriving from an assignment page or from
 * another classroom is one. Three hops used to mean four Backs to leave.
 * And the default tab is written as no parameter at all, because that is the
 * only spelling of it the rest of the app ever produces.
 */
function openClassroomTab(id: string, tab: string, navigate: (r: Route) => void) {
  const url = `/classrooms/${id}${tab === DEFAULT_CLASSROOM_TAB ? "" : `?tab=${tab}`}`;
  const samePage = window.location.pathname === `/classrooms/${id}`;
  window.history[samePage ? "replaceState" : "pushState"](null, "", url);
  // The pathname already matches, so `navigate` only moves the app state: no
  // second history entry for one navigation.
  navigate({ view: "classroom", id });
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Opens an external page without handing it a reference to this one. */
function openExternal(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Every command the viewer of `ctx` can run, in group order. */
export function buildCommands(ctx: CommandContext): Command[] {
  const { t, navigate } = ctx;
  const commands: Command[] = [
    {
      id: "nav:home",
      // Same label and icon as the first row of the sidebar: the palette must
      // name things the way the screen behind it does.
      label: ctx.teacherUi ? t("nav.classrooms") : t("student.title"),
      icon: ctx.teacherUi ? School : ClipboardList,
      group: "navigate",
      run: () => navigate({ view: "home" }),
    },
    {
      id: "nav:settings",
      label: t("menu.settings"),
      icon: SettingsIcon,
      group: "navigate",
      run: () => navigate({ view: "settings" }),
    },
  ];

  if (ctx.me.role === "admin" && ctx.teacherUi) {
    commands.push({
      id: "nav:admin",
      label: "Administration",
      icon: ShieldCheck,
      group: "navigate",
      run: () => navigate({ view: "admin" }),
    });
  }

  if (ctx.teacherUi) {
    for (const room of ctx.classrooms) {
      commands.push({
        id: `${CLASSROOM_COMMAND_PREFIX}${room.id}`,
        label: t("palette.openClassroom", { name: room.name }),
        hint: room.orgLogin,
        // The org login is how a teacher thinks of a classroom on GitHub, and
        // it is often shorter to type than the display name.
        keywords: room.orgLogin,
        icon: School,
        group: "navigate",
        run: () => navigate({ view: "classroom", id: room.id }),
      });
    }
  }

  // The roster deep links only exist where they make sense: from a classroom
  // or one of its assignments, "Open the students" has a subject.
  const roomId =
    ctx.route.view === "classroom"
      ? ctx.route.id
      : ctx.route.view === "assignment"
        ? ctx.route.classroomId
        : null;
  // Gated on the teacher UI as well as on the route: a student following a
  // `/classrooms/…` link, or a teacher reloading one with the student view
  // still stored, lands here too, and these four tabs belong to a page
  // neither of them is shown.
  if (roomId != null && ctx.teacherUi) {
    const name = ctx.classrooms.find((r) => r.id === roomId)?.name;
    for (const tab of CLASSROOM_TABS) {
      commands.push({
        id: `tab:${tab}`,
        // No hint: the four rows sit under the Classroom heading and all
        // point at the same place, so one classroom name repeated four times
        // distinguishes nothing and only costs the label its width.
        label: t(`palette.tab.${tab}`),
        // The name the hint no longer shows still has to be searchable: a
        // teacher reading PRG1 types "prg1 students", not "students".
        keywords: name,
        icon: TAB_ICONS[tab],
        group: "classroom",
        run: () => openClassroomTab(roomId, tab, navigate),
      });
    }
  }

  const dark = ctx.resolvedTheme === "dark";
  commands.push({
    id: "action:theme",
    // Flips what is on screen and stores that as an explicit choice, exactly
    // like the account menu: a toggle with two labels cannot express "system".
    label: dark ? t("menu.lightTheme") : t("menu.darkTheme"),
    icon: dark ? Sun : Moon,
    group: "action",
    run: () => ctx.setThemeChoice(dark ? "light" : "dark"),
  });
  if (ctx.themeChoice !== "system") {
    // The only way back to "system" outside the Settings page: the two-label
    // toggle above can never return there on its own.
    commands.push({
      id: "action:theme-system",
      label: t("palette.themeSystem"),
      icon: Monitor,
      group: "action",
      run: () => ctx.setThemeChoice("system"),
    });
  }

  const other = LOCALES.find((l) => l.code !== ctx.locale);
  if (other) {
    commands.push({
      id: "action:locale",
      // The target language is named in its own language, so the command is
      // readable by someone who cannot read the interface it sits in.
      label: t("palette.switchLocale", { language: other.label }),
      icon: Languages,
      group: "action",
      run: () => ctx.setLocale(other.code),
    });
  }

  if (ctx.onToggleStudentView) {
    const toggle = ctx.onToggleStudentView;
    commands.push({
      id: "action:student-view",
      label: ctx.studentView ? t("menu.teacherView") : t("menu.studentView"),
      icon: ctx.studentView ? School : GraduationCap,
      group: "action",
      run: () => toggle(),
    });
  }

  commands.push({
    id: "action:signout",
    label: t("menu.signout"),
    icon: LogOut,
    group: "action",
    run: () => ctx.signOut(),
  });

  commands.push(
    {
      id: "help:docs",
      label: t("header.docs"),
      hint: t("palette.external"),
      icon: BookOpen,
      group: "help",
      run: () => openExternal(DOCS_URL),
    },
    {
      id: "help:sources",
      label: t("header.sources"),
      hint: t("palette.external"),
      icon: GithubIcon,
      group: "help",
      run: () => openExternal(SOURCES_URL),
    },
  );
  for (const { topic, title } of ctx.helpTopics) {
    commands.push({
      id: `help:${topic}`,
      label: title,
      hint: t("palette.helpHint"),
      icon: CircleHelp,
      group: "help",
      run: () => ctx.openHelp(topic),
    });
  }

  return commands;
}

/**
 * Applies `EMPTY_QUERY_CLASSROOM_CAP`. It is a separate step, run by the
 * caller after the filter, rather than a `query` parameter of `buildCommands`:
 * the cap is about what an untouched list looks like, not about which commands
 * exist, and keeping `buildCommands` a function of the context alone is what
 * makes it readable as the registry it is.
 */
export function capClassrooms(commands: Command[], query: string): Command[] {
  if (query.trim() !== "") return commands;
  let shown = 0;
  return commands.filter((c) => {
    if (!c.id.startsWith(CLASSROOM_COMMAND_PREFIX)) return true;
    shown += 1;
    return shown <= EMPTY_QUERY_CLASSROOM_CAP;
  });
}

/**
 * Fuzzy match over the label, the hint and the hidden keywords at once, so
 * typing an org login finds a classroom whose displayed name shares nothing
 * with it.
 */
export function filterCommands(query: string, commands: Command[]): Command[] {
  return fuzzyFilter(query, commands, (c) => `${c.label} ${c.hint ?? ""} ${c.keywords ?? ""}`);
}

/** The fixed order of the groups; see `groupCommands`. */
const GROUP_ORDER: CommandGroupId[] = ["navigate", "classroom", "action", "help"];

/**
 * Groups the visible commands, in a fixed order, skipping the empty groups.
 *
 * The order is fixed and not driven by the best score in each group: the
 * reader types one more letter while their finger is already on Enter, and a
 * list that reshuffles its sections between two keystrokes runs the wrong
 * command. Within a group the filter's score still decides.
 */
export function groupCommands(
  commands: Command[],
): { group: CommandGroupId; commands: Command[] }[] {
  return GROUP_ORDER.map((group) => ({
    group,
    commands: commands.filter((c) => c.group === group),
  })).filter((g) => g.commands.length > 0);
}
