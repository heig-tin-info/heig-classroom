import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  Building2,
  CheckCircle2,
  Clock,
  GraduationCap,
  Settings as SettingsIcon,
  Trash2,
  Users,
  XCircle,
} from "lucide-react";
import { useState } from "react";

import type { ClassroomDetail } from "@hgc/contracts";

import { api, useMe } from "./api";
import { AssignmentsCard } from "./AssignmentsCard";
import { Breadcrumb } from "./Breadcrumb";
import { HelpIcon } from "./help";
import { useT } from "./i18n";
import type { Route } from "./router";
import { RosterImport } from "./RosterImport";
import { RosterTable } from "./RosterTable";
import { Badge, Button, Card, Field, GithubIcon, Modal, OrgAvatar, Tip } from "./ui";

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
  const StepDot = ({ n, done }: { n: number; done?: boolean }) =>
    done ? (
      <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400">
        <CheckCircle2 className="size-3.5" />
      </span>
    ) : (
      <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
        {n}
      </span>
    );
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <GithubIcon className="size-4 text-zinc-400" />
        <h2 className="font-medium">Connect GitHub</h2>
      </div>
      <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
        Assignments need the HEIG Classroom GitHub App installed on{" "}
        <span className="font-medium text-zinc-700 dark:text-zinc-200">{room.org?.login}</span>:
        it creates the student repositories, receives their pushes and collects the grades.
      </p>
      <ol className="space-y-2.5 text-sm">
        <li className="flex items-start gap-2.5">
          <StepDot n={1} done />
          <span className="text-zinc-500 dark:text-zinc-400">
            The organization <span className="font-mono">{room.org?.login}</span> exists on
            GitHub.
          </span>
        </li>
        <li className="flex items-start gap-2.5">
          <StepDot n={2} />
          <span className="flex flex-wrap items-center gap-2">
            {installUrl ? (
              <a
                href={installUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-all duration-150 hover:-translate-y-px hover:bg-accent-hover"
              >
                <GithubIcon className="size-4" /> Install the GitHub App
              </a>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">
                The platform's GitHub App is not configured — contact the administrator.
              </span>
            )}
            <span className="text-xs text-zinc-400">
              You must be an owner of the organization. Pick “All repositories”.
            </span>
          </span>
        </li>
        <li className="flex items-start gap-2.5">
          <StepDot n={3} />
          <span className="text-zinc-500 dark:text-zinc-400">
            Validate on GitHub — the badge here turns green automatically.
          </span>
        </li>
      </ol>
    </Card>
  );
}

/**
 * The classroom's GitHub organization no longer exists (deleted or renamed):
 * detected by the live existence check on open — with no installation left,
 * GitHub sends no webhook for it. Grades and roster stay readable; anything
 * touching GitHub is dead until the org is recreated or the classroom moves.
 */
function OrgMissing({ orgLogin }: { orgLogin: string }) {
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <XCircle className="size-4 text-red-500" />
        <h2 className="font-medium text-red-700 dark:text-red-400">Organization not found</h2>
      </div>
      <p className="text-sm text-zinc-600 dark:text-zinc-300">
        The GitHub organization <span className="font-mono font-medium">{orgLogin}</span> no
        longer exists — it was deleted or renamed on GitHub. Grades and the roster remain
        available here, but repositories, assignments and grading are unreachable.
      </p>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        Recreate the organization under the same name and reinstall the GitHub App, or create a
        new classroom on another organization. If the organization was only renamed while the
        App was uninstalled, recreate the link by reinstalling the App on the new name.
      </p>
    </Card>
  );
}

/**
 * The ANTHROPIC_API_KEY organization secret is missing: every LLM review
 * (deadline grade-final, milestones) will fail on this org until the teacher
 * creates it. Detected live through the App's org Secrets read permission.
 */
