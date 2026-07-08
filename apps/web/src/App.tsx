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
  GraduationCap,
  LayoutGrid,
  List,
  Loader2,
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
import { useState } from "react";

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
import { fuzzyFilter } from "./fuzzy";
import { HelpIcon } from "./help";
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
      <GraduationCap className={className} />
    </span>
  );
}

function Landing() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4">
      <Logo className="size-10" />
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">HEIG GitHub Classroom</h1>
        <p className="mt-2 max-w-md text-zinc-500 dark:text-zinc-400">
          Practical work on GitHub: individual repositories, automatic deadlines and an
          indicative grade after every CI run.
        </p>
      </div>
      <a
        href="/app/auth/login"
        className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 font-medium text-white shadow-sm transition-all duration-150 hover:-translate-y-px hover:bg-accent-hover hover:shadow-md"
      >
        Sign in with Switch edu-ID
      </a>
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        HEIG-VD — TIN Department
      </p>
    </main>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  return (
    <Button
      variant="ghost"
      aria-label="Toggle theme"
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
  const [status] = useState(() => {
    const s = new URLSearchParams(window.location.search).get("github");
    if (s) window.history.replaceState(null, "", "/");
    return s;
  });
  if (!status) return null;
  if (status === "linked") {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-300">
        <CheckCircle2 className="size-4" /> GitHub account linked.
      </div>
    );
  }
  return (
    <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-500/10 dark:text-red-300">
      <AlertTriangle className="size-4" />
      {status === "conflict"
        ? "This GitHub account is already linked to another user."
        : "GitHub linking failed — try again."}
    </div>
  );
}

function UserMenu({ me, onOpenSettings }: { me: Me; onOpenSettings: () => void }) {
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
        aria-label="User menu"
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
              <SettingsIcon className="size-4 text-zinc-400" /> Settings
            </button>
            <button
              onClick={() => logout.mutate()}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <LogOut className="size-4 text-zinc-400" /> Sign out
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
          aria-label="Project sources on GitHub"
          title="Project sources on GitHub"
          className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          <GithubIcon className="size-4" />
        </a>
        <a
          href="https://heig-tin-info.github.io/heig-classroom/"
          target="_blank"
          rel="noreferrer"
          aria-label="Documentation"
          title="Documentation"
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
  const room = useQuery<ClassroomDetail>({
    queryKey: ["classroom", classroomId],
    queryFn: () => api(`/app/api/classrooms/${classroomId}`),
  });
  return (
    <div className="space-y-4">
      <Breadcrumb
        items={[
          { label: "Classrooms", onClick: () => navigate({ view: "home" }) },
          {
            label: room.data?.name ?? "…",
            onClick: () => navigate({ view: "classroom", id: classroomId }),
          },
          { label: "Assignment" },
        ]}
      />
      <Card className="p-4">
        <AssignmentDetail classroomId={classroomId} assignmentId={assignmentId} />
      </Card>
    </div>
  );
}

function ClassroomView({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
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
          { label: "Classrooms", onClick: () => navigate({ view: "home" }) },
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
  return (
    <span className="group/pop relative inline-flex">
      {children}
      {room.roster.length > 0 ? (
        <span className="pointer-events-none absolute left-0 top-full z-30 mt-1 hidden w-max max-w-64 rounded-xl bg-white p-3 text-left shadow-[0_4px_24px_rgb(0_0_0/0.15)] ring-1 ring-zinc-100 group-hover/pop:block dark:bg-zinc-900 dark:ring-zinc-800">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-400">
            Roster
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
              <span className="text-zinc-400">… and {room.roster.length - 16} more</span>
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
              <Th k="name">Name</Th>
              <Th k="org">Organization</Th>
              <Th k="students" right>
                Students
              </Th>
              <Th k="claimed" right>
                Claimed
              </Th>
              <Th k="assignments" right>
                Assignments
              </Th>
              <Th k="createdAt">Created</Th>
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
        <h1 className="text-2xl font-semibold tracking-tight">My classrooms</h1>
        <HelpIcon topic="classrooms" />
        <span className="flex-1" />
        <label className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            type="search"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-44 rounded-lg border border-zinc-200 bg-white py-1.5 pl-8 pr-3 text-sm shadow-sm focus:border-accent focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
            aria-label="Search classrooms"
          />
        </label>
        <span className="flex items-center gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
          {toggle("cards", LayoutGrid, "Card view")}
          {toggle("list", List, "List view")}
          {toggle("timeline", CalendarRange, "Timeline view")}
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
                        {c.students} student{c.students === 1 ? "" : "s"}
                      </Badge>
                    </RosterPopover>
                    <RosterPopover room={c}>
                      <Badge tone="green" icon={CheckCircle2}>
                        {c.claimed} claimed
                      </Badge>
                    </RosterPopover>
                    <Badge tone="zinc" icon={ClipboardList}>
                      {c.assignments.length} assignment{c.assignments.length === 1 ? "" : "s"}
                    </Badge>
                  </div>
                </Card>
              </div>
            ))}
          </div>
        )
      ) : (
        <Card>
          <EmptyState icon={School} title="No classrooms">
            Create your first classroom to distribute assignments to your students.
          </EmptyState>
        </Card>
      )}

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <Plus className="size-4 text-zinc-400" />
          <h2 className="font-medium">New classroom</h2>
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
            label="Name"
            placeholder="PRG1 2026"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          {installedOrgs.data?.length && !customOrg ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                GitHub organization
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
                  Pick an organization (App installed)
                </option>
                {installedOrgs.data.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
                <option value="__other__">Other organization…</option>
              </select>
            </label>
          ) : (
            <Field
              label="GitHub organization"
              placeholder="heig-tin-info"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              required
            />
          )}
          <Button disabled={create.isPending}>
            <Plus className="size-4" /> Create
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


