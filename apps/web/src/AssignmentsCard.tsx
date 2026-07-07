import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  ClipboardList,
  ExternalLink,
  GitBranch,
  Loader2,
  Lock,
  Plus,
  Shield,
} from "lucide-react";
import { useState } from "react";

import { api, ApiError } from "./api";
import { Badge, Button, Card, EmptyState, Field, GithubIcon } from "./ui";

interface Assignment {
  id: string;
  name: string;
  slug: string;
  state: "draft" | "published" | "locked";
  startAt: string;
  deadlineAt: string;
  sourceFullName: string;
  squashedFullName: string | null;
  sourceStrategy: "whole" | "squash";
  deadlineStrategy: "lock" | "commit";
  branches: string[];
  protectedFiles: string[];
}

interface OrgRepo {
  name: string;
  defaultBranch: string;
}

interface RepoDefaults {
  defaultBranch: string;
  protectedFiles: string[];
}

const dt = (iso: string) =>
  new Date(iso).toLocaleString("fr-CH", { dateStyle: "short", timeStyle: "short" });

function StateBadge({ state }: { state: Assignment["state"] }) {
  if (state === "published") return <Badge tone="green">publié</Badge>;
  if (state === "locked") return <Badge tone="red" icon={Lock}>verrouillé</Badge>;
  return <Badge tone="zinc">brouillon</Badge>;
}

