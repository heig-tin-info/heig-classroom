import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  CalendarRange,
  CheckCircle2,
  ClipboardList,
  Clock,
  LayoutGrid,
  List,
  Plus,
  School,
  Users,
} from "lucide-react";
import { useState } from "react";

import type { ClassroomSummary } from "@hgc/contracts";

import { api, apiErrorMessage } from "./api";
import { fuzzyFilter } from "./fuzzy";
import { HelpIcon } from "./help";
import { compactDuration } from "./AssignmentForm";
import { useT } from "./i18n";
import type { Route } from "./router";
import { TimelineView } from "./Timeline";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  humanize,
  IconButton,
  Modal,
  OrgAvatar,
  PageHeader,
  pressable,
  QueryError,
  SearchInput,
  Segmented,
  Select,
  Skeleton,
  SortHeader,
  T,
  useNow,
  useSortableTable,
  Z,
} from "./ui";

type ClassroomsViewMode = "cards" | "list" | "timeline";

/** Hover popover on the student counts: the roster at a glance. */
function RosterPopover({ room, children }: { room: ClassroomSummary; children: React.ReactNode }) {
  const t = useT();
  return (
    <span className="group/pop relative inline-flex">
      {children}
      {room.roster.length > 0 ? (
        <span
          className={`pointer-events-none absolute left-0 top-full ${Z.popover} mt-1.5 hidden w-max max-w-64 rounded-menu border border-line bg-surface p-3 text-left shadow-popover group-hover/pop:block`}
        >
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
            {t("classrooms.roster")}
          </span>
          <span className="grid max-h-56 gap-0.5 overflow-hidden text-xs">
            {room.roster.slice(0, 16).map((s, i) => (
              <span key={i} className="flex items-center gap-1.5 whitespace-nowrap">
                {s.claimed ? (
                  <CheckCircle2 className="size-3 text-success" />
                ) : (
                  <Clock className="size-3 text-fg-faint" />
                )}
                {s.nom} {s.prenom}
              </span>
            ))}
            {room.roster.length > 16 ? (
              <span className="text-fg-faint">{t("classrooms.andMore", { n: room.roster.length - 16 })}</span>
            ) : null}
          </span>
        </span>
      ) : null}
    </span>
  );
}

/** The nearest published deadline still ahead, or the last one that passed. */
function nextDeadline(room: ClassroomSummary, now: number) {
  const live = room.assignments.filter((a) => a.state !== "draft");
  const ahead = live
    .filter((a) => new Date(a.deadlineAt).getTime() > now)
    .sort((a, b) => a.deadlineAt.localeCompare(b.deadlineAt));
  return ahead[0] ?? null;
}