interface StudentClassroom {
  id: string;
  name: string;
  orgLogin: string;
  teacher: string;
  assignments: {
    id: string;
    name: string;
    state: "published" | "locked";
    startAt: string;
    deadlineAt: string;
    repo: {
      fullName: string | null;
      provisionStatus: "pending" | "ok" | "error";
      invitationStatus: "none" | "pending" | "accepted";
      ciStatus: "none" | "pending" | "pass" | "fail";
      grade: GradeView | null;
      gradeFrozen: boolean;
    } | null;
  }[];
}

function StudentAssignment({
  a,
  githubLinked,
}: {
  a: StudentClassroom["assignments"][number];
  githubLinked: boolean;
}) {
  const qc = useQueryClient();
  const accept = useMutation({
    mutationFn: () => api(`/app/api/student/assignments/${a.id}/accept`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["student-classrooms"] }),
  });
  const acceptError =
    accept.isError && accept.error instanceof ApiError
      ? ((accept.error.body as { message?: string })?.message ?? "Acceptance failed")
      : null;

  return (
    <li className="space-y-1 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{a.name}</span>
        {a.state === "locked" ? <Badge tone="red">locked</Badge> : null}
        <span className="flex-1" />
        <span className="inline-flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
          <Clock className="size-3.5" /> due {isoDateTime(a.deadlineAt)}
        </span>
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
              <GithubIcon className="size-4" /> Open your repository
            </a>
            {a.repo.invitationStatus === "pending" ? (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                Accept the GitHub invitation first (check your notifications).
              </span>
            ) : null}
            {a.repo.ciStatus === "pending" ? (
              <Badge tone="amber" icon={Loader2}>
                CI running
              </Badge>
            ) : a.repo.grade && a.repo.grade.parseStatus === "ok" ? (
              <span
                className="inline-flex items-center gap-1.5"
                title={`Evaluated commit ${a.repo.grade.sha.slice(0, 7)} — ${isoDateTime(a.repo.grade.completedAt)}. Indicative grade, not contractual.`}
              >
                <Badge tone={a.repo.gradeFrozen ? "zinc" : "green"}>
                  {a.repo.gradeFrozen ? "final " : ""}grade {a.repo.grade.points}/{a.repo.grade.max}
                </Badge>
                <a
                  href={`https://github.com/${a.repo.fullName}/commit/${a.repo.grade.sha}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs text-zinc-400 hover:underline"
                >
                  {a.repo.grade.sha.slice(0, 7)}
                </a>
                <span className="text-xs text-zinc-400">indicative, not contractual</span>
              </span>
            ) : a.repo.ciStatus === "pass" ? (
              <Badge tone="green">CI pass</Badge>
            ) : a.repo.ciStatus === "fail" ? (
              <Badge tone="red">CI fail</Badge>
            ) : null}
          </>
        ) : (
          <>
            <Button
              onClick={() => accept.mutate()}
              disabled={accept.isPending || !githubLinked}
              title={githubLinked ? undefined : "Link your GitHub account first"}
            >
              {accept.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Creating your repository…
                </>
              ) : a.repo?.provisionStatus === "error" ? (
                "Retry acceptance"
              ) : (
                "Accept assignment"
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

function StudentHome({ me }: { me: Me }) {
  const rooms = useQuery<StudentClassroom[]>({
    queryKey: ["student-classrooms"],
    queryFn: () => api("/app/api/student/classrooms"),
  });

  if (rooms.isLoading) return null;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">My classrooms</h1>
      {!me.githubLogin ? (
        <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertTriangle className="size-4" />
          Link your GitHub account (top right) to be able to accept assignments.
        </div>
      ) : null}
      {rooms.data?.length ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {rooms.data.map((room) => (
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
                    <StudentAssignment key={a.id} a={a} githubLinked={me.githubLogin != null} />
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-zinc-400">No published assignments yet.</p>
              )}
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState icon={ClipboardList} title="No classrooms yet">
            Your teacher enrolls you through the class roster — classrooms appear here
            automatically once you are on it.
          </EmptyState>
        </Card>
      )}
    </div>
  );
}

export default function App() {
  const me = useMe();
  const [route, navigate] = useRoute();
  useLiveUpdates(me.data != null);
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
