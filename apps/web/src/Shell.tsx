import { useQuery } from "@tanstack/react-query";
import { ClipboardList, Eye, Menu as MenuIcon, School, Settings as SettingsIcon, ShieldCheck, X } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";

import type { ClassroomSummary, Me } from "@hgc/contracts";

import { api } from "./api";
import { Logo, UserMenu } from "./Header";
import { useT } from "./i18n";
import type { Route } from "./router";
import { Button, cx, IconButton, OrgAvatar, useLayer, Z, type IconType } from "./ui";

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
    route.view === "classroom" ? route.id : route.view === "assignment" ? route.classroomId : null;
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
      {teacherUi && rooms.data?.length ? (
        <div>
          <p className="mb-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
            {t("nav.classrooms")}
          </p>
          <div className="space-y-0.5">
            {rooms.data.map((r) => (
              <NavItem
                key={r.id}
                label={
                  <span className="flex items-center gap-2">
                    <OrgAvatar login={r.orgLogin} className="size-4 rounded-[4px]" />
                    <span className="truncate">{r.name}</span>
                  </span>
                }
                active={currentRoom === r.id}
                onClick={() => go({ view: "classroom", id: r.id })}
              />
            ))}
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
  const t = useT();
  const [drawer, setDrawer] = useState(false);
  const drawerPanel = useRef<HTMLDivElement>(null);
  const drawerTitleId = useId();
  // The mobile drawer is a modal dialog: focus moves in, Tab cycles inside,
  // Escape closes it and the "Open menu" button gets the focus back.
  useLayer(drawerPanel, () => setDrawer(false), { enabled: drawer });

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
          {userMenu(true)}
        </div>

        {studentView ? (
          <div className="border-b border-accent/20 bg-accent-soft px-4 py-2 text-[13px] text-accent">
            <div className="mx-auto flex max-w-[1120px] items-center gap-2 sm:px-2">
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

        <main className="mx-auto w-full max-w-[1120px] px-4 py-6 sm:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
