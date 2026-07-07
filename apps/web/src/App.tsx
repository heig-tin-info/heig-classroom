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
  Loader2,
  LogOut,
  Moon,
  Plus,
  School,
  Sun,
  Users,
  X,
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
import { AssignmentsCard } from "./AssignmentsCard";
import { RosterImport } from "./RosterImport";
import { RosterTable } from "./RosterTable";
import { applyTheme, initialTheme, type Theme } from "./theme";
import { Badge, Button, Card, EmptyState, Field, GithubIcon, isoDateTime } from "./ui";

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

function GithubLink({ me }: { me: Me }) {
  const qc = useQueryClient();
  const unlink = useMutation({
    mutationFn: () => api("/app/auth/github/unlink", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  if (me.githubLogin) {
    return (
      <span className="inline-flex items-center gap-1">
        <Badge tone="green" icon={GithubIcon}>
          {me.githubLogin}
        </Badge>
        <Button
          variant="ghost"
          aria-label="Unlink GitHub account"
          title="Unlink GitHub account"
          onClick={() => unlink.mutate()}
        >
          <X className="size-3.5" />
        </Button>
      </span>
    );
  }
  return (
    <a
      href="/app/auth/github/link"
      className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-800 transition-all duration-150 hover:-translate-y-px hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
    >
      <GithubIcon className="size-4" /> Link GitHub
    </a>
  );
}

/** Bannière de retour du flux de liaison (?github=linked|conflict|error). */
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

function Header({ me }: { me: Me }) {
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api("/app/auth/logout", { method: "POST" }),
    onSuccess: () => qc.setQueryData(["me"], null),
  });
  return (
    <header className="sticky top-0 z-10 bg-white/80 shadow-[0_1px_8px_rgb(0_0_0/0.06)] backdrop-blur dark:bg-zinc-950/80 dark:shadow-[0_1px_8px_rgb(0_0_0/0.4)]">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
        <Logo className="size-5" />
        <span className="font-semibold tracking-tight">HEIG Classroom</span>
        <span className="flex-1" />
        <GithubLink me={me} />
        <Badge tone="zinc" icon={me.role === "teacher" ? School : GraduationCap}>
          {me.role}
        </Badge>
        <span className="hidden text-sm text-zinc-500 sm:inline dark:text-zinc-400">
          {me.givenName} {me.familyName}
        </span>
        <ThemeToggle />
        <Button variant="ghost" aria-label="Sign out" onClick={() => logout.mutate()}>
          <LogOut className="size-4" />
        </Button>
      </div>
    </header>
  );
}

function ClassroomView({ id, onBack }: { id: string; onBack: () => void }) {
  const detail = useQuery<ClassroomDetail>({
    queryKey: ["classroom", id],
    queryFn: () => api(`/app/api/classrooms/${id}`),
  });

  if (detail.isLoading) return null;
  if (!detail.data) return <p>Classroom not found.</p>;
  const room = detail.data;

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
            GitHub App installed
          </Badge>
        ) : (
          <Badge tone="amber" icon={Clock}>
            GitHub App not installed
          </Badge>
        )}
      </div>

      <AssignmentsCard classroomId={room.id} appInstalled={room.org?.installationId != null} />

      <Card>
        <div className="flex items-center gap-2 border-b border-zinc-100/80 px-4 py-3 dark:border-zinc-800/60">
          <Users className="size-4 text-zinc-400" />
          <h2 className="font-medium">Roster</h2>
        </div>
        <RosterTable classroomId={room.id} roster={room.roster} />
      </Card>

      <RosterImport classroomId={room.id} />
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
      <h1 className="text-2xl font-semibold tracking-tight">My classrooms</h1>

      {rooms.data?.length ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {rooms.data.map((c) => (
            <button key={c.id} onClick={() => setSelected(c.id)} className="text-left">
              <Card className="p-4 hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgb(0_0_0/0.06),0_12px_28px_rgb(0_0_0/0.08)]">
                <div className="flex items-center gap-2">
                  <FolderGit2 className="size-5 text-accent" />
                  <span className="font-medium">{c.name}</span>
                </div>
                <p className="mt-1 flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
                  <Building2 className="size-3.5" /> {c.orgLogin}
                </p>
                <div className="mt-3 flex gap-2">
                  <Badge tone="zinc" icon={Users}>
                    {c.students} student{c.students > 1 ? "s" : ""}
                  </Badge>
                  <Badge tone="green" icon={CheckCircle2}>
                    {c.claimed} claimed
                  </Badge>
                </div>
              </Card>
            </button>
          ))}
        </div>
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
          <Field
            label="GitHub organization"
            placeholder="heig-tin-info"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            required
          />
          <Button disabled={create.isPending}>
            <Plus className="size-4" /> Create
          </Button>
        </form>
        {create.isError ? (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">Creation failed.</p>
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
                <School className="size-5 text-accent" />
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
  if (me.isLoading) return null;
  if (!me.data) return <Landing />;
  return (
    <div className="min-h-dvh">
      <Header me={me.data} />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <GithubBanner />
        {me.data.role === "teacher" ? <TeacherHome /> : <StudentHome me={me.data} />}
      </main>
    </div>
  );
}
