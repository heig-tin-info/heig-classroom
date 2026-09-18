import { lazy, Suspense, useEffect, useState } from "react";

import { useMe } from "./api";
import { GithubLinkToast, Logo } from "./Header";
import { useI18n, useT } from "./i18n";
import { useLiveUpdates } from "./live";
import { useRoute } from "./router";
import { Shell } from "./Shell";
import { LinkButton, setDateFormat, Spinner } from "./ui";

// One chunk per page: a student never downloads the teacher UI (roster,
// assignment forms, timeline) and vice versa.
const TeacherHome = lazy(() => import("./TeacherHome").then((m) => ({ default: m.TeacherHome })));
const StudentHome = lazy(() => import("./StudentHome").then((m) => ({ default: m.StudentHome })));
const ClassroomView = lazy(() => import("./ClassroomView").then((m) => ({ default: m.ClassroomView })));
const SettingsPage = lazy(() => import("./SettingsPage").then((m) => ({ default: m.SettingsPage })));
const AdminPage = lazy(() => import("./AdminPanel").then((m) => ({ default: m.AdminPage })));
const AssignmentPage = lazy(() =>
  import("./AssignmentDetail").then((m) => ({ default: m.AssignmentPage })),
);

function Landing() {
  const t = useT();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-4">
      <div className="flex flex-col items-center gap-5 text-center">
        <Logo className="size-7" />
        <div>
          <h1 className="text-[32px] font-bold tracking-[-0.02em]">{t("app.title")}</h1>
          <p className="mx-auto mt-3 max-w-md text-fg-muted">{t("landing.tagline")}</p>
        </div>
        <LinkButton href="/app/auth/login" variant="primary" size="lg">
          {t("landing.signin")}
        </LinkButton>
      </div>
      <p className="text-xs text-fg-faint">{t("landing.footer")}</p>
    </main>
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
  const teacherUi = teacher && !inStudentView;

  const page =
    route.view === "settings" ? (
      <SettingsPage me={me.data} />
    ) : !teacherUi ? (
      <StudentHome me={me.data} />
    ) : route.view === "admin" && role === "admin" ? (
      <AdminPage />
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
    );

  return (
    <Shell
      me={me.data}
      route={route}
      navigate={navigate}
      teacherUi={teacherUi}
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
    >
      <GithubLinkToast />
      <Suspense fallback={<Spinner className="py-24" />}>{page}</Suspense>
    </Shell>
  );
}
