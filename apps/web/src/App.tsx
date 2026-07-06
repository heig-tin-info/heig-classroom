import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CheckCircle2,
  ClipboardList,
  Clock,
  FolderGit2,
  GraduationCap,
  LogOut,
  Moon,
  Plus,
  School,
  Sun,
  Upload,
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
import { applyTheme, initialTheme, type Theme } from "./theme";
import { Badge, Button, Card, EmptyState, Field, GithubIcon } from "./ui";

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
          Travaux pratiques sur GitHub : dépôts individuels, deadlines automatiques et
          note indicative après chaque passage du CI.
        </p>
      </div>
      <a
        href="/app/auth/login"
        className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 font-medium text-white shadow-sm transition-colors hover:bg-accent-hover"
      >
        Se connecter avec Switch edu-ID
      </a>
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        HEIG-VD — Département TIN
      </p>
    </main>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  return (
    <Button
      variant="ghost"
      aria-label="Basculer le thème"
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

function Header({ me }: { me: Me }) {
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api("/app/auth/logout", { method: "POST" }),
    onSuccess: () => qc.setQueryData(["me"], null),
  });
  return (
    <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
        <Logo className="size-5" />
        <span className="font-semibold tracking-tight">HEIG Classroom</span>
        <span className="flex-1" />
        <Badge tone="zinc" icon={me.role === "teacher" ? School : GraduationCap}>
          {me.role === "teacher" ? "enseignant" : "étudiant"}
        </Badge>
        <span className="hidden text-sm text-zinc-500 sm:inline dark:text-zinc-400">
          {me.givenName} {me.familyName}
        </span>
        <ThemeToggle />
        <Button variant="ghost" aria-label="Se déconnecter" onClick={() => logout.mutate()}>
          <LogOut className="size-4" />
        </Button>
      </div>
    </header>
  );
}

