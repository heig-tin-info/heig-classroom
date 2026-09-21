// Screenshots of the mocked web app, for the visual check required by
// `.claude/skills/hgc-ui/SKILL.md`. Development tool only: it is never
// imported by the app, never bundled and never runs in CI.
//
//   pnpm --filter @hgc/web dev:mock          # in one terminal
//   pnpm --filter @hgc/web screenshots       # in another
//
// Flags: --dark, --width=390|768|1440 (repeatable), --only=<substring>,
//        --fold (viewport only, instead of the full page), --list.
// Environment: BASE (default http://localhost:5173), OUT (default
// apps/web/screenshots).
//
// See docs/development/ui-mock-and-screenshots.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? "http://localhost:5173";
const OUT = process.env.OUT ?? path.resolve(here, "..", "screenshots");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) =>
  argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));

const dark = flag("dark");
const fullPage = !flag("fold");
const only = opt("only").concat(argv.filter((a) => !a.startsWith("--")));
const widths = opt("width").map(Number).filter(Boolean);

// --- Scenes, as data ---------------------------------------------------
//
// name   file name (plus the theme and width suffixes)
// role   mock persona: teacher | student | admin
// path   URL under BASE; scene flags of the mock go in the query string
// ls     extra localStorage entries, written before the first paint
// act    what to open once the page settled (a sheet, a menu, a dialog)
// fold   viewport only, whatever --fold says. For a scene whose layer is
//        `fixed`: full-page, the backdrop covers the viewport and everything
//        below the fold comes out undimmed, which reads as a bug and is not
//        what anyone sees.

