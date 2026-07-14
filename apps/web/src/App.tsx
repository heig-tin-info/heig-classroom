import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";

import type { ClassroomDetail } from "@hgc/contracts";

import { api, useMe } from "./api";
import { Breadcrumb } from "./Breadcrumb";
import { GithubLinkToast, Header, Logo } from "./Header";
import { useI18n, useT } from "./i18n";
import { useLiveUpdates } from "./live";
import { useRoute, type Route } from "./router";
import { Card, setDateFormat } from "./ui";

// One chunk per page: a student never downloads the teacher UI (roster,
// assignment forms, timeline) and vice versa.
const TeacherHome = lazy(() => import("./TeacherHome").then((m) => ({ default: m.TeacherHome })));
const StudentHome = lazy(() => import("./StudentHome").then((m) => ({ default: m.StudentHome })));
const ClassroomView = lazy(() => import("./ClassroomView").then((m) => ({ default: m.ClassroomView })));
const SettingsPage = lazy(() => import("./SettingsPage").then((m) => ({ default: m.SettingsPage })));
const AssignmentDetail = lazy(() =>
  import("./AssignmentDetail").then((m) => ({ default: m.AssignmentDetail })),
);

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

// Persisted teacher choice: "student" keeps the student view across reloads.
// (Distinct from "hgc-student-view", a layout toggle inside StudentHome.)
const VIEW_AS_KEY = "hgc-view-as";

export default function App() {
  const me = useMe();
  const [route, navigate] = useRoute();
  const [studentView, setStudentView] = useState(
    () => localStorage.getItem(VIEW_AS_KEY) === "student",
  );
  const { setLocale } = useI18n();
  useLiveUpdates(me.data != null);
  // The account's saved language wins on load, so the choice follows the user
  // across devices (no re-persist: adopt only).
  const serverLocale = me.data?.locale ?? null;
  useEffect(() => {
    if (serverLocale) setLocale(serverLocale, false);
  }, [serverLocale, setLocale]);
  // Same for the date format, but synchronously: it must be set before the
  // first view renders a date (module-level store in ui.tsx, idempotent).
  setDateFormat(me.data?.dateFormat);
  if (me.isLoading) return null;
  if (!me.data) return <Landing />;
  const role = me.data.role;
  const teacher = role === "teacher" || role === "admin";
  const inStudentView = teacher && studentView;
  return (
    <div className="min-h-dvh">
      <Header
        me={me.data}
        onOpenSettings={() => navigate({ view: "settings" })}
        onHome={() => navigate({ view: "home" })}
        studentView={inStudentView}
        onToggleStudentView={
          teacher
            ? () => {
                setStudentView((v) => {
                  localStorage.setItem(VIEW_AS_KEY, v ? "teacher" : "student");
                  return !v;
                });
                navigate({ view: "home" });
              }
            : undefined
        }
      />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <GithubLinkToast />
        <Suspense fallback={null}>
        {route.view === "settings" ? (
          <SettingsPage me={me.data} onBack={() => navigate({ view: "home" })} />
        ) : !teacher || inStudentView ? (
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
        </Suspense>
      </main>
    </div>
  );
}