function GhLink({ fullName }: { fullName: string }) {
  return (
    <a
      href={`https://github.com/${fullName}`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-zinc-500 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
    >
      <GithubIcon className="size-3.5" />
      {fullName.split("/")[1]}
      <ExternalLink className="size-3" />
    </a>
  );
}

/** Interprète un input datetime-local (heure locale) en ISO UTC. */
const toIso = (local: string) => new Date(local).toISOString();

function CreateForm({ classroomId, onDone }: { classroomId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [sourceRepo, setSourceRepo] = useState("");
  const [startAt, setStartAt] = useState("");
  const [deadlineAt, setDeadlineAt] = useState("");
  const [sourceStrategy, setSourceStrategy] = useState<"squash" | "whole">("squash");
  const [deadlineStrategy, setDeadlineStrategy] = useState<"lock" | "commit">("lock");
  const [protectedFiles, setProtectedFiles] = useState<string[]>([]);

  const repos = useQuery<OrgRepo[]>({
    queryKey: ["org-repos", classroomId],
    queryFn: () => api(`/app/api/classrooms/${classroomId}/org-repos`),
  });
  const defaults = useQuery<RepoDefaults>({
    queryKey: ["repo-defaults", classroomId, sourceRepo],
    enabled: sourceRepo !== "",
    queryFn: async () => {
      const d = await api<RepoDefaults>(
        `/app/api/classrooms/${classroomId}/org-repos/${sourceRepo}/defaults`,
      );
      setProtectedFiles(d.protectedFiles);
      return d;
    },
  });

  const create = useMutation({
    mutationFn: () =>
      api(`/app/api/classrooms/${classroomId}/assignments`, {
        method: "POST",
        body: JSON.stringify({
          name,
          sourceRepo,
          startAt: toIso(startAt),
          deadlineAt: toIso(deadlineAt),
          sourceStrategy,
          deadlineStrategy,
          protectedFiles,
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["assignments", classroomId] });
      onDone();
    },
  });
  const error =
    create.isError && create.error instanceof ApiError
      ? ((create.error.body as { message?: string })?.message ?? "Création refusée")
      : null;

  const select =
    "rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-accent focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

  return (
    <form
      className="space-y-4 border-t border-zinc-100 pt-4 dark:border-zinc-800"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Nom"
          placeholder="Labo 1 — Pointeurs"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            Dépôt source (énoncé)
          </span>
          <select
            className={select}
            value={sourceRepo}
            onChange={(e) => setSourceRepo(e.target.value)}
            required
          >
            <option value="" disabled>
              {repos.isLoading ? "Chargement…" : "Choisir un dépôt de l'organisation"}
            </option>
            {repos.data?.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        {defaults.data ? (
          <Badge tone="zinc" icon={GitBranch}>
            {defaults.data.defaultBranch}
          </Badge>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Début"
          type="datetime-local"
          value={startAt}
          onChange={(e) => setStartAt(e.target.value)}
          required
        />
        <Field
          label="Deadline"
          type="datetime-local"
          value={deadlineAt}
          onChange={(e) => setDeadlineAt(e.target.value)}
          required
        />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Source distribuée</span>
          <select
            className={select}
            value={sourceStrategy}
            onChange={(e) => setSourceStrategy(e.target.value as "squash" | "whole")}
          >
            <option value="squash">Squash (un commit initial)</option>
            <option value="whole">Whole (tout l'historique)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">À la deadline</span>
          <select
            className={select}
            value={deadlineStrategy}
            onChange={(e) => setDeadlineStrategy(e.target.value as "lock" | "commit")}
          >
            <option value="lock">Verrouiller le dépôt</option>
            <option value="commit">Commit de deadline</option>
          </select>
        </label>
      </div>

      {defaults.data ? (
        <div className="text-sm">
          <span className="mb-1 flex items-center gap-1 font-medium text-zinc-700 dark:text-zinc-300">
            <Shield className="size-3.5" /> Fichiers protégés (revert automatique)
          </span>
          {defaults.data.protectedFiles.length === 0 ? (
            <p className="text-zinc-400">
              Aucun fichier protégeable détecté (criteria.yml, README.md, grading.yml).
            </p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {defaults.data.protectedFiles.map((f) => (
                <label key={f} className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={protectedFiles.includes(f)}
                    onChange={(e) =>
                      setProtectedFiles((prev) =>
                        e.target.checked ? [...prev, f] : prev.filter((x) => x !== f),
                      )
                    }
                    className="accent-accent"
                  />
                  <code className="text-xs">{f}</code>
                </label>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <Button disabled={create.isPending || !sourceRepo}>
          {create.isPending ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Création du dépôt squashed…
            </>
          ) : (
            <>
              <Plus className="size-4" /> Créer l'assignment
            </>
          )}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Annuler
        </Button>
        {error ? <span className="text-sm text-red-600 dark:text-red-400">{error}</span> : null}
      </div>
    </form>
  );
}

export function AssignmentsCard({
  classroomId,
  appInstalled,
}: {
  classroomId: string;
  appInstalled: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const list = useQuery<Assignment[]>({
    queryKey: ["assignments", classroomId],
    queryFn: () => api(`/app/api/classrooms/${classroomId}/assignments`),
  });

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <ClipboardList className="size-4 text-zinc-400" />
        <h2 className="font-medium">Assignments</h2>
        <span className="flex-1" />
        {appInstalled && !creating ? (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> Nouvel assignment
          </Button>
        ) : null}
      </div>

      {!appInstalled ? (
        <p className="text-sm text-amber-600 dark:text-amber-400">
          Installe la GitHub App sur l'organisation pour créer des assignments.
        </p>
      ) : null}

      {list.data?.length ? (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {list.data.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
              <span className="font-medium">{a.name}</span>
              <StateBadge state={a.state} />
              <span className="inline-flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
                <CalendarClock className="size-3.5" />
                {dt(a.startAt)} → {dt(a.deadlineAt)}
              </span>
              <span className="flex-1" />
              <span className="flex items-center gap-3 text-sm">
                <GhLink fullName={a.sourceFullName} />
                {a.squashedFullName ? <GhLink fullName={a.squashedFullName} /> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : !creating && appInstalled ? (
        <EmptyState icon={ClipboardList} title="Aucun assignment">
          Crée le premier assignment à partir d'un dépôt source de l'organisation.
        </EmptyState>
      ) : null}

      {creating ? (
        <CreateForm classroomId={classroomId} onDone={() => setCreating(false)} />
      ) : null}
    </Card>
  );
}
