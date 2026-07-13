import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  GraduationCap,
  LogOut,
  Moon,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";
import { useState } from "react";

import type { Me } from "@hgc/contracts";

import { api } from "./api";
import { useT } from "./i18n";
import { Avatar } from "./SettingsPage";
import { applyTheme, initialTheme, type Theme } from "./theme";
import { Button, GithubIcon } from "./ui";

export function Logo({ className = "size-6" }: { className?: string }) {
  return (
    <span className="inline-flex items-center justify-center rounded-lg bg-accent p-1.5 text-white">
      <GraduationCap className={className} />
    </span>
  );
}

function ThemeToggle() {
  const t = useT();
  const [theme, setTheme] = useState<Theme>(initialTheme);
  return (
    <Button
      variant="ghost"
      aria-label={t("menu.toggleTheme")}
      onClick={() => {
        const next = theme === "dark" ? "light" : "dark";
        setTheme(next);
        applyTheme(next);
      }}
    >
      {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

/** Return banner for the linking flow (?github=linked|conflict|error). */
export function GithubBanner() {
  const t = useT();
  const [status] = useState(() => {
    const s = new URLSearchParams(window.location.search).get("github");
    if (s) window.history.replaceState(null, "", "/");
    return s;
  });
  if (!status) return null;
  if (status === "linked") {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-300">
        <CheckCircle2 className="size-4" /> {t("github.linked")}
      </div>
    );
  }
  return (
    <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-500/10 dark:text-red-300">
      <AlertTriangle className="size-4" />
{status === "conflict" ? t("github.conflict") : t("github.failed")}
    </div>
  );
}

function UserMenu({ me, onOpenSettings }: { me: Me; onOpenSettings: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const logout = useMutation({
    mutationFn: () => api("/app/auth/logout", { method: "POST" }),
    onSuccess: () => qc.setQueryData(["me"], null),
  });
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={t("menu.user")}
        aria-expanded={open}
        className="flex items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <span className="hidden text-sm text-zinc-600 sm:inline dark:text-zinc-300">
          {me.givenName} {me.familyName}
        </span>
        <Avatar me={me} className="size-8 text-xs" />
        <ChevronDown className={`size-3.5 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-44 overflow-hidden rounded-xl bg-white py-1 shadow-[0_4px_24px_rgb(0_0_0/0.15)] dark:bg-zinc-900 dark:shadow-[0_4px_24px_rgb(0_0_0/0.5)]">
            <button
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <SettingsIcon className="size-4 text-zinc-400" /> {t("menu.settings")}
            </button>
            <button
              onClick={() => logout.mutate()}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <LogOut className="size-4 text-zinc-400" /> {t("menu.signout")}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function Header({
  me,
  onOpenSettings,
  onHome,
  studentView,
  onToggleStudentView,
}: {
  me: Me;
  onOpenSettings: () => void;
  onHome: () => void;
  studentView?: boolean;
  onToggleStudentView?: () => void;
}) {
  const t = useT();
  return (
    <header className="sticky top-0 z-10 bg-white/80 shadow-[0_1px_8px_rgb(0_0_0/0.06)] backdrop-blur dark:bg-zinc-950/80 dark:shadow-[0_1px_8px_rgb(0_0_0/0.4)]">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
        <button
          onClick={onHome}
          className="flex items-center gap-3 rounded-lg transition-opacity hover:opacity-80"
          title="Home"
        >
          <Logo className="size-5" />
          <span className="font-semibold tracking-tight">HEIG Classroom</span>
        </button>
        <span className="flex-1" />
        <a
          href="https://github.com/heig-tin-info/heig-classroom"
          target="_blank"
          rel="noreferrer"
          aria-label={t("header.sources")}
          title={t("header.sources")}
          className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          <GithubIcon className="size-4" />
        </a>
        <a
          href="https://heig-tin-info.github.io/heig-classroom/"
          target="_blank"
          rel="noreferrer"
          aria-label={t("header.docs")}
          title={t("header.docs")}
          className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          <BookOpen className="size-4" />
        </a>
        {onToggleStudentView ? (
          // Teacher/admin only: flip between the teacher UI and the student
          // UI (the seat is taken via "Join as student" on the classroom).
          <button
            onClick={onToggleStudentView}
            aria-label={studentView ? t("menu.teacherView") : t("menu.studentView")}
            title={studentView ? t("menu.teacherView") : t("menu.studentView")}
            aria-pressed={studentView}
            className={`rounded-lg p-2 transition-colors ${
              studentView
                ? "bg-accent/10 text-accent hover:bg-accent/20"
                : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            }`}
          >
            <GraduationCap className="size-4" />
          </button>
        ) : null}
        <ThemeToggle />
        <UserMenu me={me} onOpenSettings={onOpenSettings} />
      </div>
    </header>
  );
}
