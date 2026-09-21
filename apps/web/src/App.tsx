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
const GroupsPage = lazy(() => import("./GroupsPage").then((m) => ({ default: m.GroupsPage })));

/*
 * Signed-out page. The four decisions, so the door looks like the house:
 * - Type: the page-title step (28 px / 700 / -0.02em) over the 16 px step for
 *   the tagline, the same 2x jump every page header uses. Nothing at 32 px:
 *   the landing is not louder than a classroom.
 * - Color: one accent, the sign-in button. The mark keeps the red square it
 *   has in the sidebar; everything else is fg / fg-muted / fg-faint.
 * - Space: 20 between the mark and the name, 12 between the name and the
 *   tagline (one group), 32 before the action, 48 down to the footer.
 * - Finish: a sheet of paper (`surface` + hairline + card radius) on the warm
 *   canvas. No shadow: it sits in the page flow.
 */
function Landing() {
  const t = useT();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-115 rounded-card border border-line bg-surface px-8 py-10 text-center">
        <Logo className="size-7" />
        <h1 className="mt-5 text-[28px] font-bold leading-tight tracking-[-0.02em]">
          {t("app.title")}
        </h1>
        <p className="mt-3 text-base leading-relaxed text-fg-muted">{t("landing.tagline")}</p>
        <LinkButton
          href="/app/auth/login"
          variant="primary"
          size="lg"
          className="mt-8 w-full"
        >
          {t("landing.signin")}
        </LinkButton>
      </div>
      <p className="mt-12 text-xs text-fg-faint">{t("landing.footer")}</p>
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
    ) : route.view === "assignment-groups" ? (
      <GroupsPage
        classroomId={route.classroomId}
        assignmentId={route.assignmentId}
        navigate={navigate}
      />
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