function ClassroomCard({ room, onOpen }: { room: ClassroomSummary; onOpen: () => void }) {
  const t = useT();
  const now = useNow(60_000);
  const next = nextDeadline(room, now);
  const ratio = room.students ? room.claimed / room.students : 0;
  return (
    <div {...pressable(onOpen)} onClick={onOpen} className="group/card text-left">
      <Card interactive className="flex h-full flex-col p-5">
        <div className="flex items-start gap-3">
          <OrgAvatar login={room.orgLogin} className="size-9 rounded-[10px]" />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-bold tracking-tight transition-colors group-hover/card:text-accent">
              {room.name}
            </h3>
            <p className="truncate text-[13px] text-fg-muted">{room.orgLogin}</p>
          </div>
          {!room.isOwner ? <Badge tone="zinc">{t("classrooms.coTaught")}</Badge> : null}
        </div>

        <div className="mt-5 space-y-1.5">
          <div className="flex items-center justify-between text-[13px]">
            <RosterPopover room={room}>
              <span className="inline-flex items-center gap-1.5 text-fg-muted">
                <Users className="size-3.5 text-fg-faint" />
                {t(room.students === 1 ? "classrooms.students.one" : "classrooms.students", { n: room.students })}
              </span>
            </RosterPopover>
            <span className="tabular-nums text-fg-muted">{t("classrooms.claimed", { n: room.claimed })}</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-success transition-[width]" style={{ width: `${ratio * 100}%` }} />
          </div>
        </div>

        <div className="mt-auto space-y-1.5 border-t border-line pt-3 text-[13px]">
          <p className="inline-flex items-center gap-1.5 text-fg-muted">
            <ClipboardList className="size-3.5 text-fg-faint" />
            {t(room.assignments.length === 1 ? "classrooms.assignments.one" : "classrooms.assignments", {
              n: room.assignments.length,
            })}
          </p>
          {next ? (
            <p className="flex items-center gap-1.5 text-fg-muted">
              <CalendarClock className="size-3.5 shrink-0 text-fg-faint" />
              <span className="truncate">{next.name}</span>
              <span className="ml-auto shrink-0 font-semibold tabular-nums text-fg">
                {compactDuration(new Date(next.deadlineAt).getTime() - now)}
              </span>
            </p>
          ) : (
            <p className="flex items-center gap-1.5 text-fg-faint">
              <CalendarClock className="size-3.5 shrink-0" />
              {t("classrooms.noUpcoming")}
            </p>
          )}
        </div>
      </Card>
    </div>
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
  const rank = (r: ClassroomSummary, key: Key) =>
    key === "name"
      ? r.name
      : key === "org"
        ? r.orgLogin
        : key === "students"
          ? r.students
          : key === "claimed"
            ? r.claimed
            : key === "assignments"
              ? r.assignments.length
              : r.createdAt;
  const { sorted, sort, toggle } = useSortableTable(rooms, rank, { key: "name", dir: 1 });
  const Th = ({ k, children, right }: { k: Key; children: React.ReactNode; right?: boolean }) => (
    <SortHeader k={k} sort={sort} onToggle={toggle} right={right}>
      {children}
    </SortHeader>
  );
  return (
    <Card className="overflow-hidden">
      {/* Six columns do not fit a phone: scroll the table, not the page. */}
      <div className="overflow-x-auto">
        <table className={cx(T.table, "min-w-170")}>
          <thead>
            <tr className={T.head}>
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
          <tbody>
            {sorted.map((r) => (
              <tr
                key={r.id}
                onClick={() => onOpen(r.id)}
                {...pressable(() => onOpen(r.id), "row")}
                className={cx(T.row, T.rowHover, "cursor-pointer")}
              >
                <td className={`${T.td} font-semibold`}>
                  <span className="inline-flex items-center gap-2.5">
                    <OrgAvatar login={r.orgLogin} className="size-6 rounded-md" /> {r.name}
                  </span>
                </td>
                <td className={`${T.td} text-fg-muted`}>{r.orgLogin}</td>
                <td className={`${T.td} text-right tabular-nums`}>
                  <RosterPopover room={r}>
                    <span>{r.students}</span>
                  </RosterPopover>
                </td>
                <td className={`${T.td} text-right tabular-nums`}>{r.claimed}</td>
                <td className={`${T.td} text-right tabular-nums`}>{r.assignments.length}</td>
                <td className={`${T.td} text-fg-muted`}>{r.createdAt.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** "New classroom" dialog: a name and the organization, nothing else. */
function NewClassroomDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [customOrg, setCustomOrg] = useState(false);
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
      void qc.invalidateQueries({ queryKey: ["classrooms"] });
      onClose();
    },
  });
  const formId = "new-classroom";
  return (
    <Modal
      title={t("classrooms.new")}
      subtitle={
        <span className="inline-flex items-center gap-1.5">
          {t("classrooms.newHint")}
          <HelpIcon topic="new-classroom" />
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button form={formId} type="submit" loading={create.isPending} disabled={!name.trim() || !org.trim()}>
            <Plus /> {t("classrooms.create")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        {installedOrgs.isLoading ? (
          // Placeholder in the shape of the select that is about to land, so
          // the form does not jump from a text field to a dropdown.
          <Select label={t("classrooms.org")} value="" disabled onChange={() => {}}>
            <option value="">{t("common.loading")}</option>
          </Select>
        ) : installedOrgs.data?.length && !customOrg ? (
          <Select
            label={t("classrooms.org")}
            value={org}
            onChange={(e) => {
              if (e.target.value === "__other__") {
                setCustomOrg(true);
                setOrg("");
              } else {
                const next = e.target.value;
                // Picking an org pre-fills a humanized classroom name
                // ("prg1-2026" → "Prg1 2026") that stays editable.
                setName((n) => (n === "" || n === humanize(org) ? humanize(next) : n));
                setOrg(next);
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
          </Select>
        ) : (
          <Field
            label={t("classrooms.org")}
            placeholder="heig-tin-info"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            fullWidth
            required
            autoFocus
          />
        )}
        <Field
          label={t("classrooms.name")}
          placeholder="PRG1 2026"
          value={name}
          onChange={(e) => setName(e.target.value)}
          fullWidth
          required
        />
        <p className="text-xs leading-relaxed text-fg-faint">
          {t("classrooms.noOrgHint")}{" "}
          <a
            href="https://github.com/account/organizations/new?plan=free"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-fg-muted underline decoration-line-strong underline-offset-2 hover:text-fg"
          >
            {t("classrooms.noOrgLink")}
          </a>{" "}
          {t("classrooms.noOrgHint2")}
        </p>
        {create.isError ? (
          <p className="text-sm text-danger">{apiErrorMessage(create.error, t("classrooms.createFailed"))}</p>
        ) : null}
      </form>
    </Modal>
  );
}

export function TeacherHome({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
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

  const filtered = fuzzyFilter(query, rooms.data ?? [], (r) => `${r.name} ${r.orgLogin}`);
  const open = (id: string) => navigate({ view: "classroom", id });
  const total = rooms.data?.length ?? 0;
  const students = (rooms.data ?? []).reduce((n, r) => n + r.students, 0);
  // Nothing to search, sort or archive yet: the page is a title and one
  // invitation, and the empty state carries the only primary action.
  const bare = !showArchives && !rooms.isLoading && !rooms.isError && total === 0;

  const viewOption = (value: ClassroomsViewMode, Icon: typeof LayoutGrid, label: string) => ({
    value,
    label: (
      <span className="inline-flex items-center gap-1.5" title={label}>
        <Icon className="size-4" />
        <span className="sr-only">{label}</span>
      </span>
    ),
  });

  let body: React.ReactNode;
  if (showArchives) {
    // The archive: read-only cards, one click to restore. The active views
    // stay untouched while browsing here.
    const archived = fuzzyFilter(query, archivedRooms.data ?? [], (r) => `${r.name} ${r.orgLogin}`);
    body = archivedRooms.isLoading ? (
      <CardsSkeleton />
    ) : archivedRooms.isError ? (
      <QueryError
        title="Could not load the archives"
        error={archivedRooms.error}
        onRetry={() => void archivedRooms.refetch()}
        retrying={archivedRooms.isFetching}
      />
    ) : archived.length ? (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {archived.map((c) => (
          <Card key={c.id} className="p-5">
            <div className="flex items-start gap-3">
              <OrgAvatar login={c.orgLogin} className="size-9 rounded-[10px] opacity-70" />
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-base font-bold tracking-tight text-fg-muted">{c.name}</h3>
                <p className="truncate text-[13px] text-fg-faint">
                  {c.orgLogin}
                  {c.archivedAt ? ` · ${t("classrooms.archivedOn", { date: c.archivedAt.slice(0, 10) })}` : ""}
                </p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <Badge tone="zinc" icon={Archive}>
                {t("classrooms.archived")}
              </Badge>
              {/* Restoring is the owner's call (GH-9). */}
              {c.isOwner ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => unarchive.mutate(c.id)}
                  loading={unarchive.isPending && unarchive.variables === c.id}
                >
                  <ArchiveRestore /> {t("classrooms.restore")}
                </Button>
              ) : null}
              {unarchive.isError && unarchive.variables === c.id ? (
                <p className="w-full text-[13px] text-danger">
                  {apiErrorMessage(unarchive.error, "Could not restore this classroom.")}
                </p>
              ) : null}
            </div>
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
  } else if (rooms.isLoading) {
    body = <CardsSkeleton />;
  } else if (rooms.isError) {
    body = (
      <QueryError
        title="Could not load your classrooms"
        error={rooms.error}
        onRetry={() => void rooms.refetch()}
        retrying={rooms.isFetching}
      />
    );
  } else if (!rooms.data?.length) {
    body = (
      <Card>
        <EmptyState
          icon={School}
          title={t("classrooms.empty.title")}
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus /> {t("classrooms.newAction")}
            </Button>
          }
        >
          {t("classrooms.empty.body")}
        </EmptyState>
      </Card>
    );
  } else if (filtered.length === 0) {
    body = (
      <Card>
        <EmptyState icon={School} title="No classroom matches" className="py-12">
          Nothing here is called “{query}”. Try a shorter search, or part of the organization name.
        </EmptyState>
      </Card>
    );
  } else if (mode === "timeline") {
    body = (
      <TimelineView
        rooms={filtered}
        onOpenAssignment={(classroomId, assignmentId) =>
          navigate({ view: "assignment", classroomId, assignmentId })
        }
      />
    );
  } else if (mode === "list") {
    body = <ClassroomsList rooms={filtered} onOpen={open} />;
  } else {
    body = (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {filtered.map((c) => (
          <ClassroomCard key={c.id} room={c} onOpen={() => open(c.id)} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            {showArchives ? t("classrooms.archives") : t("classrooms.title")}
            <HelpIcon topic="classrooms" />
          </span>
        }
        description={
          showArchives
            ? t("classrooms.archives.emptyBody")
            : query.trim() !== "" && total
              ? `${filtered.length} of ${total} classrooms`
              : total
                ? t("classrooms.summary", { n: total, students })
                : null
        }
        actions={
          // Primary action, one per screen — and none at all while the empty
          // state below is offering the very same thing.
          bare ? null : (
            <Button onClick={() => setCreating(true)}>
              <Plus /> {t("classrooms.newAction")}
            </Button>
          )
        }
      />

      {bare ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            placeholder={t("common.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t("common.search")}
            className="w-full sm:w-56"
          />
          <span className="hidden flex-1 sm:block" />
          <Segmented
            name="classrooms-view"
            value={mode}
            onChange={setViewMode}
            disabled={showArchives}
            options={[
              viewOption("cards", LayoutGrid, t("view.cards")),
              viewOption("list", List, t("view.list")),
              viewOption("timeline", CalendarRange, t("view.timeline")),
            ]}
          />
          <IconButton
            label={t("classrooms.archives")}
            active={showArchives}
            onClick={() => setShowArchives((v) => !v)}
          >
            <Archive />
          </IconButton>
        </div>
      )}

      {body}

      {creating ? <NewClassroomDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function CardsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <Card key={i} className="space-y-4 p-5">
          <div className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-[10px]" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </Card>
      ))}
    </div>
  );
}