function RosterTable({ roster }: { roster: RosterEntry[] }) {
  if (roster.length === 0) {
    return (
      <EmptyState icon={Users} title="Roster vide">
        Importe la liste des étudiants au format CSV pour démarrer.
      </EmptyState>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            <th className="px-3 py-2 font-medium">Étudiant</th>
            <th className="px-3 py-2 font-medium">E-mail</th>
            <th className="px-3 py-2 font-medium">Statut</th>
            <th className="px-3 py-2 font-medium">GitHub</th>
            <th className="px-3 py-2 font-medium">Dernière connexion</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {roster.map((r) => (
            <tr key={r.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
              <td className="px-3 py-2 font-medium">
                {r.prenom} {r.nom}
              </td>
              <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">{r.email}</td>
              <td className="px-3 py-2">
                {r.conflictFlag ? (
                  <Badge tone="red" icon={AlertTriangle}>
                    conflit
                  </Badge>
                ) : r.status === "claimed" ? (
                  <Badge tone="green" icon={CheckCircle2}>
                    réclamé
                  </Badge>
                ) : (
                  <Badge tone="amber" icon={Clock}>
                    en attente
                  </Badge>
                )}
              </td>
              <td className="px-3 py-2">
                {r.githubLogin ? (
                  <span className="inline-flex items-center gap-1">
                    <GithubIcon className="size-3.5" /> {r.githubLogin}
                  </span>
                ) : (
                  <span className="text-zinc-400">—</span>
                )}
              </td>
              <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">
                {r.lastLoginAt ? new Date(r.lastLoginAt).toLocaleString("fr-CH") : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClassroomView({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery<ClassroomDetail>({
    queryKey: ["classroom", id],
    queryFn: () => api(`/app/api/classrooms/${id}`),
  });
  const [csv, setCsv] = useState("nom,prenom,email\n");
  const importRoster = useMutation({
    mutationFn: () => api(`/app/api/classrooms/${id}/roster`, { method: "POST", csv }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["classroom", id] }),
  });

  if (detail.isLoading) return null;
  if (!detail.data) return <p>Classroom introuvable.</p>;
  const room = detail.data;
  const importErrors =
    importRoster.isError && importRoster.error instanceof ApiError
      ? ((importRoster.error.body as { errors?: { line: number; message: string }[] })
          ?.errors ?? [])
      : [];

  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        <ArrowLeft className="size-4" /> Classrooms
      </button>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{room.name}</h1>
        <Badge tone="zinc" icon={Building2}>
          {room.org?.login}
        </Badge>
        {room.org?.installationId ? (
          <Badge tone="green" icon={CheckCircle2}>
            GitHub App installée
          </Badge>
        ) : (
          <Badge tone="amber" icon={Clock}>
            GitHub App non installée
          </Badge>
        )}
      </div>

      <Card>
        <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <Users className="size-4 text-zinc-400" />
          <h2 className="font-medium">Roster</h2>
        </div>
        <RosterTable roster={room.roster} />
      </Card>

      <Card className="p-4">
        <div className="mb-2 flex items-center gap-2">
          <Upload className="size-4 text-zinc-400" />
          <h2 className="font-medium">Importer le roster</h2>
          <span className="text-xs text-zinc-400">
            CSV — colonnes nom, prenom, email (séparateur , ou ;)
          </span>
        </div>
        <textarea
          aria-label="CSV du roster"
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          className="min-h-28 w-full rounded-lg border border-zinc-300 bg-white p-3 font-mono text-sm shadow-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 dark:border-zinc-700 dark:bg-zinc-950"
        />
        <div className="mt-2 flex items-center gap-3">
          <Button onClick={() => importRoster.mutate()} disabled={importRoster.isPending}>
            <Upload className="size-4" /> Importer
          </Button>
          {importRoster.isSuccess ? (
            <span className="inline-flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-4" /> Import effectué
            </span>
          ) : null}
        </div>
        {importErrors.length > 0 ? (
          <ul className="mt-2 space-y-1 text-sm text-red-600 dark:text-red-400">
            {importErrors.map((e, i) => (
              <li key={i} className="flex items-center gap-1">
                <AlertTriangle className="size-3.5" /> ligne {e.line} : {e.message}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </div>
  );
}

function TeacherHome() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const rooms = useQuery<ClassroomSummary[]>({
    queryKey: ["classrooms"],
    queryFn: () => api("/app/api/classrooms"),
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

  if (selected) return <ClassroomView id={selected} onBack={() => setSelected(null)} />;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Mes classrooms</h1>

      {rooms.data?.length ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {rooms.data.map((c) => (
            <button key={c.id} onClick={() => setSelected(c.id)} className="text-left">
              <Card className="p-4 transition-shadow hover:shadow-md">
                <div className="flex items-center gap-2">
                  <FolderGit2 className="size-5 text-accent" />
                  <span className="font-medium">{c.name}</span>
                </div>
                <p className="mt-1 flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
                  <Building2 className="size-3.5" /> {c.orgLogin}
                </p>
                <div className="mt-3 flex gap-2">
                  <Badge tone="zinc" icon={Users}>
                    {c.students} étudiant{c.students > 1 ? "s" : ""}
                  </Badge>
                  <Badge tone="green" icon={CheckCircle2}>
                    {c.claimed} réclamé{c.claimed > 1 ? "s" : ""}
                  </Badge>
                </div>
              </Card>
            </button>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState icon={School} title="Aucune classroom">
            Crée ta première classroom pour distribuer des assignments à tes étudiants.
          </EmptyState>
        </Card>
      )}

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <Plus className="size-4 text-zinc-400" />
          <h2 className="font-medium">Nouvelle classroom</h2>
        </div>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field
            label="Nom"
            placeholder="PRG1 2026"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Field
            label="Organisation GitHub"
            placeholder="heig-tin-info"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            required
          />
          <Button disabled={create.isPending}>
            <Plus className="size-4" /> Créer
          </Button>
        </form>
        {create.isError ? (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">Création refusée.</p>
        ) : null}
      </Card>
    </div>
  );
}

function StudentHome({ me }: { me: Me }) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Mes assignments</h1>
      <Card>
        <EmptyState icon={ClipboardList} title="Aucun assignment pour l'instant">
          Ils apparaîtront ici dès que ton enseignant en publiera. En attendant,
          {me.githubLogin
            ? " tout est prêt de ton côté."
            : " pense à lier ton compte GitHub (bientôt disponible)."}
        </EmptyState>
      </Card>
    </div>
  );
}

export default function App() {
  const me = useMe();
  if (me.isLoading) return null;
  if (!me.data) return <Landing />;
  return (
    <div className="min-h-dvh">
      <Header me={me.data} />
      <main className="mx-auto max-w-5xl px-4 py-6">
        {me.data.role === "teacher" ? <TeacherHome /> : <StudentHome me={me.data} />}
      </main>
    </div>
  );
}
