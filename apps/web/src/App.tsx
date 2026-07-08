import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Building2,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Clock,
  ExternalLink,
  FolderGit2,
  LayoutGrid,
  List,
  Loader2,
  Lock,
  GitCommitHorizontal,
  LogOut,
  Moon,
  Plus,
  School,
  Search,
  Settings as SettingsIcon,
  Sun,
  Trash2,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  api,
  ApiError,
  type ClassroomDetail,
  type ClassroomSummary,
  type Me,
  type RosterEntry,
} from "./api";
import type { GradeView } from "./AssignmentDetail";
import { AssignmentDetail } from "./AssignmentDetail";
import { GradeScale, TestDonut } from "./charts";
import { fuzzyFilter } from "./fuzzy";
import { HelpIcon } from "./help";
import { formatDuration, useI18n, useT } from "./i18n";
import { OctocatGrad } from "./Logo";
import { useRoute, type Route } from "./router";
import { TimelineView } from "./Timeline";
import { AssignmentsCard } from "./AssignmentsCard";
import { useLiveUpdates } from "./live";
import { RosterImport } from "./RosterImport";
import { RosterTable } from "./RosterTable";
import { Avatar, SettingsPage } from "./SettingsPage";
import { applyTheme, initialTheme, type Theme } from "./theme";
import { Badge, Button, Card, EmptyState, Field, GithubIcon, isoDateTime, Modal, OrgAvatar } from "./ui";

