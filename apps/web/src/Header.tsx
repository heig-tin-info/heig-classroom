import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  ChevronsUpDown,
  GraduationCap,
  LogOut,
  Moon,
  School,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";
import { useEffect } from "react";

import type { Me } from "@hgc/contracts";

import { api } from "./api";
import { useT } from "./i18n";
import { useToast } from "./notify";
import { setThemeChoice, useResolvedTheme } from "./theme";
import { Avatar, cx, GithubIcon, Menu, type MenuItem } from "./ui";

export function Logo({ className = "size-5" }: { className?: string }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-[10px] bg-accent p-1.5 text-on-fill">
      <GraduationCap className={className} />
    </span>
  );
}

/** Toast for the linking flow return (?github=linked|conflict|error). */
export function GithubLinkToast() {
  const t = useT();
  const toast = useToast();
  useEffect(() => {
    const status = new URLSearchParams(window.location.search).get("github");
    if (!status) return;
    window.history.replaceState(null, "", "/");
    if (status === "linked") toast(t("github.linked"), "success");
    else if (status === "conflict") toast(t("github.conflict"), "error");
    else toast(t("github.failed"), "error");
    // Fire once on mount: the query param is consumed above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

/**
 * Sign-out, shared by the account menu and the command palette. Dropping the
 * `me` query is what takes the app back to the landing page, and a second
 * copy of that would be a second place to get it wrong.
 */
export function useSignOut(): () => void {
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api("/app/auth/logout", { method: "POST" }),
    onSuccess: () => qc.setQueryData(["me"], null),
  });
  return () => logout.mutate();
}

/**
 * Account menu: settings, the teacher/student view switch, theme, the two
 * external links and sign-out. One trigger for the sidebar (full row) and
 * the mobile top bar (avatar only).
 */
export function UserMenu({
  me,
  compact,
  onOpenSettings,
  studentView,
  onToggleStudentView,
}: {
  me: Me;
  /** Avatar-only trigger (mobile top bar). */
  compact?: boolean;
  onOpenSettings: () => void;
  studentView?: boolean;
  onToggleStudentView?: () => void;
}) {
  const t = useT();
  // Shared store, so the Settings segmented control and this toggle can
  // never disagree about what is on screen.
  const theme = useResolvedTheme();
  const signOut = useSignOut();
  const items: MenuItem[] = [
    { label: t("menu.settings"), icon: SettingsIcon, onSelect: onOpenSettings },
    ...(onToggleStudentView
      ? [
          {
            label: studentView ? t("menu.teacherView") : t("menu.studentView"),
            icon: studentView ? School : GraduationCap,
            onSelect: onToggleStudentView,
          },
        ]
      : []),
    {
      label: theme === "dark" ? t("menu.lightTheme") : t("menu.darkTheme"),
      icon: theme === "dark" ? Sun : Moon,
      // Flips what is on screen and stores that as an explicit choice: a
      // toggle with two labels cannot express "system".
      onSelect: () => setThemeChoice(theme === "dark" ? "light" : "dark"),
    },
    { label: t("header.docs"), icon: BookOpen, href: "https://heig-tin-info.github.io/heig-classroom/", separator: true },
    { label: t("header.sources"), icon: GithubIcon, href: "https://github.com/heig-tin-info/heig-classroom" },
    { label: t("menu.signout"), icon: LogOut, onSelect: signOut, separator: true },
  ];
  return (
    <Menu
      items={items}
      label={t("menu.user")}
      align={compact ? "end" : "start"}
      trigger={
        compact ? (
          <button
            type="button"
            aria-label={t("menu.user")}
            className="rounded-full transition-opacity hover:opacity-80"
          >
            <Avatar me={me} className="size-8 text-xs" />
          </button>
        ) : (
          <button
            type="button"
            aria-label={t("menu.user")}
            className={cx(
              "flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-surface-2",
            )}
          >
            <Avatar me={me} className="size-8 text-xs" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold leading-tight">
                {me.givenName} {me.familyName}
              </span>
              <span className="block truncate text-xs text-fg-muted">{me.email}</span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-fg-faint" />
          </button>
        )
      }
    />
  );
}
