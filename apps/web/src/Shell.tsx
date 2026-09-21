import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ClipboardList,
  Eye,
  Menu as MenuIcon,
  School,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import type { ClassroomSummary, Me } from "@hgc/contracts";

import { api } from "./api";
import { CommandPalette } from "./CommandPalette";
import { Logo, UserMenu, useSignOut } from "./Header";
import { helpTopics, useHelp } from "./help";
import { useI18n, useT } from "./i18n";
import type { Route } from "./router";
import { setThemeChoice, useResolvedTheme, useThemeChoice } from "./theme";
import {
  Button,
  cx,
  IconButton,
  Kbd,
  modKey,
  OrgAvatar,
  useLayer,
  Z,
  type IconType,
} from "./ui";

/**
 * Application frame: a 240 px sidebar on desktop (navigation, the teacher's
 * classrooms, the account menu at the bottom) and a slim top bar with a
 * drawer on phones. The page content sits in a 1120 px column.
 */

function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
  trailing,
}: {
  icon?: IconType;
  label: ReactNode;
  active?: boolean;
  onClick: () => void;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cx(
        "flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-sm transition-colors",
        active ? "bg-accent-soft font-semibold text-accent" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      {Icon ? <Icon className={cx("size-4 shrink-0", active ? "" : "text-fg-faint")} /> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}

/** How many classrooms the sidebar shows before it offers to unfold. */
const SIDEBAR_CLASSROOM_CAP = 12;

/**
 * The slice of the classroom list the sidebar shows while it is folded: the
 * first `cap` entries, plus the classroom being read when it sits past them,
 * so the current page is never missing from its own navigation.
 */
export function cappedClassrooms<T extends { id: string }>(
  rooms: T[],
  currentId: string | null,
  cap: number,
): T[] {
  if (rooms.length <= cap) return rooms;
  const head = rooms.slice(0, cap);
  const current = currentId == null ? undefined : rooms.find((r) => r.id === currentId);
  return current && !head.includes(current) ? [...head, current] : head;
}

function Nav({
  me,
  route,
  navigate,
  teacherUi,
  onNavigate,
}: {
  me: Me;
  route: Route;
  navigate: (r: Route) => void;
  /** The teacher UI is on (false in student view and for students). */
  teacherUi: boolean;
  /** Called after any navigation (closes the mobile drawer). */
  onNavigate?: () => void;
}) {
  const t = useT();
  const rooms = useQuery<ClassroomSummary[]>({
    queryKey: ["classrooms"],
    queryFn: () => api("/app/api/classrooms"),
    enabled: teacherUi,
  });
  const go = (r: Route) => {
    navigate(r);
    onNavigate?.();
  };
  const currentRoom =
    route.view === "classroom"
      ? route.id
      : route.view === "assignment" || route.view === "assignment-groups"
        ? route.classroomId
        : null;
  // Folded by default and not persisted: thirty classrooms turn the sidebar
  // into a scrolling wall, and the teacher who wants them all says so once.
  const [showAll, setShowAll] = useState(false);
  const allRooms = rooms.data ?? [];
  const shownRooms = showAll
    ? allRooms
    : cappedClassrooms(allRooms, currentRoom, SIDEBAR_CLASSROOM_CAP);
  return (
    // min-h-0 + overflow-y-auto: with thirty classrooms the list scrolls on its
    // own inside the sticky sidebar instead of pushing the account row out.
    <nav className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-3 py-2">
      <div className="space-y-0.5">
        <NavItem
          icon={teacherUi ? School : ClipboardList}
          label={teacherUi ? t("nav.classrooms") : t("student.title")}
          active={route.view === "home"}
          onClick={() => go({ view: "home" })}
        />
        <NavItem
          icon={SettingsIcon}
          label={t("menu.settings")}
          active={route.view === "settings"}
          onClick={() => go({ view: "settings" })}
        />
        {me.role === "admin" && teacherUi ? (
          <NavItem
            icon={ShieldCheck}
            label="Administration"
            active={route.view === "admin"}
            onClick={() => go({ view: "admin" })}
          />
        ) : null}
      </div>
      {teacherUi && allRooms.length ? (
        <div>
          <p className="mb-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
            {t("nav.classrooms")}
          </p>
          <div className="space-y-0.5">
            {shownRooms.map((r) => (
              <NavItem
                key={r.id}
                label={
                  <span className="flex items-center gap-2">
                    <OrgAvatar login={r.orgLogin} className="size-4 rounded-sm" />
                    <span className="truncate">{r.name}</span>
                  </span>
                }
                active={currentRoom === r.id}
                onClick={() => go({ view: "classroom", id: r.id })}
              />
            ))}
            {allRooms.length > shownRooms.length ? (
              <NavItem
                icon={ChevronDown}
                label={`Show all (${allRooms.length})`}
                onClick={() => setShowAll(true)}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </nav>
  );
}

export function Shell({
  me,
  route,
  navigate,
  teacherUi,
  studentView,
  onToggleStudentView,
  children,
}: {
  me: Me;
  route: Route;
  navigate: (r: Route) => void;
  teacherUi: boolean;
  studentView: boolean;
  onToggleStudentView?: () => void;
  children: ReactNode;
}) {
  const { t, locale, setLocale } = useI18n();
  const [drawer, setDrawer] = useState(false);
  const drawerPanel = useRef<HTMLDivElement>(null);
  const drawerTitleId = useId();
  // The mobile drawer is a modal dialog: focus moves in, Tab cycles inside,
  // Escape closes it and the "Open menu" button gets the focus back.
  useLayer(drawerPanel, () => setDrawer(false), { enabled: drawer });

  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+Alt+K and Ctrl+Shift+K belong to the browser (the web console,
      // among others); only the bare shortcut is ours.
      if (e.altKey || e.shiftKey) return;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
      // On `window`, so it answers from inside a field too, which is the
      // convention everywhere this shortcut exists; and prevented, because
      // Firefox otherwise takes Ctrl+K to its own search bar.
      e.preventDefault();
      setPalette((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The same query `Nav` runs, deduplicated by react-query on the shared key:
  // the palette lists the classrooms the sidebar lists, at no extra request.
  const rooms = useQuery<ClassroomSummary[]>({
    queryKey: ["classrooms"],
    queryFn: () => api("/app/api/classrooms"),
    enabled: teacherUi,
  });
  const themeChoice = useThemeChoice();
  const resolvedTheme = useResolvedTheme();
  const { open: openHelp } = useHelp();
  const signOut = useSignOut();
  // Reads every help source to pull its title out; once per language is
  // enough. The teacher UI decides which topics are reachable at all.
  const topics = useMemo(() => helpTopics(locale, teacherUi), [locale, teacherUi]);

  /** `titleId` names the drawer through its own brand line. */
  const brand = (titleId?: string) => (
    <button
      type="button"
      onClick={() => navigate({ view: "home" })}
      className="flex items-center gap-2.5 rounded-[10px] px-2 py-1 text-left transition-opacity hover:opacity-80"
    >
      <Logo />
      <span id={titleId} className="text-[15px] font-bold tracking-tight">
        HEIG Classroom
      </span>
    </button>
  );
  const userMenu = (compact: boolean) => (
    <UserMenu
      me={me}
      compact={compact}
      onOpenSettings={() => navigate({ view: "settings" })}
      studentView={studentView}
      onToggleStudentView={onToggleStudentView}
    />
  );

  return (
    <div className="min-h-dvh lg:flex">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-canvas lg:flex">
        <div className="px-3 pb-2 pt-4">{brand()}</div>
        {/* A palette nobody can see does not exist: the shortcut is written
            on its own trigger, above the navigation it duplicates. */}
        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="group flex w-full items-center gap-2 rounded-[10px] border border-line bg-surface px-2.5 py-1.5 text-sm text-fg-faint transition-colors hover:text-fg"
          >
            <Search className="size-4 shrink-0" />
            {/* `fg-muted`, not the `fg-faint` the icon rests at: this is the
                only text the control carries, at body size, so it owes the
                reader 4.5:1 and not the 3:1 DESIGN.md grants a lone icon. */}
            <span className="flex-1 text-left text-fg-muted group-hover:text-fg">
              {t("palette.open")}
            </span>
            {/* One cap per key, the way the palette footer spells them: a cap
                is a picture of a key, and two keys in one is a picture of
                nothing. */}
            <span className="flex items-center gap-1">
              <Kbd>{modKey()}</Kbd>
              <Kbd>K</Kbd>
            </span>
          </button>
        </div>
        <Nav me={me} route={route} navigate={navigate} teacherUi={teacherUi} />
        <div className="border-t border-line p-2">{userMenu(false)}</div>
      </aside>

      {/* Mobile drawer */}
      {drawer ? (
        <div className={`fixed inset-0 ${Z.modal} lg:hidden`}>
          <div className="layer-backdrop absolute inset-0 bg-fg/30" onClick={() => setDrawer(false)} />
          <div
            ref={drawerPanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={drawerTitleId}
            tabIndex={-1}
            className="absolute inset-y-0 left-0 flex w-72 flex-col border-r border-line bg-canvas shadow-overlay focus:outline-none"
          >
            <div className="flex items-center justify-between px-3 pb-2 pt-4">
              {brand(drawerTitleId)}
              <IconButton label="Close menu" onClick={() => setDrawer(false)}>
                <X />
              </IconButton>
            </div>
            <Nav
              me={me}
              route={route}
              navigate={navigate}
              teacherUi={teacherUi}
              onNavigate={() => setDrawer(false)}
            />
            <div className="border-t border-line p-2">{userMenu(false)}</div>
          </div>
        </div>
      ) : null}

      <div className="min-w-0 flex-1">
        {/* Mobile top bar */}
        <div className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-canvas/90 px-3 backdrop-blur lg:hidden">
          <IconButton
            label="Open menu"
            aria-haspopup="dialog"
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
          >
            <MenuIcon />
          </IconButton>
          {brand()}
          <span className="flex-1" />
          <IconButton label={t("palette.open")} onClick={() => setPalette(true)}>
            <Search />
          </IconButton>
          {userMenu(true)}
        </div>

        {studentView ? (
          <div className="border-b border-accent/20 bg-accent-soft px-4 py-2 text-[13px] text-accent">
            <div className="mx-auto flex max-w-280 items-center gap-2 sm:px-2">
              <Eye className="size-4" />
              <span className="flex-1">{t("menu.studentViewBanner")}</span>
              {onToggleStudentView ? (
                <Button size="sm" variant="secondary" onClick={onToggleStudentView}>
                  {t("menu.teacherView")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <main className="mx-auto w-full max-w-280 px-4 py-6 sm:px-8 lg:py-8">{children}</main>
      </div>

      {/* Mounted only while open: nothing of it — the key listener of its
          layer, the autofocus, the query it holds — exists on a page nobody
          summoned it on. It still takes `open`, so a test can render it on
          its own without the Shell around it. */}
      {palette ? (
        <CommandPalette
          open
          onClose={() => setPalette(false)}
          t={t}
          locale={locale}
          setLocale={setLocale}
          route={route}
          navigate={navigate}
          me={me}
          teacherUi={teacherUi}
          studentView={studentView}
          onToggleStudentView={onToggleStudentView}
          classrooms={rooms.data ?? []}
          themeChoice={themeChoice}
          resolvedTheme={resolvedTheme}
          setThemeChoice={setThemeChoice}
          openHelp={openHelp}
          helpTopics={topics}
          signOut={signOut}
        />
      ) : null}
    </div>
  );
}