function useMe() {
  return useQuery<Me | null>({
    queryKey: ["me"],
    retry: false,
    queryFn: async () => {
      try {
        return await api<Me>("/app/api/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
  });
}

function Logo({ className = "size-6" }: { className?: string }) {
  return (
    <span className="inline-flex items-center justify-center rounded-lg bg-accent p-1.5 text-white">
      <OctocatGrad className={className} />
    </span>
  );
}

function Landing() {
  const t = useT();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4">
      <Logo className="size-10" />
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">{t("app.title")}</h1>
        <p className="mt-2 max-w-md text-zinc-500 dark:text-zinc-400">{t("landing.tagline")}</p>
      </div>
      <a
        href="/app/auth/login"
        className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 font-medium text-white shadow-sm transition-all duration-150 hover:-translate-y-px hover:bg-accent-hover hover:shadow-md"
      >
        {t("landing.signin")}
      </a>
      <p className="text-xs text-zinc-400 dark:text-zinc-500">{t("landing.footer")}</p>
    </main>
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
function GithubBanner() {
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

function Header({
  me,
  onOpenSettings,
  onHome,
}: {
  me: Me;
  onOpenSettings: () => void;
  onHome: () => void;
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
        <ThemeToggle />
        <UserMenu me={me} onOpenSettings={onOpenSettings} />
      </div>
    </header>
  );
}

function ClassroomSettings({
  room,
  onClose,
  onGone,
}: {
  room: ClassroomDetail;
  onClose: () => void;
  onGone: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(room.name);
  const rename = useMutation({
    mutationFn: () =>
      api(`/app/api/classrooms/${room.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["classroom", room.id] });
      void qc.invalidateQueries({ queryKey: ["classrooms"] });
      onClose();
    },
  });
  const archive = useMutation({
    mutationFn: () => api(`/app/api/classrooms/${room.id}/archive`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["classrooms"] });
      onGone();
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/app/api/classrooms/${room.id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["classrooms"] });
      onGone();
    },
  });

  return (
    <Modal title="Classroom settings" onClose={onClose}>
      <div className="space-y-6">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            rename.mutate();
          }}
        >
          <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Button disabled={rename.isPending || name.trim() === "" || name === room.name}>
            Rename
          </Button>
        </form>

        <div className="rounded-lg bg-zinc-50 p-4 dark:bg-zinc-800/50">
          <h3 className="mb-1 font-medium">Archive classroom</h3>
          <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
            Removes the classroom from the interface for you and the students. Data and
            GitHub repositories are kept.
          </p>
          <Button
            variant="subtle"
            onClick={() => {
              if (window.confirm(`Archive “${room.name}”?`)) archive.mutate();
            }}
            disabled={archive.isPending}
          >
            <Archive className="size-4" /> Archive
          </Button>
        </div>

        <div className="rounded-lg bg-red-50 p-4 dark:bg-red-500/10">
          <h3 className="mb-1 font-medium text-red-700 dark:text-red-400">Delete classroom</h3>
          <p className="mb-3 text-sm text-red-700/80 dark:text-red-400/80">
            Deletes the classroom, its roster and its assignments from the portal. GitHub
            repositories are not touched. This cannot be undone.
          </p>
          <Button
            onClick={() => {
              if (
                window.confirm(
                  `Delete “${room.name}” permanently? Roster and assignments will be removed from the portal.`,
                )
              ) {
                remove.mutate();
              }
            }}
            disabled={remove.isPending}
          >
            <Trash2 className="size-4" /> Delete permanently
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Page-level breadcrumb: every in-app page shows where it sits. */
function Breadcrumb({ items }: { items: { label: string; onClick?: () => void }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm">
      {items.map((item, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 ? <ChevronRight className="size-3.5 text-zinc-300 dark:text-zinc-600" /> : null}
          {item.onClick ? (
            <button
              onClick={item.onClick}
              className="text-zinc-500 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              {item.label}
            </button>
          ) : (
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** Assignment page: own view, out of the roster, under the page breadcrumb. */
function AssignmentPage({
  classroomId,
  assignmentId,
  navigate,
}: {
  classroomId: string;
  assignmentId: string;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const room = useQuery<ClassroomDetail>({
    queryKey: ["classroom", classroomId],
    queryFn: () => api(`/app/api/classrooms/${classroomId}`),
  });
  return (
    <div className="space-y-4">
      <Breadcrumb
        items={[
          { label: t("nav.classrooms"), onClick: () => navigate({ view: "home" }) },
          {
            label: room.data?.name ?? "…",
            onClick: () => navigate({ view: "classroom", id: classroomId }),
          },
          { label: t("nav.assignment") },
        ]}
      />
      <Card className="p-4">
        <AssignmentDetail classroomId={classroomId} assignmentId={assignmentId} />
      </Card>
    </div>
  );
}

function ClassroomView({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
  const t = useT();
  const [showSettings, setShowSettings] = useState(false);
  const detail = useQuery<ClassroomDetail>({
    queryKey: ["classroom", id],
    queryFn: () => api(`/app/api/classrooms/${id}`),
  });

  if (detail.isLoading) return null;
  if (!detail.data) return <p>Classroom not found.</p>;
  const room = detail.data;

  return (
    <div className="space-y-4">
      <Breadcrumb
        items={[
          { label: t("nav.classrooms"), onClick: () => navigate({ view: "home" }) },
          { label: room.name },
        ]}
      />

      <div className="flex flex-wrap items-center gap-3">
        {room.org ? <OrgAvatar login={room.org.login} className="size-8" /> : null}
        <h1 className="text-2xl font-semibold tracking-tight">{room.name}</h1>
        <Badge tone="zinc" icon={Building2}>
          {room.org?.login}
        </Badge>
        {room.org?.installationId ? (
          <Badge tone="green" icon={CheckCircle2}>
            GitHub App installed
          </Badge>
        ) : (
          <span className="inline-flex items-center gap-2">
            <Badge tone="amber" icon={Clock}>
              GitHub App not installed
            </Badge>
            {room.appSlug ? (
              <a
                href={`https://github.com/apps/${room.appSlug}/installations/new`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-all duration-150 hover:-translate-y-px hover:bg-accent-hover"
              >
                <GithubIcon className="size-4" /> Install GitHub App
              </a>
            ) : null}
          </span>
        )}
        <span className="flex-1" />
        <Button variant="ghost" aria-label="Classroom settings" onClick={() => setShowSettings(true)}>
          <SettingsIcon className="size-4" />
        </Button>
      </div>

      {showSettings ? (
        <ClassroomSettings room={room} onClose={() => setShowSettings(false)} onGone={() => navigate({ view: "home" })} />
      ) : null}

      <AssignmentsCard
        classroomId={room.id}
        appInstalled={room.org?.installationId != null}
        onOpenAssignment={(aid) =>
          navigate({ view: "assignment", classroomId: room.id, assignmentId: aid })
        }
      />

      <Card>
        <div className="flex items-center gap-2 border-b border-zinc-100/80 px-4 py-3 dark:border-zinc-800/60">
          <Users className="size-4 text-zinc-400" />
          <h2 className="font-medium">Roster</h2>
          <HelpIcon topic="roster" />
        </div>
        <RosterTable classroomId={room.id} roster={room.roster} />
      </Card>

      <RosterImport classroomId={room.id} />
    </div>
  );
}

type ClassroomsViewMode = "cards" | "list" | "timeline";

/** Hover popover on the student badges: the roster at a glance. */
function RosterPopover({ room, children }: { room: ClassroomSummary; children: React.ReactNode }) {
  const t = useT();
  return (
    <span className="group/pop relative inline-flex">
      {children}
      {room.roster.length > 0 ? (
        <span className="pointer-events-none absolute left-0 top-full z-30 mt-1 hidden w-max max-w-64 rounded-xl bg-white p-3 text-left shadow-[0_4px_24px_rgb(0_0_0/0.15)] ring-1 ring-zinc-100 group-hover/pop:block dark:bg-zinc-900 dark:ring-zinc-800">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-400">
            {t("classrooms.roster")}
          </span>
          <span className="grid max-h-56 gap-0.5 overflow-hidden text-xs">
            {room.roster.slice(0, 16).map((s, i) => (
              <span key={i} className="flex items-center gap-1.5 whitespace-nowrap">
                {s.claimed ? (
                  <CheckCircle2 className="size-3 text-emerald-500" />
                ) : (
                  <Clock className="size-3 text-zinc-300 dark:text-zinc-600" />
                )}
                {s.nom} {s.prenom}
              </span>
            ))}
            {room.roster.length > 16 ? (
              <span className="text-zinc-400">{t("classrooms.andMore", { n: room.roster.length - 16 })}</span>
            ) : null}
          </span>
        </span>
      ) : null}
    </span>
  );
}

function OrgLink({ login }: { login: string }) {
  return (
    <a
      href={`https://github.com/${login}`}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`Open ${login} on GitHub`}
      className="inline-flex items-center gap-1 hover:text-accent hover:underline"
    >
      <Building2 className="size-3.5" /> {login}
      <ExternalLink className="size-3" />
    </a>
  );
}

function ClassroomsList({
  rooms,
  onOpen,
}: {
  rooms: ClassroomSummary[];
  onOpen: (id: string) => void;
}) {
  const t = useT();
  type Key = "name" | "org" | "students" | "claimed" | "assignments" | "createdAt";
  const [sortKey, setSortKey] = useState<Key>("name");
  const [dir, setDir] = useState<1 | -1>(1);
  const cell = "px-3 py-2";
  const val = (r: ClassroomSummary) =>
    sortKey === "name"
      ? r.name
      : sortKey === "org"
        ? r.orgLogin
        : sortKey === "students"
          ? r.students
          : sortKey === "claimed"
            ? r.claimed
            : sortKey === "assignments"
              ? r.assignments.length
              : r.createdAt;
  const sorted = [...rooms].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    return (
      (typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y))) * dir
    );
  });
  function Th({ k, children, right }: { k: Key; children: React.ReactNode; right?: boolean }) {
    const active = sortKey === k;
    return (
      <th className={`${cell} font-medium ${right ? "text-right" : ""}`}>
        <button
          className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-zinc-900 dark:hover:text-zinc-100"
          onClick={() => {
            if (active) setDir((d) => (d === 1 ? -1 : 1));
            else {
              setSortKey(k);
              setDir(1);
            }
          }}
        >
          {children}
          {active ? (dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : null}
        </button>
      </th>
    );
  }
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-zinc-500 dark:text-zinc-400">
              <Th k="name">{t("classrooms.col.name")}</Th>
              <Th k="org">{t("classrooms.col.org")}</Th>
              <Th k="students" right>
                {t("classrooms.col.students")}
              </Th>
              <Th k="claimed" right>
                {t("classrooms.col.claimed")}
              </Th>
              <Th k="assignments" right>
                {t("classrooms.col.assignments")}
              </Th>
              <Th k="createdAt">{t("classrooms.col.created")}</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {sorted.map((r) => (
              <tr
                key={r.id}
                onClick={() => onOpen(r.id)}
                className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
              >
                <td className={`${cell} font-medium`}>
                  <span className="inline-flex items-center gap-2">
                    <OrgAvatar login={r.orgLogin} className="size-5" /> {r.name}
                  </span>
                </td>
                <td className={`${cell} text-zinc-500 dark:text-zinc-400`}>
                  <OrgLink login={r.orgLogin} />
                </td>
                <td className={`${cell} text-right`}>
                  <RosterPopover room={r}>
                    <span className="tabular-nums">{r.students}</span>
                  </RosterPopover>
                </td>
                <td className={`${cell} text-right tabular-nums`}>{r.claimed}</td>
                <td className={`${cell} text-right tabular-nums`}>{r.assignments.length}</td>
                <td className={`${cell} text-zinc-500 dark:text-zinc-400`}>
                  {r.createdAt.slice(0, 10)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function TeacherHome({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [customOrg, setCustomOrg] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<ClassroomsViewMode>(
    () => (localStorage.getItem("hgc-classrooms-view") as ClassroomsViewMode) || "cards",
  );
  const setViewMode = (m: ClassroomsViewMode) => {
    setMode(m);
    localStorage.setItem("hgc-classrooms-view", m);
  };
  const rooms = useQuery<ClassroomSummary[]>({
    queryKey: ["classrooms"],
    queryFn: () => api("/app/api/classrooms"),
  });
  const installedOrgs = useQuery<string[]>({
    queryKey: ["installed-orgs"],
    queryFn: () => api("/app/api/orgs"),
  });
  const create = useMutation({
    mutationFn: () =>
      api("/app/api/classrooms", {
        method: "POST",
        body: JSON.stringify({ name, orgLogin: org }),
      }),
    onSuccess: () => {
      setName("");
      setOrg("");
      void qc.invalidateQueries({ queryKey: ["classrooms"] });
    },
  });

  const filtered = fuzzyFilter(query, rooms.data ?? [], (r) => `${r.name} ${r.orgLogin}`);
  const open = (id: string) => navigate({ view: "classroom", id });

  const toggle = (m: ClassroomsViewMode, Icon: typeof LayoutGrid, label: string) => (
    <button
      aria-label={label}
      title={label}
      onClick={() => setViewMode(m)}
      className={`rounded-md p-1.5 transition-colors ${
        mode === m
          ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100"
          : "text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
      }`}
    >
      <Icon className="size-4" />
    </button>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t("classrooms.title")}</h1>
        <HelpIcon topic="classrooms" />
        <span className="flex-1" />
        <label className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            type="search"
            placeholder={t("common.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-44 rounded-lg border border-zinc-200 bg-white py-1.5 pl-8 pr-3 text-sm shadow-sm focus:border-accent focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
            aria-label={t("common.search")}
          />
        </label>
        <span className="flex items-center gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
          {toggle("cards", LayoutGrid, t("view.cards"))}
          {toggle("list", List, t("view.list"))}
          {toggle("timeline", CalendarRange, t("view.timeline"))}
        </span>
      </div>

      {rooms.data?.length ? (
        mode === "timeline" ? (
          <TimelineView
            rooms={filtered}
            onOpenAssignment={(classroomId, assignmentId) =>
              navigate({ view: "assignment", classroomId, assignmentId })
            }
          />
        ) : mode === "list" ? (
          <ClassroomsList rooms={filtered} onOpen={open} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {filtered.map((c) => (
              <div
                key={c.id}
                onClick={() => open(c.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter") open(c.id);
                }}
                className="cursor-pointer text-left"
              >
                <Card className="p-4 hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgb(0_0_0/0.06),0_12px_28px_rgb(0_0_0/0.08)]">
                  <div className="flex items-center gap-2">
                    <OrgAvatar login={c.orgLogin} className="size-6" />
                    <span className="font-medium">{c.name}</span>
                  </div>
                  <p className="mt-1 flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
                    <OrgLink login={c.orgLogin} />
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <RosterPopover room={c}>
                      <Badge tone="zinc" icon={Users}>
                        {t(c.students === 1 ? "classrooms.students.one" : "classrooms.students", { n: c.students })}
                      </Badge>
                    </RosterPopover>
                    <RosterPopover room={c}>
                      <Badge tone="green" icon={CheckCircle2}>
                        {t("classrooms.claimed", { n: c.claimed })}
                      </Badge>
                    </RosterPopover>
                    <Badge tone="zinc" icon={ClipboardList}>
                      {t(c.assignments.length === 1 ? "classrooms.assignments.one" : "classrooms.assignments", { n: c.assignments.length })}
                    </Badge>
                  </div>
                </Card>
              </div>
            ))}
          </div>
        )
      ) : (
        <Card>
          <EmptyState icon={School} title={t("classrooms.empty.title")}>
            {t("classrooms.empty.body")}
          </EmptyState>
        </Card>
      )}

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <Plus className="size-4 text-zinc-400" />
          <h2 className="font-medium">{t("classrooms.new")}</h2>
          <HelpIcon topic="new-classroom" />
        </div>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field
            label={t("classrooms.name")}
            placeholder="PRG1 2026"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          {installedOrgs.data?.length && !customOrg ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                {t("classrooms.org")}
              </span>
              <select
                className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-accent focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
                value={org}
                onChange={(e) => {
                  if (e.target.value === "__other__") {
                    setCustomOrg(true);
                    setOrg("");
                  } else {
                    setOrg(e.target.value);
                  }
                }}
                required
              >
                <option value="" disabled>
                  {t("classrooms.orgPick")}
                </option>
                {installedOrgs.data.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
                <option value="__other__">{t("classrooms.orgOther")}</option>
              </select>
            </label>
          ) : (
            <Field
              label={t("classrooms.org")}
              placeholder="heig-tin-info"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              required
            />
          )}
          <Button disabled={create.isPending}>
            <Plus className="size-4" /> {t("classrooms.create")}
          </Button>
        </form>
        {create.isError ? (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">
            {create.error instanceof ApiError
              ? ((create.error.body as { message?: string })?.message ?? "Creation failed.")
              : "Creation failed."}
          </p>
        ) : null}
      </Card>
    </div>
  );
}


interface StudentRepo {
  fullName: string | null;
  provisionStatus: "pending" | "ok" | "error";
  invitationStatus: "none" | "pending" | "accepted";
  ciStatus: "none" | "pending" | "pass" | "fail";
  lockedAt: string | null;
  commitCount: number | null;
  checksPassed: number | null;
  checksTotal: number | null;
  grade: GradeView | null;
  gradeFrozen: boolean;
}

interface StudentAssignmentT {
  id: string;
  name: string;
  state: "published" | "locked";
  startAt: string;
  deadlineAt: string;
  repo: StudentRepo | null;
}

interface StudentClassroom {
  id: string;
  name: string;
  orgLogin: string;
  teacher: string;
  assignments: StudentAssignmentT[];
}

/** Live countdown to (or since) the deadline, refreshed every 30 s. */
function Countdown({ deadline }: { deadline: string }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const ms = new Date(deadline).getTime() - now;
  const dur = formatDuration(Math.abs(ms), t);
  return (
    <span className={ms < 0 ? "text-zinc-400" : "font-medium text-zinc-600 dark:text-zinc-300"}>
      {ms < 0 ? t("student.overdue", { duration: dur }) : t("student.until", { duration: dur })}
    </span>
  );
}

/** Metrics row for an accepted repository: commits, CI donut, grade scale. */
function RepoMetrics({ repo }: { repo: StudentRepo }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-3">
      {repo.commitCount !== null ? (
        <span className="inline-flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
          <GitCommitHorizontal className="size-3.5" />
          {t(repo.commitCount === 1 ? "student.commits.one" : "student.commits", {
            n: repo.commitCount,
          })}
        </span>
      ) : null}
      {repo.checksTotal ? (
        <span className="inline-flex items-center gap-1.5">
          <TestDonut passed={repo.checksPassed ?? 0} total={repo.checksTotal} size={40} />
          <span className="text-xs text-zinc-400">{t("student.tests")}</span>
        </span>
      ) : repo.ciStatus === "pending" ? (
        <Badge tone="amber" icon={Loader2}>
          {t("student.ciRunning")}
        </Badge>
      ) : null}
      {repo.grade && repo.grade.parseStatus === "ok" ? (
        <span className="inline-flex items-center gap-1.5">
          {repo.gradeFrozen ? <Lock className="size-3.5 text-zinc-400" /> : null}
          <GradeScale points={repo.grade.points!} max={repo.grade.max!} />
          <span className="text-xs text-zinc-400">{t("student.indicative")}</span>
        </span>
      ) : repo.ciStatus === "pass" ? (
        <Badge tone="green">{t("student.ciPass")}</Badge>
      ) : repo.ciStatus === "fail" ? (
        <Badge tone="red">{t("student.ciFail")}</Badge>
      ) : null}
    </div>
  );
}

function StudentAssignment({
  a,
  githubLinked,
}: {
  a: StudentAssignmentT;
  githubLinked: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const accept = useMutation({
    mutationFn: () => api(`/app/api/student/assignments/${a.id}/accept`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["student-classrooms"] }),
  });
  const acceptError =
    accept.isError && accept.error instanceof ApiError
      ? ((accept.error.body as { message?: string })?.message ?? "Acceptance failed")
      : null;
  const locked = a.state === "locked" || a.repo?.lockedAt != null;

  return (
    <li className={`space-y-1.5 py-2.5 text-sm ${locked ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        {locked ? <Lock className="size-3.5 text-zinc-400" /> : null}
        <span className="font-medium">{a.name}</span>
        {locked ? <Badge tone="red">{t("student.locked")}</Badge> : null}
        <span className="flex-1" />
        <span className="inline-flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
          <Clock className="size-3.5" /> {isoDateTime(a.deadlineAt)}
        </span>
        <Countdown deadline={a.deadlineAt} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {a.repo?.provisionStatus === "ok" && a.repo.fullName ? (
          <>
            <a
              href={`https://github.com/${a.repo.fullName}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-800 transition-all duration-150 hover:-translate-y-px hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              <GithubIcon className="size-4" /> {t("student.openRepo")}
            </a>
            {a.repo.invitationStatus === "pending" ? (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                {t("student.acceptInvite")}
              </span>
            ) : null}
            <RepoMetrics repo={a.repo} />
          </>
        ) : (
          <>
            <Button
              onClick={() => accept.mutate()}
              disabled={accept.isPending || !githubLinked}
              title={githubLinked ? undefined : t("student.linkPrompt")}
            >
              {accept.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> {t("student.creating")}
                </>
              ) : a.repo?.provisionStatus === "error" ? (
                t("student.retry")
              ) : (
                t("student.accept")
              )}
            </Button>
            {acceptError ? (
              <span className="text-xs text-red-600 dark:text-red-400">{acceptError}</span>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}

type StudentView = "cards" | "list";

function StudentHome({ me }: { me: Me }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<StudentView>(
    () => (localStorage.getItem("hgc-student-view") as StudentView) || "cards",
  );
  const setStudentView = (v: StudentView) => {
    setView(v);
    localStorage.setItem("hgc-student-view", v);
  };
  const rooms = useQuery<StudentClassroom[]>({
    queryKey: ["student-classrooms"],
    queryFn: () => api("/app/api/student/classrooms"),
  });

  if (rooms.isLoading) return null;
  const linked = me.githubLogin != null;

  // Flat, searchable list of (classroom, assignment) pairs.
  const flat = (rooms.data ?? []).flatMap((room) =>
    room.assignments.map((a) => ({ room, a })),
  );
  const filteredFlat = fuzzyFilter(query, flat, ({ room, a }) => `${a.name} ${room.name}`);
  const roomMatches = fuzzyFilter(query, rooms.data ?? [], (r) => r.name);
  const cell = "px-3 py-2";

  const toggle = (v: StudentView, Icon: typeof LayoutGrid, label: string) => (
    <button
      aria-label={label}
      title={label}
      onClick={() => setStudentView(v)}
      className={`rounded-md p-1.5 transition-colors ${
        view === v
          ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100"
          : "text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
      }`}
    >
      <Icon className="size-4" />
    </button>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t("student.title")}</h1>
        <span className="flex-1" />
        <label className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            type="search"
            placeholder={t("common.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-44 rounded-lg border border-zinc-200 bg-white py-1.5 pl-8 pr-3 text-sm shadow-sm focus:border-accent focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
            aria-label={t("common.search")}
          />
        </label>
        <span className="flex items-center gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
          {toggle("cards", LayoutGrid, t("view.cards"))}
          {toggle("list", List, t("view.list"))}
        </span>
      </div>

      {!linked ? (
        <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertTriangle className="size-4" />
          {t("student.linkPrompt")}
        </div>
      ) : null}

      {!rooms.data?.length ? (
        <Card>
          <EmptyState icon={ClipboardList} title={t("student.empty.title")}>
            {t("student.empty.body")}
          </EmptyState>
        </Card>
      ) : view === "list" ? (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  <th className={cell}>{t("nav.classrooms")}</th>
                  <th className={cell}>{t("nav.assignment")}</th>
                  <th className={cell}>{t("student.deadlineCol")}</th>
                  <th className={cell}>{t("assignment.col.status")}</th>
                  <th className={cell}>{t("assignment.col.grade")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {filteredFlat.map(({ room, a }) => {
                  const locked = a.state === "locked" || a.repo?.lockedAt != null;
                  return (
                    <tr key={a.id} className={locked ? "opacity-60" : ""}>
                      <td className={`${cell} text-zinc-500 dark:text-zinc-400`}>{room.name}</td>
                      <td className={`${cell} font-medium`}>
                        <span className="inline-flex items-center gap-1.5">
                          {locked ? <Lock className="size-3.5 text-zinc-400" /> : null}
                          {a.repo?.provisionStatus === "ok" && a.repo.fullName ? (
                            <a
                              href={`https://github.com/${a.repo.fullName}`}
                              target="_blank"
                              rel="noreferrer"
                              className="hover:text-accent hover:underline"
                            >
                              {a.name}
                            </a>
                          ) : (
                            a.name
                          )}
                        </span>
                      </td>
                      <td className={cell}>
                        <div className="flex flex-col">
                          <span className="text-zinc-500 dark:text-zinc-400">
                            {isoDateTime(a.deadlineAt)}
                          </span>
                          <span className="text-xs">
                            <Countdown deadline={a.deadlineAt} />
                          </span>
                        </div>
                      </td>
                      <td className={cell}>
                        {a.repo?.provisionStatus === "ok" ? (
                          <Badge tone="green" icon={CheckCircle2}>
                            {t("status.accepted")}
                          </Badge>
                        ) : (
                          <Badge tone="zinc">{t("status.notAccepted")}</Badge>
                        )}
                      </td>
                      <td className={cell}>
                        {a.repo?.grade && a.repo.grade.parseStatus === "ok" ? (
                          <GradeScale points={a.repo.grade.points!} max={a.repo.grade.max!} />
                        ) : (
                          <span className="text-zinc-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {roomMatches.map((room) => (
            <Card key={room.id} className="p-4">
              <div className="flex items-center gap-2">
                <OrgAvatar login={room.orgLogin} className="size-6" />
                <span className="font-medium">{room.name}</span>
              </div>
              <p className="mt-1 flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
                <span className="inline-flex items-center gap-1">
                  <Building2 className="size-3.5" /> {room.orgLogin}
                </span>
                <span>· {room.teacher}</span>
              </p>
              {room.assignments.length ? (
                <ul className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
                  {room.assignments.map((a) => (
                    <StudentAssignment key={a.id} a={a} githubLinked={linked} />
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-zinc-400">{t("student.noAssignments")}</p>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const me = useMe();
  const [route, navigate] = useRoute();
  const { setLocale } = useI18n();
  useLiveUpdates(me.data != null);
  // The account's saved language wins on load, so the choice follows the user
  // across devices (no re-persist: adopt only).
  const serverLocale = me.data?.locale ?? null;
  useEffect(() => {
    if (serverLocale) setLocale(serverLocale, false);
  }, [serverLocale, setLocale]);
  if (me.isLoading) return null;
  if (!me.data) return <Landing />;
  const role = me.data.role;
  const teacher = role === "teacher" || role === "admin";
  return (
    <div className="min-h-dvh">
      <Header
        me={me.data}
        onOpenSettings={() => navigate({ view: "settings" })}
        onHome={() => navigate({ view: "home" })}
      />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <GithubBanner />
        {route.view === "settings" ? (
          <SettingsPage me={me.data} onBack={() => navigate({ view: "home" })} />
        ) : !teacher ? (
          <StudentHome me={me.data} />
        ) : route.view === "classroom" ? (
          <ClassroomView id={route.id} navigate={navigate} />
        ) : route.view === "assignment" ? (
          <AssignmentPage
            classroomId={route.classroomId}
            assignmentId={route.assignmentId}
            navigate={navigate}
          />
        ) : (
          <TeacherHome navigate={navigate} />
        )}
      </main>
    </div>
  );
}