const scenes = [
  // Teacher home
  { name: "teacher-home", role: "teacher", path: "/" },
  { name: "teacher-home-list", role: "teacher", path: "/", ls: { "hgc-classrooms-view": "list" } },
  { name: "teacher-home-timeline", role: "teacher", path: "/", ls: { "hgc-classrooms-view": "timeline" } },
  { name: "teacher-home-archives", role: "teacher", path: "/", act: (p) => p.getByRole("button", { name: "Archives" }).first().click() },
  { name: "teacher-home-new", role: "teacher", path: "/", act: (p) => p.getByRole("button", { name: /create classroom/i }).first().click() },
  { name: "teacher-home-empty", role: "teacher", path: "/?empty=1" },
  { name: "teacher-home-error", role: "teacher", path: "/?fail=1", settle: 2500 },
  { name: "teacher-home-loading", role: "teacher", path: "/?slow=1", settle: 300 },
  { name: "teacher-home-many", role: "teacher", path: "/?many=1" },
  { name: "teacher-home-many-list", role: "teacher", path: "/?many=1", ls: { "hgc-classrooms-view": "list" } },

  // Classroom
  { name: "classroom", role: "teacher", path: "/classrooms/c1" },
  { name: "classroom-students", role: "teacher", path: "/classrooms/c1?tab=students" },
  { name: "classroom-staff", role: "teacher", path: "/classrooms/c1?tab=staff" },
  { name: "classroom-settings", role: "teacher", path: "/classrooms/c1?tab=settings" },
  { name: "classroom-free-plan", role: "teacher", path: "/classrooms/c2" },
  { name: "classroom-not-installed", role: "teacher", path: "/classrooms/c4" },
  { name: "classroom-org-missing", role: "teacher", path: "/classrooms/c5" },
  { name: "classroom-empty", role: "teacher", path: "/classrooms/c1?empty=1" },
  { name: "classroom-empty-students", role: "teacher", path: "/classrooms/c1?tab=students&empty=1" },
  { name: "classroom-empty-staff", role: "teacher", path: "/classrooms/c1?tab=staff&empty=1" },
  { name: "classroom-error", role: "teacher", path: "/classrooms/c1?fail=1", settle: 2500 },
  { name: "classroom-loading", role: "teacher", path: "/classrooms/c1?slow=1", settle: 300 },
  { name: "classroom-roster-many", role: "teacher", path: "/classrooms/c1?tab=students&many=1" },
  { name: "classroom-assignments-many", role: "teacher", path: "/classrooms/c1?many=1" },
  { name: "classroom-import", role: "teacher", path: "/classrooms/c1?tab=students", act: (p) => p.getByRole("button", { name: /add students/i }).first().click() },
  { name: "classroom-archive-confirm", role: "teacher", path: "/classrooms/c1?tab=settings", act: (p) => p.getByRole("button", { name: /archive classroom/i }).first().click() },

  // Assignment form
  { name: "assignment-new", role: "teacher", path: "/classrooms/c1", act: (p) => p.getByRole("button", { name: /create assignment/i }).first().click() },
  { name: "assignment-edit-draft", role: "teacher", path: "/classrooms/c1", act: (p) => openRowMenu(p, "Lab 4 — File I/O", /edit/i) },
  { name: "assignment-edit-published", role: "teacher", path: "/classrooms/c1", act: (p) => openRowMenu(p, "Lab 2 — Pointers, arrays and dynamic memory allocation", /edit/i) },
  { name: "assignment-edit-locked", role: "teacher", path: "/classrooms/c1", act: (p) => openRowMenu(p, "Lab 1 — Hello, C", /edit/i) },
  { name: "assignment-edit-online", role: "teacher", path: "/classrooms/c1", act: (p) => openRowMenu(p, "Semester project", /edit/i) },
  { name: "assignment-edit-seb", role: "teacher", path: "/classrooms/c2", act: (p) => openRowMenu(p, "Exam — Data structures", /edit/i) },

  // Assignment detail
  { name: "assignment-detail", role: "teacher", path: "/classrooms/c1/assignments/a2" },
  { name: "assignment-detail-locked", role: "teacher", path: "/classrooms/c1/assignments/a1" },
  { name: "assignment-detail-draft", role: "teacher", path: "/classrooms/c1/assignments/a4" },
  { name: "assignment-detail-ungraded", role: "teacher", path: "/classrooms/c1/assignments/a6" },
  { name: "assignment-detail-seb", role: "teacher", path: "/classrooms/c2/assignments/b2" },
  { name: "assignment-detail-expanded", role: "teacher", path: "/classrooms/c1/assignments/a2", act: (p) => p.locator("tbody tr").first().click() },
  { name: "assignment-detail-milestone-add", role: "teacher", path: "/classrooms/c1/assignments/a2", act: (p) => p.getByRole("button", { name: /add milestone/i }).first().click() },
  { name: "assignment-detail-history", role: "teacher", path: "/classrooms/c1/assignments/a1", act: (p) => p.getByRole("button", { name: /grade history/i }).first().click() },
  { name: "assignment-detail-adjust", role: "teacher", path: "/classrooms/c1/assignments/a1", act: (p) => p.getByRole("button", { name: /adjust grade/i }).first().click() },
  { name: "assignment-detail-error", role: "teacher", path: "/classrooms/c1/assignments/a2?fail=1", settle: 2500 },
  { name: "assignment-detail-loading", role: "teacher", path: "/classrooms/c1/assignments/a2?slow=1", settle: 300 },
  { name: "assignment-detail-many", role: "teacher", path: "/classrooms/c1/assignments/a2?many=1" },

  // Group assignments (issue #2): a7 is the draft being formed, a6 the
  // published one whose first group already owns a repository.
  { name: "groups", role: "teacher", path: "/classrooms/c1/assignments/a7/groups" },
  { name: "groups-locked", role: "teacher", path: "/classrooms/c1/assignments/a6/groups" },
  { name: "groups-individual", role: "teacher", path: "/classrooms/c1/assignments/a2/groups" },
  { name: "groups-empty", role: "teacher", path: "/classrooms/c2/assignments/b3/groups" },
  { name: "groups-gone", role: "teacher", path: "/classrooms/c1/assignments/a7/groups?empty=1" },
  { name: "groups-error", role: "teacher", path: "/classrooms/c1/assignments/a7/groups?fail=1", settle: 2500 },
  // `?slow=1` slows /app/api/me too, so the shell only appears after 2.5 s:
  // the skeletons of this page are on screen between then and 5 s.
  { name: "groups-loading", role: "teacher", path: "/classrooms/c1/assignments/a7/groups?slow=1", settle: 3200 },
  { name: "groups-copy", role: "teacher", path: "/classrooms/c1/assignments/a7/groups", act: (p) => p.getByRole("button", { name: /copy from/i }).click() },
  { name: "groups-split", role: "teacher", path: "/classrooms/c1/assignments/a7/groups", act: (p) => p.getByRole("button", { name: /split remaining/i }).click() },
  { name: "groups-rename", role: "teacher", path: "/classrooms/c1/assignments/a7/groups", act: (p) => p.getByRole("button", { name: "Les Castors", exact: true }).first().click() },
  { name: "assignment-detail-groups", role: "teacher", path: "/classrooms/c1/assignments/a7" },
  {
    name: "assignment-edit-groups",
    role: "teacher",
    path: "/classrooms/c1",
    fold: true,
    act: async (p) => {
      await openRowMenu(p, "Lab 5 — Group project", /edit/i);
      // The switch lives far down the sheet, which scrolls on its own.
      await p.getByRole("switch", { name: "Group work" }).scrollIntoViewIfNeeded();
    },
  },
  {
    name: "assignment-publish-blocked",
    role: "teacher",
    path: "/classrooms/c1",
    fold: true,
    act: async (p) => {
      const row = p.locator("li", { hasText: "Lab 5 — Group project" }).first();
      await row.getByRole("button", { name: /publish/i }).click();
      await p.getByRole("dialog").getByRole("button", { name: "Publish" }).click();
      await p.getByText("have no group").waitFor();
    },
  },

  // Student
  { name: "student-home", role: "student", path: "/" },
  { name: "student-home-list", role: "student", path: "/", ls: { "hgc-student-view": "list" } },
  { name: "student-unlinked", role: "student", path: "/?unlinked=1" },
  { name: "student-empty", role: "student", path: "/?empty=1" },
  { name: "student-error", role: "student", path: "/?fail=1", settle: 2500 },
  { name: "student-loading", role: "student", path: "/?slow=1", settle: 300 },
  { name: "student-many", role: "student", path: "/?many=1" },
  { name: "student-settings", role: "student", path: "/settings" },

  // Command palette (Ctrl+K from anywhere; the mock persona decides the groups)
  { name: "palette", role: "teacher", path: "/", fold: true, act: (p) => p.keyboard.press("Control+k") },
  { name: "palette-query", role: "teacher", path: "/", fold: true, act: async (p) => { await p.keyboard.press("Control+k"); await p.keyboard.type("set"); } },
  { name: "palette-no-result", role: "teacher", path: "/", fold: true, act: async (p) => { await p.keyboard.press("Control+k"); await p.keyboard.type("qqqq"); } },
  { name: "palette-classroom", role: "teacher", path: "/classrooms/c1", fold: true, act: (p) => p.keyboard.press("Control+k") },
  { name: "palette-many", role: "teacher", path: "/?many=1", fold: true, act: (p) => p.keyboard.press("Control+k") },
  { name: "palette-student", role: "student", path: "/", fold: true, act: (p) => p.keyboard.press("Control+k") },

  // Settings and administration
  { name: "settings", role: "teacher", path: "/settings" },
  { name: "settings-avatar", role: "teacher", path: "/settings", act: (p) => p.getByRole("button", { name: /change picture/i }).first().click() },
  { name: "admin", role: "admin", path: "/admin" },
  { name: "admin-empty", role: "admin", path: "/admin?empty=1" },
  { name: "admin-error", role: "admin", path: "/admin?fail=1", settle: 2500 },
  { name: "admin-loading", role: "admin", path: "/admin?slow=1", settle: 300 },
];

