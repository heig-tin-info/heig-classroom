import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  FileSpreadsheet,
  GraduationCap,
  Settings as SettingsIcon,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  UsersRound,
  XCircle,
} from "lucide-react";
import { useState } from "react";

import type { ClassroomDetail, ClassroomGradesPayload, ClassroomStaffRole } from "@hgc/contracts";

import { api, ApiError, apiErrorMessage, useMe } from "./api";
import { AssignmentsSection } from "./AssignmentsCard";
import { Breadcrumb } from "./Breadcrumb";
import { useConfirm } from "./confirm";
import { fuzzyFilter } from "./fuzzy";
import { useT } from "./i18n";
import { useSearchParam, type Route } from "./router";
import { useToast } from "./notify";
import { RosterImport } from "./RosterImport";
import { RosterTable } from "./RosterTable";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  GithubIcon,
  LinkButton,
  Menu,
  OrgAvatar,
  PageHeader,
  QueryError,
  SearchInput,
  SectionHeading,
  Segmented,
  Skeleton,
  Spinner,
  Tabs,
} from "./ui";

type Tab = "assignments" | "students" | "staff" | "settings";

/** Rename, archive, delete — inline on the Settings tab, no modal. */
function SettingsTab({ room, onGone }: { room: ClassroomDetail; onGone: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
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
    <div className="max-w-2xl space-y-6">
      <Card className="p-5">
        <SectionHeading title="Name" description="Shown to you, your staff and the students." />
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            rename.mutate();
          }}
        >
          <div className="min-w-56 flex-1">
            <Field label="Classroom name" value={name} onChange={(e) => setName(e.target.value)} required fullWidth />
          </div>
          <Button
            type="submit"
            variant="secondary"
            loading={rename.isPending}
            disabled={name.trim() === "" || name === room.name}
          >
            Rename
          </Button>
          {rename.isError ? (
            <p className="w-full text-[13px] text-danger">
              {apiErrorMessage(rename.error, "Could not rename this classroom.")}
            </p>
          ) : null}
          {rename.isSuccess && name === room.name ? (
            <p className="w-full text-[13px] text-success">Name saved.</p>
          ) : null}
        </form>
      </Card>

      {room.isOwner ? (
        <Card className="divide-y divide-line">
          <div className="flex flex-wrap items-center gap-4 p-5">
            {/* A wide minimum keeps the sentence readable: below it the button
                drops to its own line instead of squeezing the text. */}
            <div className="min-w-56 flex-1">
              <h3 className="font-semibold">Archive this classroom</h3>
              <p className="mt-0.5 text-[13px] text-fg-muted">
                Removes the classroom from the interface for you and the students. Data and GitHub
                repositories are kept; you can restore it from the archives.
              </p>
            </div>
            <Button
              variant="secondary"
              loading={archive.isPending}
              onClick={async () => {
                if (
                  await confirm({
                    title: `Archive “${room.name}”?`,
                    message: "The classroom disappears for you and the students until you restore it.",
                    confirmLabel: "Archive classroom",
                  })
                ) {
                  archive.mutate();
                }
              }}
            >
              <Archive /> Archive classroom
            </Button>
            {archive.isError ? (
              <p className="w-full text-[13px] text-danger">
                {apiErrorMessage(archive.error, "Could not archive this classroom.")}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-4 p-5">
            {/* A wide minimum keeps the sentence readable: below it the button
                drops to its own line instead of squeezing the text. */}
            <div className="min-w-56 flex-1">
              <h3 className="font-semibold text-danger">Delete this classroom</h3>
              <p className="mt-0.5 text-[13px] text-fg-muted">
                Deletes the classroom, its roster and its assignments from the portal. GitHub
                repositories are not touched. This cannot be undone.
              </p>
            </div>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={async () => {
                if (
                  await confirm({
                    title: `Delete “${room.name}” permanently?`,
                    message: "Roster and assignments are removed from the portal. Repositories stay on GitHub.",
                    confirmLabel: "Delete permanently",
                    danger: true,
                  })
                ) {
                  remove.mutate();
                }
              }}
            >
              <Trash2 /> Delete permanently
            </Button>
            {remove.isError ? (
              <p className="w-full text-[13px] text-danger">
                {apiErrorMessage(remove.error, "Could not delete this classroom.")}
              </p>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * Guided GitHub App installation. Step 2 keeps the SAME tab: GitHub's
 * setup_url brings the owner straight back to this classroom, the server
 * resolves the installation on the way and the badge turns green live (SSE).
 */
function InstallWizard({ room }: { room: ClassroomDetail }) {
  // target_id preselects the classroom's organization on GitHub (otherwise
  // the account picker defaults to whatever GitHub fancies).
  const installUrl = room.appSlug
    ? room.org?.githubOrgId
      ? `https://github.com/apps/${room.appSlug}/installations/new/permissions?target_id=${room.org.githubOrgId}&state=${room.id}`
      : `https://github.com/apps/${room.appSlug}/installations/new?state=${room.id}`
    : null;
  const Step = ({ n, done, children }: { n: number; done?: boolean; children: React.ReactNode }) => (
    <li className="flex items-start gap-3">
      {done ? (
        <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
          <CheckCircle2 className="size-3.5" />
        </span>
      ) : (
        <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] font-bold text-fg-muted">
          {n}
        </span>
      )}
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </li>
  );
  return (
    <Card className="p-5">
      <SectionHeading icon={GithubIcon} title="Connect GitHub" />
      <p className="mt-2 max-w-2xl text-sm text-fg-muted">
        Assignments need the HEIG Classroom GitHub App installed on{" "}
        <span className="font-medium text-fg">{room.org?.login}</span>: it creates the student
        repositories, receives their pushes and collects the grades.
      </p>
      <ol className="mt-4 space-y-3">
        <Step n={1} done>
          <span className="text-fg-muted">
            The organization <span className="font-mono text-fg">{room.org?.login}</span> exists on
            GitHub.
          </span>
        </Step>
        <Step n={2}>
          <div className="flex flex-wrap items-center gap-3">
            {installUrl ? (
              <LinkButton href={installUrl} target="_blank" rel="noreferrer" variant="primary">
                <GithubIcon /> Install the GitHub App
              </LinkButton>
            ) : (
              <span className="text-warning">
                The platform's GitHub App is not configured — contact the administrator.
              </span>
            )}
            <span className="text-xs text-fg-faint">
              You must be an owner of the organization. Pick “All repositories”.
            </span>
          </div>
        </Step>
        <Step n={3}>
          <span className="text-fg-muted">Validate on GitHub — the status here turns green automatically.</span>
        </Step>
      </ol>
    </Card>
  );
}

/**
 * Classroom staff (GH-9): the colleagues who co-teach this course. Every
 * member does everything inside the classroom; the teacher/assistant role is
 * a label. Only the owner edits the list — other members read it.
 */
function StaffTab({ room }: { room: ClassroomDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ClassroomStaffRole>("teacher");
  const refresh = () => qc.invalidateQueries({ queryKey: ["classroom", room.id] });

  const add = useMutation({
    mutationFn: () =>
      api(`/app/api/classrooms/${room.id}/staff`, {
        method: "POST",
        body: JSON.stringify({ email, role }),
      }),
    onSuccess: () => {
      setEmail("");
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (sid: string) =>
      api(`/app/api/classrooms/${room.id}/staff/${sid}`, { method: "DELETE" }),
    onSuccess: () => void refresh(),
  });

  return (
    <div className="max-w-2xl space-y-4">
      <SectionHeading
        icon={UsersRound}
        title={t("staff.title")}
        count={room.staff.length}
        description={room.isOwner ? null : t("staff.readonly")}
      />
      <Card>
        {room.staff.length === 0 ? (
          <EmptyState icon={UsersRound} title={t("staff.empty")} className="py-10" />
        ) : (
          <ul className="divide-y divide-line">
            {room.staff.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    {m.claimed ? `${m.givenName ?? ""} ${m.familyName ?? ""}`.trim() || m.email : m.email}
                  </p>
                  <p className="text-[13px] text-fg-muted">
                    {m.claimed ? m.email : t("staff.pending")}
                  </p>
                </div>
                <Badge tone="zinc">{t(`staff.role.${m.role}`)}</Badge>
                {room.isOwner ? (
                  <Menu
                    label={t("staff.remove")}
                    items={[
                      {
                        label: t("staff.remove"),
                        icon: UserMinus,
                        danger: true,
                        onSelect: async () => {
                          if (
                            await confirm({
                              title: t("staff.confirmRemove", { email: m.email }),
                              confirmLabel: t("staff.remove"),
                              cancelLabel: t("common.cancel"),
                              danger: true,
                            })
                          ) {
                            remove.mutate(m.id);
                          }
                        },
                      },
                    ]}
                  />
                ) : null}
                {remove.isError && remove.variables === m.id ? (
                  <p className="w-full text-[13px] text-danger">
                    {apiErrorMessage(remove.error, "Could not remove this member.")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {room.isOwner ? (
          <form
            className="flex flex-wrap items-end gap-3 border-t border-line bg-surface-2/50 px-5 py-4"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <div className="min-w-56 flex-1">
              <Field
                label={t("staff.email")}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="prenom.nom@heig-vd.ch"
                required
                fullWidth
              />
            </div>
            <Segmented
              name="staff-role"
              value={role}
              onChange={setRole}
              options={[
                { value: "teacher", label: t("staff.role.teacher") },
                { value: "assistant", label: t("staff.role.assistant") },
              ]}
            />
            <Button type="submit" variant="secondary" loading={add.isPending} disabled={email.trim() === ""}>
              <UserPlus /> {t("staff.add")}
            </Button>
            {add.isError ? (
              <p className="w-full text-sm text-danger">
                {apiErrorMessage(add.error, "Could not add this e-mail")}
              </p>
            ) : null}
          </form>
        ) : null}
      </Card>
    </div>
  );
}

function StudentsTab({ room }: { room: ClassroomDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe();
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);
  const join = useMutation({
    mutationFn: () => api(`/app/api/classrooms/${room.id}/self-enroll`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["classroom", room.id] });
      void qc.invalidateQueries({ queryKey: ["classrooms"] });
    },
  });
  // The teacher can take a (staff) seat to walk the student flow themselves.
  const myEmail = me.data?.email.toLowerCase();
  const joined = myEmail != null && room.roster.some((e) => e.email.toLowerCase() === myEmail);
  const claimed = room.roster.filter((r) => r.status === "claimed").length;
  const shown = fuzzyFilter(query, room.roster, (r) => `${r.nom} ${r.prenom} ${r.email} ${r.githubLogin ?? ""}`);

  return (
    <div className="space-y-4">
      <SectionHeading
        icon={Users}
        title="Students"
        count={room.roster.length}
        help="roster"
        description={room.roster.length ? `${claimed} claimed their seat · ${room.roster.length - claimed} pending` : null}
        actions={
          <>
            {joined ? (
              <span className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted">
                <GraduationCap className="size-4 text-fg-faint" /> {t("roster.joined")}
              </span>
            ) : (
              <Button variant="secondary" onClick={() => join.mutate()} loading={join.isPending}>
                <GraduationCap /> {t("roster.join")}
              </Button>
            )}
            {/* The empty state below already carries this action; two accent
                buttons for the same thing is one too many. */}
            {room.roster.length ? (
              <Button onClick={() => setImporting(true)}>
                <UserPlus /> Add students
              </Button>
            ) : null}
          </>
        }
      />
      {join.isError ? (
        <p className="text-[13px] text-danger">
          {apiErrorMessage(join.error, "Could not give you a seat in this classroom.")}
        </p>
      ) : null}
      {room.roster.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title="No students yet"
            action={
              <Button onClick={() => setImporting(true)}>
                <UserPlus /> Add students
              </Button>
            }
          >
            Import the student list from an Excel or CSV file, or add them one by one.
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3">
            <SearchInput
              placeholder="Search students…"
              aria-label="Search students"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full sm:w-64"
            />
            {/* A long roster never paginates: it says how much of it you see. */}
            <span className="text-[13px] text-fg-muted">
              {shown.length === room.roster.length
                ? `${room.roster.length} students`
                : `${shown.length} of ${room.roster.length} students`}
            </span>
          </div>
          {shown.length ? (
            <RosterTable classroomId={room.id} roster={shown} />
          ) : (
            <EmptyState icon={Users} title="No student matches" className="py-10">
              Search by last name, first name, e-mail or GitHub login.
            </EmptyState>
          )}
        </Card>
      )}
      {importing ? <RosterImport classroomId={room.id} onClose={() => setImporting(false)} /> : null}
    </div>
  );
}

export function ClassroomView({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
  const t = useT();
  const toast = useToast();
  const [tab, setTab] = useSearchParam("tab", "assignments");
  const detail = useQuery<ClassroomDetail>({
    queryKey: ["classroom", id],
    queryFn: () => api(`/app/api/classrooms/${id}`),
  });
  // Grade sheet (issue #4): roster x graded assignments, the sheet a GAPS
  // import starts from. Fetched on click — nothing to prefetch on open.
  const gradeSheet = useMutation({
    mutationFn: async () => {
      const data = await api<ClassroomGradesPayload>(`/app/api/classrooms/${id}/grades`);
      const XLSX = await import("xlsx");
      const header = [
        "Nom",
        "Prénom",
        "Email",
        ...data.assignments.map((a) =>
          a.gradesValidatedAt ? a.name : `${a.name} (not validated)`,
        ),
      ];
      const rows = data.students.map((s) => [
        s.nom,
        s.prenom,
        s.email,
        ...data.assignments.map((a) => s.points[a.id] ?? ""),
      ]);
      const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Notes");
      XLSX.writeFile(wb, `${data.classroom.name} — grades.xlsx`);
    },
    // The action lives in the overflow menu, which is gone by the time it
    // fails: the toast is the only place left to say so.
    onError: (err) => toast(apiErrorMessage(err, "Could not build the grade sheet."), "error"),
  });

  if (detail.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-10 w-full" />
        <Spinner className="py-16" />
      </div>
    );
  }
  if (!detail.data) {
    // A 404 is an answer, not a failure: it gets its own way out.
    const gone = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <div className="space-y-6">
        <Breadcrumb
          items={[
            { label: t("nav.classrooms"), onClick: () => navigate({ view: "home" }) },
            { label: gone ? "Unknown classroom" : "Classroom" },
          ]}
        />
        {gone ? (
          <Card>
            <EmptyState
              icon={XCircle}
              title="Classroom not found"
              action={
                <Button variant="secondary" onClick={() => navigate({ view: "home" })}>
                  Back to my classrooms
                </Button>
              }
            >
              It was deleted, or the link points at a classroom you cannot open.
            </EmptyState>
          </Card>
        ) : (
          <QueryError
            title="Could not load this classroom"
            error={detail.error}
            onRetry={() => void detail.refetch()}
            retrying={detail.isFetching}
          />
        )}
      </div>
    );
  }
  const room = detail.data;
  const orgMissing =
    room.org != null &&
    room.org.installationId === null &&
    (room.org.exists === false || room.org.status === "degraded");
  const installed = room.org?.installationId != null;

  const status = installed ? (
    <Badge tone="green" icon={CheckCircle2}>
      GitHub App installed
    </Badge>
  ) : orgMissing ? (
    <Badge tone="red" icon={XCircle}>
      organization not found
    </Badge>
  ) : (
    <Badge tone="amber" icon={AlertTriangle}>
      GitHub App not installed
    </Badge>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Breadcrumb
            items={[
              { label: t("nav.classrooms"), onClick: () => navigate({ view: "home" }) },
              { label: room.name },
            ]}
          />
        }
        title={
          <span className="flex items-center gap-3">
            {room.org ? <OrgAvatar login={room.org.login} className="size-9 rounded-[10px]" /> : null}
            {room.name}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            {room.org ? (
              <a
                href={`https://github.com/${room.org.login}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:text-fg hover:underline"
              >
                {room.org.login} <ExternalLink className="size-3" />
              </a>
            ) : null}
            {status}
          </span>
        }
        actions={
          <Menu
            label="Classroom actions"
            items={[
              {
                label: t("classroom.gradeSheet"),
                icon: FileSpreadsheet,
                onSelect: () => gradeSheet.mutate(),
                disabled: gradeSheet.isPending,
              },
              { label: "Settings", icon: SettingsIcon, onSelect: () => setTab("settings") },
            ]}
          />
        }
      />

      {orgMissing ? (
        <Alert tone="danger" icon={XCircle} title="Organization not found">
          The GitHub organization <span className="font-mono font-medium">{room.org!.login}</span>{" "}
          no longer exists — it was deleted or renamed on GitHub. Grades and the roster remain
          available here, but repositories, assignments and grading are unreachable. Recreate the
          organization under the same name and reinstall the GitHub App, or create a new
          classroom on another organization.
        </Alert>
      ) : !installed ? (
        <InstallWizard room={room} />
      ) : null}

      {installed && room.org?.plan === "free" ? (
        <Alert
          tone="warning"
          icon={AlertTriangle}
          title={`${room.org.login} is on the GitHub Free plan`}
          action={
            <LinkButton
              size="sm"
              href="https://education.github.com/globalcampus/teacher"
              target="_blank"
              rel="noreferrer"
            >
              Request the education upgrade
            </LinkButton>
          }
        >
          Private repositories get no branch protection (a student can force-push or delete their
          history), the deadline falls back to archiving, and organization secrets are not
          delivered, so the automatic LLM review fails silently. GitHub Team is free for teachers
          through GitHub Education.
        </Alert>
      ) : null}

      {installed && room.org?.llmSecret === "missing" ? (
        <Alert
          tone="warning"
          icon={AlertTriangle}
          title="ANTHROPIC_API_KEY is missing on the organization"
          action={
            <LinkButton
              size="sm"
              href={`https://github.com/organizations/${room.org.login}/settings/secrets/actions`}
              target="_blank"
              rel="noreferrer"
            >
              Open the organization secrets
            </LinkButton>
          }
        >
          The automatic LLM reviews (deadline and milestones) will fail until the secret exists.
          Add it under Organization settings → Secrets and variables → Actions, with access to
          private repositories.
        </Alert>
      ) : null}

      <Tabs
        value={tab as Tab}
        onChange={setTab}
        idPrefix="classroom"
        label="Classroom sections"
        items={[
          { value: "assignments", label: "Assignments", icon: ClipboardList },
          { value: "students", label: "Students", icon: Users, count: room.roster.length },
          { value: "staff", label: t("staff.title"), icon: UsersRound, count: room.staff.length },
          { value: "settings", label: "Settings", icon: SettingsIcon },
        ]}
      />

      {/* One panel, named after the selected tab: `idPrefix` on Tabs makes
          each tab point at it with aria-controls. */}
      <div role="tabpanel" id={`classroom-panel-${tab}`} aria-labelledby={`classroom-tab-${tab}`}>
        {tab === "students" ? (
          <StudentsTab room={room} />
        ) : tab === "staff" ? (
          <StaffTab room={room} />
        ) : tab === "settings" ? (
          <SettingsTab room={room} onGone={() => navigate({ view: "home" })} />
        ) : (
          <AssignmentsSection
            classroomId={room.id}
            appInstalled={installed}
            onOpenAssignment={(aid) =>
              navigate({ view: "assignment", classroomId: room.id, assignmentId: aid })
            }
          />
        )}
      </div>
    </div>
  );
}
