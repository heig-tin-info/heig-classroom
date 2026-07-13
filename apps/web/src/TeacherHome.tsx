import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Building2,
  CalendarRange,
  CheckCircle2,
  ClipboardList,
  Clock,
  ExternalLink,
  LayoutGrid,
  List,
  Plus,
  School,
  Search,
  Users,
} from "lucide-react";
import { useState } from "react";

import type { ClassroomSummary } from "@hgc/contracts";

import { api, ApiError } from "./api";
import { fuzzyFilter } from "./fuzzy";
import { HelpIcon } from "./help";
import { useT } from "./i18n";
import type { Route } from "./router";
import { TimelineView } from "./Timeline";
import { Badge, Button, Card, EmptyState, Field, OrgAvatar } from "./ui";

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

export function TeacherHome({ navigate }: { navigate: (r: Route) => void }) {
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
  const [showArchives, setShowArchives] = useState(false);
  const rooms = useQuery<ClassroomSummary[]>({
    queryKey: ["classrooms"],
    queryFn: () => api("/app/api/classrooms"),
  });
  const archivedRooms = useQuery<ClassroomSummary[]>({
    queryKey: ["classrooms", "archived"],
    queryFn: () => api("/app/api/classrooms?archived=1"),
    enabled: showArchives,
  });
  const unarchive = useMutation({
    mutationFn: (id: string) => api(`/app/api/classrooms/${id}/unarchive`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["classrooms"] });
    },
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
        <button
          aria-label={t("classrooms.archives")}
          title={t("classrooms.archives")}
          aria-pressed={showArchives}
          onClick={() => setShowArchives((v) => !v)}
          className={`rounded-lg p-2 transition-colors ${
            showArchives
              ? "bg-accent/10 text-accent hover:bg-accent/20"
              : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          }`}
        >
          <Archive className="size-4" />
        </button>
      </div>

      {showArchives ? (
        // The archive: read-only cards, one click to restore. The active
        // views below stay untouched while browsing here.
        (() => {
          const archived = fuzzyFilter(
            query,
            archivedRooms.data ?? [],
            (r) => `${r.name} ${r.orgLogin}`,
          );
          return archived.length ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {archived.map((c) => (
                <Card key={c.id} className="p-4 opacity-80">
                  <div className="flex items-center gap-2">
                    <OrgAvatar login={c.orgLogin} className="size-6" />
                    <span className="font-medium">{c.name}</span>
                    <Badge tone="zinc" icon={Archive}>
                      {t("classrooms.archived")}
                    </Badge>
                    <span className="flex-1" />
                    <Button
                      variant="subtle"
                      onClick={() => unarchive.mutate(c.id)}
                      disabled={unarchive.isPending}
                    >
                      <ArchiveRestore className="size-4" /> {t("classrooms.restore")}
                    </Button>
                  </div>
                  <p className="mt-1 flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
                    <OrgLink login={c.orgLogin} />
                    {c.archivedAt ? (
                      <span>· {t("classrooms.archivedOn", { date: c.archivedAt.slice(0, 10) })}</span>
                    ) : null}
                  </p>
                </Card>
              ))}
            </div>
          ) : (
            <Card>
              <EmptyState icon={Archive} title={t("classrooms.archives.empty")}>
                {t("classrooms.archives.emptyBody")}
              </EmptyState>
            </Card>
          );
        })()
      ) : rooms.data?.length ? (
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
                {/* Quiet hover: an accent hairline fades in and the title picks
                    up the accent — no movement, nothing jumps. */}
                <Card className="group/card p-4 ring-1 ring-transparent transition-shadow hover:shadow-[0_1px_2px_rgb(0_0_0/0.05),0_8px_24px_rgb(0_0_0/0.06)] hover:ring-accent/30 dark:hover:ring-accent/40">
                  <div className="flex items-center gap-2">
                    <OrgAvatar login={c.orgLogin} className="size-6" />
                    <span className="font-medium transition-colors group-hover/card:text-accent">
                      {c.name}
                    </span>
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
        <p className="mt-2 text-xs text-zinc-400">
          {t("classrooms.noOrgHint")}{" "}
          <a
            href="https://github.com/account/organizations/new?plan=free"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            {t("classrooms.noOrgLink")}
          </a>{" "}
          {t("classrooms.noOrgHint2")}
        </p>
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