/**
 * Opens the overflow menu of one assignment row and picks an item. The row is
 * brought into view first so the trigger is clickable; the menu itself now
 * ignores the scroll its own opening causes, so no extra settling is needed.
 */
async function openRowMenu(page, assignmentName, item) {
  const trigger = page.getByLabel(`Actions for ${assignmentName}`);
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await page.getByRole("menuitem", { name: item }).click();
}

if (flag("list")) {
  for (const s of scenes) console.log(s.name);
  process.exit(0);
}

// --- Runner ------------------------------------------------------------

const picked = scenes.filter((s) => only.length === 0 || only.some((f) => s.name.includes(f)));
if (picked.length === 0) {
  console.error(`No scene matches ${only.join(", ")}. Try --list.`);
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
let failures = 0;

for (const width of widths.length ? widths : [1440]) {
  const ctx = await browser.newContext({
    viewport: { width, height: width < 700 ? 844 : 900 },
    deviceScaleFactor: 1,
    colorScheme: dark ? "dark" : "light",
  });
  for (const scene of picked) {
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(m.text());
    });
    await page.addInitScript(
      ({ role, ls, dark }) => {
        localStorage.clear();
        localStorage.setItem("hgc-mock-role", role);
        if (dark) localStorage.setItem("hgc-theme", "dark");
        for (const [k, v] of Object.entries(ls ?? {})) localStorage.setItem(k, v);
      },
      { role: scene.role, ls: scene.ls, dark },
    );
    try {
      await page.goto(BASE + scene.path, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(scene.settle ?? 1500);
      if (scene.act) {
        await scene.act(page);
        await page.waitForTimeout(700);
      }
    } catch (e) {
      problems.push(`scene failed: ${String(e).split("\n")[0]}`);
    }
    const suffix = `${dark ? "-dark" : ""}${width === 1440 ? "" : `-${width}`}`;
    const file = path.join(OUT, `${scene.name}${suffix}.png`);
    await page.screenshot({ path: file, fullPage: fullPage && !scene.fold });
    if (problems.length) failures += 1;
    console.log(
      `${path.relative(process.cwd(), file)}${problems.length ? `  PROBLEMS: ${problems.join(" | ").slice(0, 400)}` : ""}`,
    );
    await page.close();
  }
  await ctx.close();
}

await browser.close();
if (failures) console.error(`${failures} scene(s) reported console or page errors.`);