function LlmKeyWarning({ orgLogin }: { orgLogin: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
      <AlertTriangle className="size-4 shrink-0" />
      <span>
        The organization secret <span className="font-mono font-medium">ANTHROPIC_API_KEY</span>{" "}
        is missing on <span className="font-medium">{orgLogin}</span>: the automatic LLM reviews
        (deadline and milestones) will fail. Add it under Organization settings → Secrets and
        variables → Actions, with access to private repositories.
      </span>
      <span className="flex-1" />
      <a
        href={`https://github.com/organizations/${orgLogin}/settings/secrets/actions`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 shadow-sm transition-colors hover:bg-amber-100 dark:border-amber-500/40 dark:bg-transparent dark:text-amber-200 dark:hover:bg-amber-500/10"
      >
        Open the org secrets
      </a>
    </div>
  );
}

/**
 * Organization secrets never reach the private repositories of a Free
 * organization: the LLM review tier fails silently (empty ANTHROPIC_API_KEY).
 * Teachers get GitHub Team at no cost through GitHub Education.
 */
function FreePlanWarning({ orgLogin }: { orgLogin: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
      <AlertTriangle className="size-4 shrink-0" />
      <span>
        <span className="font-medium">{orgLogin}</span> is on the GitHub <span className="font-medium">Free</span> plan:
        organization secrets are not delivered to private repositories, so the automatic LLM
        review will fail silently. As a teacher you can upgrade the organization to GitHub Team
        for free through GitHub Education.
      </span>
      <span className="flex-1" />
      <a
        href="https://education.github.com/globalcampus/teacher"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 shadow-sm transition-colors hover:bg-amber-100 dark:border-amber-500/40 dark:bg-transparent dark:text-amber-200 dark:hover:bg-amber-500/10"
      >
        Request the education upgrade
      </a>
    </div>
  );
}

export function ClassroomView({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe();
  const [showSettings, setShowSettings] = useState(false);
  const detail = useQuery<ClassroomDetail>({
    queryKey: ["classroom", id],
    queryFn: () => api(`/app/api/classrooms/${id}`),
  });
  const join = useMutation({
    mutationFn: () => api(`/app/api/classrooms/${id}/self-enroll`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["classroom", id] });
      void qc.invalidateQueries({ queryKey: ["classrooms"] });
    },
  });

  if (detail.isLoading) return null;
  if (!detail.data) return <p>Classroom not found.</p>;
  const room = detail.data;
  // The teacher can take a (staff) seat to walk the student flow themselves.
  const myEmail = me.data?.email.toLowerCase();
  const joined = myEmail != null && room.roster.some((e) => e.email.toLowerCase() === myEmail);
  const orgMissing =
    room.org != null &&
    room.org.installationId === null &&
    (room.org.exists === false || room.org.status === "degraded");

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
        ) : orgMissing ? (
          <Badge tone="red" icon={XCircle}>
            Organization not found on GitHub
          </Badge>
        ) : (
          <Badge tone="amber" icon={Clock}>
            GitHub App not installed
          </Badge>
        )}
        <span className="flex-1" />
        <Tip label="Classroom settings">
          <Button variant="ghost" aria-label="Classroom settings" onClick={() => setShowSettings(true)}>
            <SettingsIcon className="size-4" />
          </Button>
        </Tip>
      </div>

      {showSettings ? (
        <ClassroomSettings room={room} onClose={() => setShowSettings(false)} onGone={() => navigate({ view: "home" })} />
      ) : null}

      {orgMissing ? (
        <OrgMissing orgLogin={room.org!.login} />
      ) : !room.org?.installationId ? (
        <InstallWizard room={room} />
      ) : null}

      {room.org?.installationId && room.org.plan === "free" ? (
        <FreePlanWarning orgLogin={room.org.login} />
      ) : null}

      {room.org?.installationId && room.org.llmSecret === "missing" ? (
        <LlmKeyWarning orgLogin={room.org.login} />
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
          <span className="flex-1" />
          {joined ? (
            <Tip label={t("roster.joined")}>
              <span className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
                <GraduationCap className="size-3.5" /> {t("roster.staff")}
              </span>
            </Tip>
          ) : (
            <Button variant="subtle" onClick={() => join.mutate()} disabled={join.isPending}>
              <GraduationCap className="size-4" /> {t("roster.join")}
            </Button>
          )}
        </div>
        <RosterTable classroomId={room.id} roster={room.roster} />
      </Card>

      <RosterImport classroomId={room.id} />
    </div>
  );
}
