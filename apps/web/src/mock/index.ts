/**
 * In-browser mock of the portal API, for design work without a backend
 * (`VITE_MOCK=1 pnpm dev`, or `pnpm dev:mock`). Never part of a production
 * build: main.tsx only imports this module behind the env flag, and Vite
 * drops the dead branch.
 *
 * The persona comes from `?as=teacher|student|admin` (remembered in this
 * browser). Every endpoint the web app calls is served from the in-memory
 * state below; mutations edit that state so the flows feel real, and the
 * page reload starts over.
 *
 * Scene flags, remembered the same way (`?empty=1`, `?empty=0` to clear):
 *
 *  - `empty` — nothing anywhere: no classrooms, no roster, no assignments, no
 *    teachers, no scheduled tasks, so every empty state is reachable;
 *  - `fail`  — every GET under /app/api answers 500 (except /app/api/me, so
 *    the shell still renders), to look at the error states;
 *  - `slow`  — 2.5 s of latency on every call, to look at the loading states;
 *  - `many`  — 30 classrooms, a 120-student roster and 40 assignments on the
 *    first one, to look at long lists and the sidebar.
 *
 * See `docs/development/ui-mock-and-screenshots.md`.
 */
import type {
  ActivityData,
  Assignment,
  AssignmentDetailPayload,
  AssignmentDetailStudent,
  AssignmentGroup,
  AssignmentGroupsPayload,
  AssignmentMilestone,
  ClassroomDetail,
  ClassroomGradesPayload,
  ClassroomStaffMember,
  ClassroomSummary,
  GradeRunHistory,
  GradeView,
  GroupMember,
  Me,
  OrgRepo,
  RepoTree,
  RosterEntry,
  StudentClassroom,
} from "@hgc/contracts";

type Role = Me["role"];

const ROLE_KEY = "hgc-mock-role";
const params = new URLSearchParams(window.location.search);
let urlDirty = false;
const asParam = params.get("as");
if (asParam === "teacher" || asParam === "student" || asParam === "admin") {
  localStorage.setItem(ROLE_KEY, asParam);
  params.delete("as");
  urlDirty = true;
}
const role: Role = (localStorage.getItem(ROLE_KEY) as Role | null) ?? "teacher";

/** Scene flags: read from the URL, then remembered like the persona. */
const FLAG_NAMES = ["empty", "fail", "slow", "many"] as const;
type FlagName = (typeof FLAG_NAMES)[number];
const flags = {} as Record<FlagName, boolean>;
for (const name of FLAG_NAMES) {
  const key = `hgc-mock-${name}`;
  const raw = params.get(name);
  if (raw !== null) {
    if (raw === "0" || raw === "false") localStorage.removeItem(key);
    else localStorage.setItem(key, "1");
    params.delete(name);
    urlDirty = true;
  }
  flags[name] = localStorage.getItem(key) === "1";
}
if (urlDirty) {
  const q = params.toString();
  window.history.replaceState(null, "", window.location.pathname + (q ? `?${q}` : ""));
}

/** Latency of every mocked call: enough to see a skeleton under `?slow=1`. */
const LATENCY = () => (flags.slow ? 2500 : 120 + Math.random() * 180);

// --- Time helpers: everything is relative to now so countdowns look alive ---
const H = 3_600_000;
const D = 24 * H;
const now = Date.now();
const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const iso = (offsetMs: number) => at(offsetMs);

// --- Deterministic pseudo-random (stable screenshots across reloads) ---
let seed = 42;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
const sha = () =>
  Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");

const FIRST = [
  "Marie", "Lucas", "Léa", "Noah", "Emma", "Gabriel", "Chloé", "Louis", "Camille", "Hugo",
  "Manon", "Nathan", "Zoé", "Ethan", "Alice", "Théo", "Inès", "Jules", "Sarah", "Adam",
  "Julie", "Maxime", "Eva", "Arthur", "Nina", "Samuel", "Lina", "Rafael", "Clara", "Elias",
];
const LAST = [
  "Dupont", "Martin", "Rochat", "Favre", "Bovet", "Chappuis", "Monnier", "Perret", "Girard",
  "Roulet", "Blanc", "Mercier", "Gauthier", "Bonvin", "Delacroix", "Morel", "Vuille",
  "Jaquet", "Berger", "Pittet", "Currat", "Ducret", "Nicollier", "Rey", "Sauter", "Zwahlen",
  "Meier", "Fontana", "Rossi", "Kunz",
];

interface Student {
  id: string;
  nom: string;
  prenom: string;
  email: string;
  status: "pending" | "claimed";
  conflictFlag: boolean;
  staff: boolean;
  githubLogin: string | null;
  lastLoginAt: string | null;
}

function makeStudents(n: number, claimedRatio: number, prefix: string): Student[] {
  const out: Student[] = [];
  const used = new Set<string>();
  for (let i = 0; i < n; i += 1) {
    let prenom = pick(FIRST);
    let nom = pick(LAST);
    while (used.has(`${prenom}${nom}`)) {
      prenom = pick(FIRST);
      nom = pick(LAST);
    }
    used.add(`${prenom}${nom}`);
    const claimed = rand() < claimedRatio;
    const login = `${prenom.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "")}-${nom.toLowerCase().slice(0, 4)}`;
    out.push({
      id: `${prefix}-s${i + 1}`,
      nom,
      prenom,
      email: `${prenom.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "")}.${nom.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "")}@heig-vd.ch`,
      status: claimed ? "claimed" : "pending",
      conflictFlag: claimed && rand() < 0.04,
      staff: false,
      githubLogin: claimed ? login : null,
      lastLoginAt: claimed ? iso(-rand() * 20 * D) : null,
    });
  }
  return out;
}

interface Room {
  summary: Omit<ClassroomSummary, "assignments" | "roster" | "students" | "claimed">;
  org: NonNullable<ClassroomDetail["org"]>;
  students: Student[];
  staff: ClassroomStaffMember[];
  assignments: Assignment[];
  archivedAssignments: Set<string>;
  teacher: string;
}

function assignment(
  id: string,
  name: string,
  org: string,
  o: Partial<Assignment> & { start: number; deadline: number },
): Assignment {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return {
    id,
    name,
    slug,
    state: "published",
    startAt: iso(o.start),
    deadlineAt: iso(o.deadline),
    graceMinutes: 30,
    sourceFullName: `${org}/${slug}`,
    squashedFullName: `${org}/${slug}-squashed`,
    sourceStrategy: "squash",
    deadlineStrategy: "lock",
    gradingMode: "auto",
    publishMode: "scheduled",
    durationMinutes: null,
    branches: ["main"],
    protectedFiles: [".github/workflows/grade.yml", "criteria.yml"],
    workMode: "free",
    codespaceImage: null,
    browserExamKeys: [],
    groupMode: false,
    groupMaxSize: null,
    ...o,
  };
}

const rooms: Room[] = [
  {
    summary: {
      id: "c1",
      name: "PRG1 2026",
      orgLogin: "heig-prg1-2026",
      createdAt: iso(-40 * D),
      archivedAt: null,
      isOwner: true,
    },
    org: {
      login: "heig-prg1-2026",
      installationId: 88_213,
      githubOrgId: 190_233_811,
      plan: "team",
      status: "active",
      exists: true,
      llmSecret: "ok",
    },
    students: makeStudents(24, 0.85, "c1"),
    staff: [
      {
        id: "st1",
        email: "pierre.roulet@heig-vd.ch",
        role: "assistant",
        givenName: "Pierre",
        familyName: "Roulet",
        claimed: true,
        createdAt: iso(-30 * D),
      },
      {
        id: "st2",
        email: "sonia.bianchi@heig-vd.ch",
        role: "teacher",
        givenName: null,
        familyName: null,
        claimed: false,
        createdAt: iso(-3 * D),
      },
    ],
    assignments: [
      assignment("a1", "Lab 1 — Hello, C", "heig-prg1-2026", {
        start: -30 * D,
        deadline: -16 * D,
        state: "locked",
      }),
      assignment("a2", "Lab 2 — Pointers, arrays and dynamic memory allocation", "heig-prg1-2026", {
        start: -12 * D,
        deadline: 3 * D + 5 * H,
      }),
      assignment("a3", "Lab 3 — Linked lists", "heig-prg1-2026", {
        start: 4 * D,
        deadline: 18 * D,
      }),
      assignment("a4", "Lab 4 — File I/O", "heig-prg1-2026", {
        start: 19 * D,
        deadline: 33 * D,
        state: "draft",
      }),
      // Ungraded workshop: the grade column, the milestones and the review
      // countdown all disappear (gradingMode "none"). Also the published
      // group assignment: one of its groups owns a repository, so it is
      // locked, and it is the source "Copy from…" offers on Lab 5.
      assignment("a6", "Workshop — Git basics", "heig-prg1-2026", {
        start: -20 * D,
        deadline: 8 * D,
        gradingMode: "none",
        groupMode: true,
        groupMaxSize: 4,
      }),
      // Group assignment still a draft: the group-formation screen with a few
      // groups, one over the size hint, and students left unassigned.
      assignment("a7", "Lab 5 — Group project", "heig-prg1-2026", {
        start: 20 * D,
        deadline: 40 * D,
        state: "draft",
        groupMode: true,
        groupMaxSize: 3,
      }),
      assignment("a5", "Semester project", "heig-prg1-2026", {
        start: 0,
        deadline: 0,
        state: "draft",
        publishMode: "manual",
        durationMinutes: 21 * 1440,
        workMode: "online",
        codespaceImage: "heig/c-lab:2026",
      }),
    ],
    archivedAssignments: new Set(["a0"]),
    teacher: "Ada Lovelace",
  },
  {
    summary: {
      id: "c2",
      name: "Info2 TIN-B",
      orgLogin: "heig-info2-tinb",
      createdAt: iso(-12 * D),
      archivedAt: null,
      isOwner: true,
    },
    org: {
      login: "heig-info2-tinb",
      installationId: 88_530,
      githubOrgId: 190_988_120,
      plan: "free",
      status: "active",
      exists: true,
      llmSecret: "missing",
    },
    students: makeStudents(18, 0.6, "c2"),
    staff: [],
    assignments: [
      assignment("b1", "TP1 — Bash survival kit", "heig-info2-tinb", {
        start: -8 * D,
        deadline: 6 * D,
      }),
      assignment("b2", "Exam — Data structures", "heig-info2-tinb", {
        start: 10 * D,
        deadline: 10 * D + 2 * H,
        state: "draft",
        workMode: "online_seb",
        browserExamKeys: [sha() + sha().slice(0, 24)],
      }),
      // Group mode with nothing formed yet: the empty state of the groups
      // screen, and the whole roster on its left.
      assignment("b3", "TP2 — Teams to form", "heig-info2-tinb", {
        start: 14 * D,
        deadline: 28 * D,
        state: "draft",
        groupMode: true,
      }),
    ],
    archivedAssignments: new Set(),
    teacher: "Ada Lovelace",
  },
  {
    summary: {
      id: "c3",
      name: "Algo 2025",
      orgLogin: "heig-algo-2025",
      createdAt: iso(-300 * D),
      archivedAt: null,
      isOwner: false,
    },
    org: {
      login: "heig-algo-2025",
      installationId: 71_004,
      githubOrgId: 171_002_331,
      plan: "team",
      status: "active",
      exists: true,
      llmSecret: "ok",
    },
    students: makeStudents(30, 1, "c3"),
    staff: [
      {
        id: "st3",
        email: "ada.lovelace@heig-vd.ch",
        role: "teacher",
        givenName: "Ada",
        familyName: "Lovelace",
        claimed: true,
        createdAt: iso(-290 * D),
      },
    ],
    assignments: [
      assignment("d1", "Sorting", "heig-algo-2025", { start: -200 * D, deadline: -180 * D, state: "locked" }),
      assignment("d2", "Graphs", "heig-algo-2025", { start: -170 * D, deadline: -150 * D, state: "locked" }),
      assignment("d3", "Dynamic programming", "heig-algo-2025", { start: -140 * D, deadline: -120 * D, state: "locked" }),
    ],
    archivedAssignments: new Set(),
    teacher: "Grace Hopper",
  },
  {
    // The GitHub App is not installed yet: the classroom page shows the
    // install wizard and assignments are out of reach.
    summary: {
      id: "c4",
      name: "Réseaux 2026",
      orgLogin: "heig-reseaux-2026",
      createdAt: iso(-2 * D),
      archivedAt: null,
      isOwner: true,
    },
    org: {
      login: "heig-reseaux-2026",
      installationId: null,
      githubOrgId: 191_400_002,
      plan: null,
      status: "active",
      exists: true,
      llmSecret: null,
    },
    students: makeStudents(12, 0.25, "c4"),
    staff: [],
    assignments: [],
    archivedAssignments: new Set(),
    teacher: "Ada Lovelace",
  },
  {
    // The organization was deleted or renamed on GitHub: read-only classroom.
    summary: {
      id: "c5",
      name: "SYE 2024",
      orgLogin: "heig-sye-2024",
      createdAt: iso(-500 * D),
      archivedAt: null,
      isOwner: true,
    },
    org: {
      login: "heig-sye-2024",
      installationId: null,
      githubOrgId: null,
      plan: null,
      status: "degraded",
      exists: false,
      llmSecret: null,
    },
    students: makeStudents(16, 1, "c5"),
    staff: [],
    assignments: [
      assignment("e1", "Processes and signals", "heig-sye-2024", {
        start: -480 * D,
        deadline: -460 * D,
        state: "locked",
      }),
    ],
    archivedAssignments: new Set(),
    teacher: "Ada Lovelace",
  },
];

const archivedRooms: Room[] = [
  {
    summary: {
      id: "c9",
      name: "PRG1 2025",
      orgLogin: "heig-prg1-2025",
      createdAt: iso(-400 * D),
      archivedAt: iso(-60 * D),
      isOwner: true,
    },
    org: {
      login: "heig-prg1-2025",
      installationId: 60_100,
      githubOrgId: 160_000_000,
      plan: "team",
      status: "active",
      exists: true,
      llmSecret: "ok",
    },
    students: makeStudents(22, 1, "c9"),
    staff: [],
    assignments: [],
    archivedAssignments: new Set(),
    teacher: "Ada Lovelace",
  },
];

// --- Session ---

let me: Me | null = {
  id: "u1",
  email: role === "student" ? "marie.dupont@heig-vd.ch" : "ada.lovelace@heig-vd.ch",
  givenName: role === "student" ? "Marie" : "Ada",
  familyName: role === "student" ? "Dupont" : "Lovelace",
  role,
  githubLogin: params.get("unlinked") ? null : role === "student" ? "marie-dupo" : "ada-l",
  lastLoginAt: iso(-2 * H),
  avatarUrl: null,
  hasUploadedAvatar: false,
  locale: null,
  dateFormat: "iso",
  emailPrefs: {},
  codespace: { enabled: true, maxActiveSessions: 10 },
  codespaceHost: "codespace.example.ch",
};

// --- Per-assignment student states (teacher detail + grades) ---

interface RepoState {
  id: string;
  fullName: string;
  acceptedAt: string;
  lockedAt: string | null;
  grade: GradeView | null;
  frozenGrade: GradeView | null;
  llmGrade: GradeView | null;
  teacherPoints: number | null;
  teacherComment: string | null;
  lastCommitSha: string;
  lastCommitAt: string;
  commitCount: number;
  checksPassed: number;
  checksTotal: number;
  ciStatus: "none" | "pending" | "pass" | "fail";
  syncPr: { number: number; state: "open" | "merged" | "closed" | null } | null;
}

const grade = (points: number, max: number, kind: "ci" | "llm", ago: number): GradeView => ({
  points,
  max,
  testsPassed: Math.round((points / max) * 12),
  testsTotal: 12,
  parseStatus: "ok",
  conclusion: "success",
  sha: sha(),
  branch: "main",
  kind,
  afterDeadline: false,
  completedAt: iso(-ago),
});

const repoStates = new Map<string, Map<string, RepoState | null>>();
const validated = new Map<string, string | null>();
const milestones = new Map<string, AssignmentMilestone[]>([
  [
    "a2",
    [
      { id: "m1", name: "review-1", dueAt: iso(-5 * D), offsetDays: -8, dispatchedAt: iso(-5 * D) },
      { id: "m2", name: "review-2", dueAt: iso(1 * D), offsetDays: -2, dispatchedAt: null },
    ],
  ],
]);

// --- Group assignments (issue #2, lot 1) -------------------------------
//
// One entry per group-mode assignment. `members` holds enrollment ids, and a
// non-null `repo` is what locks a group (lot 2 creates it at the first
// acceptance): no rename, no delete, no member removal while it is there.

interface MockGroup {
  id: string;
  name: string;
  slug: string;
  position: number;
  members: string[];
  repo: { fullName: string | null; provisionStatus: "ok" } | null;
}

/** Same rule as the server's `slugify` (lifecycle.ts). */
const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const groups = new Map<string, MockGroup[]>();

/** Seeded on first read so the fixtures follow the roster of the classroom. */
function groupsOf(room: Room, a: Assignment): MockGroup[] {
  const existing = groups.get(a.id);
  if (existing) return existing;
  const roster = room.students.filter((s) => !s.staff);
  const made: MockGroup[] = [];
  const add = (name: string, members: string[], repo = false) =>
    made.push({
      id: `${a.id}-g${made.length + 1}`,
      name,
      slug: slugify(name),
      position: made.length,
      members,
      repo: repo ? { fullName: `${room.summary.orgLogin}/${a.slug}-${slugify(name)}`, provisionStatus: "ok" } : null,
    });
  if (a.id === "a6") {
    // Published: everyone placed, and the first group already has its repo.
    for (let i = 0; i * 3 < roster.length; i += 1) {
      add(`Group ${i + 1}`, roster.slice(i * 3, i * 3 + 3).map((s) => s.id), i === 0);
    }
  } else if (a.id === "a7") {
    // Draft: four groups, the third one over the size hint of 3, and the
    // tail of the roster still unassigned.
    add("Les Castors", roster.slice(0, 3).map((s) => s.id));
    add("Group 2", roster.slice(3, 5).map((s) => s.id));
    add("Group 3", roster.slice(5, 9).map((s) => s.id));
    add("Group 4", []);
  }
  groups.set(a.id, made);
  return made;
}

const memberView = (s: Student): GroupMember => ({
  enrollmentId: s.id,
  nom: s.nom,
  prenom: s.prenom,
  email: s.email,
  claimStatus: s.status,
  githubLogin: s.githubLogin,
  avatarUrl: null,
});

const groupView = (room: Room, g: MockGroup): AssignmentGroup => {
  const byId = new Map(room.students.map((s) => [s.id, s]));
  return {
    id: g.id,
    name: g.name,
    slug: g.slug,
    members: g.members.map((id) => memberView(byId.get(id)!)),
    repo: g.repo,
  };
};

function groupsPayload(room: Room, a: Assignment): AssignmentGroupsPayload {
  if (!a.groupMode) throw new MockError(409, "This assignment is not in group mode", { error: "group_mode_off" });
  const list = groupsOf(room, a);
  const byId = new Map(room.students.map((s) => [s.id, s]));
  const taken = new Set(list.flatMap((g) => g.members));
  return {
    assignment: {
      id: a.id,
      name: a.name,
      state: a.state,
      groupMode: a.groupMode,
      groupMaxSize: a.groupMaxSize,
    },
    groups: list
      .slice()
      .sort((x, y) => x.position - y.position)
      .map((g) => groupView(room, g)),
    unassigned: room.students
      .filter((s) => !s.staff && !taken.has(s.id))
      .sort((x, y) => `${x.nom} ${x.prenom}`.localeCompare(`${y.nom} ${y.prenom}`))
      .map(memberView),
    copySources: room.assignments
      .filter((x) => x.id !== a.id && x.groupMode && !room.archivedAssignments.has(x.id))
      .map((x) => ({ id: x.id, name: x.name, groups: groupsOf(room, x).length }))
      .filter((x) => x.groups > 0),
  };
}

function repoStatesOf(room: Room, a: Assignment): Map<string, RepoState | null> {
  const key = a.id;
  let m = repoStates.get(key);
  if (m) return m;
  m = new Map();
  const locked = a.state === "locked";
  let n = 0;
  for (const s of room.students) {
    n += 1;
    if (a.state === "draft" || s.status !== "claimed" || rand() < 0.15) {
      m.set(s.id, null);
      continue;
    }
    const max = 10;
    const pts = Math.round(rand() * 10 * 2) / 2;
    const ci = grade(pts, max, "ci", rand() * 3 * D);
    const llm = locked ? grade(Math.min(10, pts + 0.5), max, "llm", 2 * D) : null;
    const ciStatus = rand() < 0.1 ? "pending" : ci.testsPassed === 0 ? "fail" : "pass";
    m.set(s.id, {
      id: `r-${a.id}-${s.id}`,
      fullName: `${room.summary.orgLogin}/${a.slug}-${s.githubLogin}`,
      acceptedAt: iso(-rand() * 10 * D),
      lockedAt: locked ? a.deadlineAt : null,
      grade: ci,
      frozenGrade: locked ? ci : null,
      llmGrade: llm,
      teacherPoints: locked && n % 7 === 0 ? 8.5 : null,
      teacherComment: locked && n % 7 === 0 ? "Late but complete" : null,
      lastCommitSha: sha(),
      lastCommitAt: iso(-rand() * 4 * D),
      commitCount: 3 + Math.floor(rand() * 30),
      checksPassed: ciStatus === "pass" ? 1 : 0,
      checksTotal: 1,
      ciStatus,
      syncPr: n % 9 === 0 ? { number: 3, state: "open" } : null,
    });
  }
  repoStates.set(key, m);
  return m;
}

// --- Serializers ---

function summaryOf(room: Room): ClassroomSummary {
  const claimed = room.students.filter((s) => s.status === "claimed").length;
  return {
    ...room.summary,
    students: room.students.length,
    claimed,
    assignments: room.assignments
      .filter((a) => !room.archivedAssignments.has(a.id))
      .map((a) => ({ id: a.id, name: a.name, state: a.state, startAt: a.startAt, deadlineAt: a.deadlineAt })),
    roster: room.students.map((s) => ({
      nom: s.nom,
      prenom: s.prenom,
      claimed: s.status === "claimed",
      staff: s.staff,
    })),
  };
}

function detailOf(room: Room): ClassroomDetail {
  return {
    id: room.summary.id,
    name: room.summary.name,
    org: room.org,
    roster: room.students.map<RosterEntry>((s) => ({
      id: s.id,
      nom: s.nom,
      prenom: s.prenom,
      email: s.email,
      status: s.status,
      conflictFlag: s.conflictFlag,
      staff: s.staff,
      githubLogin: s.githubLogin,
      lastLoginAt: s.lastLoginAt,
      avatarUrl: null,
      hasUploadedAvatar: false,
    })),
    staff: room.staff,
    isOwner: room.summary.isOwner,
    appSlug: "heig-classroom",
  };
}

function assignmentDetail(room: Room, a: Assignment): AssignmentDetailPayload {
  const states = repoStatesOf(room, a);
  const students = room.students.map<AssignmentDetailStudent>((s) => {
    const r = states.get(s.id) ?? null;
    return {
      enrollmentId: s.id,
      nom: s.nom,
      prenom: s.prenom,
      email: s.email,
      claimStatus: s.status,
      githubLogin: s.githubLogin,
      repo: r
        ? {
            id: r.id,
            fullName: r.fullName,
            provisionStatus: "ok",
            provisionError: null,
            invitationStatus: "accepted",
            acceptedAt: r.acceptedAt,
            lockedAt: r.lockedAt,
            syncPr: r.syncPr,
            grade: r.grade,
            frozenGrade: r.frozenGrade,
            llmGrade: r.llmGrade,
            teacherPoints: r.teacherPoints,
            teacherComment: r.teacherComment,
            lastCommitSha: r.lastCommitSha,
            lastCommitAt: r.lastCommitAt,
            commitCount: r.commitCount,
            checksPassed: r.checksPassed,
            checksTotal: r.checksTotal,
            ciStatus: r.ciStatus,
          }
        : null,
    };
  });
  return {
    assignment: {
      id: a.id,
      name: a.name,
      slug: a.slug,
      classroom: room.summary.name,
      state: a.state,
      startAt: a.startAt,
      deadlineAt: a.deadlineAt,
      graceMinutes: a.graceMinutes,
      gradingMode: a.gradingMode,
      frozenAt: a.state === "locked" ? a.deadlineAt : null,
      llmDispatchedAt: a.state === "locked" ? iso(-15 * D) : null,
      gradesValidatedAt: validated.get(a.id) ?? null,
      sourceAheadSha: a.id === "a2" ? sha() : null,
      sourcePushedAt: a.id === "a2" ? iso(-1 * D) : null,
      syncedAt: a.id === "a2" ? iso(-6 * D) : null,
      workMode: a.workMode,
      codespaceImage: a.codespaceImage,
      browserExamKeys: a.browserExamKeys,
      codespaceSyncedAt: a.workMode === "free" ? null : iso(-2 * H),
      codespaceSyncError: null,
      // Exam mode only: the `.seb` the teacher downloads and the Config Key
      // the portal computed for it. Both null everywhere else, which is what
      // the assignment page keys the exam-configuration card off.
      codespaceConfigKey:
        a.workMode === "online_seb" ? sha() + sha().slice(0, 24) : null,
      codespaceSebUrl:
        a.workMode === "online_seb" ? `https://code.example.ch/exam/${a.id}.seb` : null,
      groupMode: a.groupMode,
      groupMaxSize: a.groupMaxSize,
    },
    students,
  };
}

function studentRooms(): StudentClassroom[] {
  if (flags.empty) return [];
  const mine = [rooms[0]!, rooms[1]!];
  return mine.map((room, ri) => ({
    id: room.summary.id,
    name: room.summary.name,
    orgLogin: room.summary.orgLogin,
    teacher: room.teacher,
    assignments: room.assignments
      .filter((a) => a.state !== "draft" || (ri === 1 && a.id === "b2"))
      .map((a, i) => {
        const accepted = studentAccepted.has(a.id) || (a.state === "locked" ? true : i % 2 === 0);
        const pts = 7.5 + i;
        return {
          id: a.id,
          name: a.name,
          state: a.state === "locked" ? "locked" : "published",
          startAt: a.startAt,
          deadlineAt: a.deadlineAt,
          graceMinutes: a.graceMinutes,
          gradingMode: a.gradingMode,
          gradesValidatedAt: a.state === "locked" && a.id === "a1" ? iso(-10 * D) : null,
          workMode: a.id === "b2" ? "online_seb" : a.workMode,
          repo: accepted
            ? {
                fullName: `${room.summary.orgLogin}/${a.slug}-marie-dupo`,
                provisionStatus: "ok",
                invitationStatus: "accepted",
                ciStatus: i === 1 ? "pending" : "pass",
                lockedAt: a.state === "locked" ? a.deadlineAt : null,
                commitCount: 4 + i * 5,
                checksPassed: 1,
                checksTotal: 1,
                grade: i === 1 ? null : grade(pts, 10, "ci", 3 * H),
                llmGrade: a.state === "locked" ? grade(8.5, 10, "llm", 12 * D) : null,
                gradeFrozen: a.state === "locked",
                teacherPoints: null,
              }
            : null,
        };
      }),
  }));
}
const studentAccepted = new Set<string>();

// --- Admin ---

const teachers = [
  { id: "t1", email: "ada.lovelace@heig-vd.ch", givenName: "Ada", familyName: "Lovelace", signedUp: true, classrooms: 3, assignments: 10, lastLoginAt: iso(-2 * H), grantedAt: iso(-400 * D), codespace: { enabled: true, maxActiveSessions: 10 } },
  { id: "t2", email: "grace.hopper@heig-vd.ch", givenName: "Grace", familyName: "Hopper", signedUp: true, classrooms: 1, assignments: 3, lastLoginAt: iso(-30 * D), grantedAt: iso(-390 * D), codespace: { enabled: false, maxActiveSessions: 0 } },
  { id: "t3", email: "linus.t@heig-vd.ch", givenName: null, familyName: null, signedUp: false, classrooms: 0, assignments: 0, lastLoginAt: null, grantedAt: iso(-1 * D), codespace: { enabled: false, maxActiveSessions: 0 } },
];

const tasks = [
  { key: "sync-installations", description: "Reconcile GitHub App installations with the classrooms", webhookWoken: true, enabled: true, intervalMinutes: 60, defaultIntervalMinutes: 60, lastRunAt: iso(-20 * 60_000), lastStatus: "ok", lastError: null, lastDurationMs: 1_240 },
  { key: "enforce-deadlines", description: "Lock or mark repositories whose deadline has passed", webhookWoken: false, enabled: true, intervalMinutes: 5, defaultIntervalMinutes: 5, lastRunAt: iso(-3 * 60_000), lastStatus: "ok", lastError: null, lastDurationMs: 310 },
  { key: "collect-grades", description: "Pull grade annotations from completed workflow runs", webhookWoken: true, enabled: true, intervalMinutes: 15, defaultIntervalMinutes: 15, lastRunAt: iso(-9 * 60_000), lastStatus: "error", lastError: "GitHub API rate limit exceeded for installation 88213", lastDurationMs: 8_100 },
  { key: "publish-scheduled", description: "Publish drafts whose start date has come", webhookWoken: false, enabled: false, intervalMinutes: 10, defaultIntervalMinutes: 10, lastRunAt: null, lastStatus: null, lastError: null, lastDurationMs: null },
];

// --- Scene flags: reshape the fixtures before the first request ---

/** `?many=1`: 30 classrooms, and 120 students / 40 assignments on the first. */
function inflate() {
  const first = rooms[0]!;
  first.students = makeStudents(120, 0.8, "c1");
  const topics = ["Strings", "Structs", "Recursion", "Sorting", "Files", "Makefiles", "Unit tests", "Pointers"];
  for (let i = first.assignments.length; i < 40; i += 1) {
    const deadline = (i - 24) * 3 * D;
    first.assignments.push(
      assignment(`am${i}`, `Lab ${i + 1} — ${topics[i % topics.length]}`, first.summary.orgLogin, {
        start: deadline - 7 * D,
        deadline,
        state: deadline < 0 ? "locked" : i % 7 === 0 ? "draft" : "published",
      }),
    );
  }
  for (let i = rooms.length; i < 30; i += 1) {
    const org = `heig-course-${i + 1}`;
    rooms.push({
      summary: {
        id: `c${i + 10}`,
        name: `Course ${i + 1} — ${topics[i % topics.length]}`,
        orgLogin: org,
        createdAt: iso(-(20 + i) * D),
        archivedAt: null,
        isOwner: i % 4 !== 0,
      },
      org: { login: org, installationId: 90_000 + i, githubOrgId: 192_000_000 + i, plan: "team", status: "active", exists: true, llmSecret: "ok" },
      students: makeStudents(6 + (i % 24), 0.7, `c${i + 10}`),
      staff: [],
      assignments: [
        assignment(`x${i}`, `Project ${i + 1}`, org, { start: -(i % 10) * D, deadline: (14 - (i % 10)) * D }),
      ],
      archivedAssignments: new Set(),
      teacher: "Ada Lovelace",
    });
  }
}

/** `?empty=1`: keep the classrooms addressable, but strip every collection. */
function strip() {
  for (const r of [...rooms, ...archivedRooms]) {
    r.students = [];
    r.staff = [];
    r.assignments = [];
    r.archivedAssignments = new Set();
  }
  teachers.length = 0;
  tasks.length = 0;
  milestones.clear();
}

if (flags.many) inflate();
if (flags.empty) strip();

// --- Org repositories (assignment form) ---

const orgRepos: OrgRepo[] = [
  { name: "lab-05-strings", defaultBranch: "main" },
  { name: "lab-06-structs", defaultBranch: "main" },
  { name: "project-2026", defaultBranch: "main" },
  { name: "exam-template", defaultBranch: "master" },
];

const repoTree = (name: string): RepoTree => ({
  name,
  defaultBranch: "main",
  branches: ["main", "solution"],
  headSha: sha(),
  headDate: iso(-2 * D),
  tree: [
    { path: ".github", type: "tree" },
    { path: ".github/workflows", type: "tree" },
    { path: ".github/workflows/grade.yml", type: "blob" },
    { path: "criteria.yml", type: "blob" },
    { path: "README.md", type: "blob" },
    { path: "Makefile", type: "blob" },
    { path: "src", type: "tree" },
    { path: "src/main.c", type: "blob" },
    { path: "src/util.c", type: "blob" },
    { path: "src/util.h", type: "blob" },
    { path: "tests", type: "tree" },
    { path: "tests/test_main.c", type: "blob" },
    { path: "tests/test_util.c", type: "blob" },
  ],
  truncated: false,
  suggestedProtected: [".github/workflows/grade.yml", "criteria.yml", "tests/test_main.c", "tests/test_util.c"],
});

// --- Router ---

class MockError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * Extra fields of the JSON body. The group endpoints answer a 409 with a
     * named `error` the page branches on (`has_repo`, `duplicate_name`,
     * `group_mode_off`, `unassigned_students`), so the mock has to carry more
     * than a message.
     */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type Handler = (m: RegExpMatchArray, body: Record<string, unknown>, url: URL) => unknown;
const routes: { method: string; re: RegExp; h: Handler }[] = [];
const on = (method: string, path: string, h: Handler) =>
  routes.push({ method, re: new RegExp(`^${path.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), h });

const roomOr404 = (id: string, includeArchived = false) => {
  const r = [...rooms, ...(includeArchived ? archivedRooms : [])].find((x) => x.summary.id === id);
  if (!r) throw new MockError(404, "Classroom not found");
  return r;
};
const assignmentOr404 = (room: Room, id: string) => {
  const a = room.assignments.find((x) => x.id === id);
  if (!a) throw new MockError(404, "Assignment not found");
  return a;
};
let seq = 100;
const nextId = (p: string) => `${p}${(seq += 1)}`;

on("GET", "/app/api/me", () => {
  if (!me) throw new MockError(401, "Signed out");
  return me;
});
on("PATCH", "/app/api/me", (_m, body) => {
  if (me) me = { ...me, ...(body as Partial<Me>), emailPrefs: { ...me.emailPrefs, ...((body.emailPrefs as Record<string, boolean>) ?? {}) } };
  return me;
});
on("PUT", "/app/api/me/avatar", () => undefined);
on("DELETE", "/app/api/me/avatar", () => undefined);
on("POST", "/app/auth/logout", () => {
  me = null;
  return undefined;
});
on("POST", "/app/auth/github/unlink", () => {
  if (me) me = { ...me, githubLogin: null };
  return undefined;
});
on("GET", "/app/api/orgs", () =>
  flags.empty ? [] : ["heig-prg1-2026", "heig-info2-tinb", "heig-tin-info"],
);

on("GET", "/app/api/classrooms", (_m, _b, url) =>
  flags.empty ? [] : (url.searchParams.get("archived") ? archivedRooms : rooms).map(summaryOf),
);
on("POST", "/app/api/classrooms", (_m, body) => {
  const id = nextId("c");
  const room: Room = {
    summary: { id, name: String(body.name), orgLogin: String(body.orgLogin), createdAt: at(0), archivedAt: null, isOwner: true },
    org: { login: String(body.orgLogin), installationId: null, githubOrgId: null, plan: null, status: "active", exists: true, llmSecret: null },
    students: [],
    staff: [],
    assignments: [],
    archivedAssignments: new Set(),
    teacher: "Ada Lovelace",
  };
  rooms.push(room);
  return summaryOf(room);
});
on("GET", "/app/api/classrooms/:id", (m) => detailOf(roomOr404(m.groups!.id!)));
on("PATCH", "/app/api/classrooms/:id", (m, body) => {
  const r = roomOr404(m.groups!.id!);
  if (typeof body.name === "string") r.summary.name = body.name;
  return detailOf(r);
});
on("DELETE", "/app/api/classrooms/:id", (m) => {
  const i = rooms.findIndex((r) => r.summary.id === m.groups!.id);
  if (i >= 0) rooms.splice(i, 1);
  return undefined;
});
on("POST", "/app/api/classrooms/:id/archive", (m) => {
  const i = rooms.findIndex((r) => r.summary.id === m.groups!.id);
  if (i >= 0) {
    const [r] = rooms.splice(i, 1);
    r!.summary.archivedAt = at(0);
    archivedRooms.push(r!);
  }
  return undefined;
});
on("POST", "/app/api/classrooms/:id/unarchive", (m) => {
  const i = archivedRooms.findIndex((r) => r.summary.id === m.groups!.id);
  if (i >= 0) {
    const [r] = archivedRooms.splice(i, 1);
    r!.summary.archivedAt = null;
    rooms.push(r!);
  }
  return undefined;
});
on("POST", "/app/api/classrooms/:id/self-enroll", (m) => {
  const r = roomOr404(m.groups!.id!);
  if (me && !r.students.some((s) => s.email === me!.email)) {
    r.students.push({ id: nextId("s"), nom: me.familyName, prenom: me.givenName, email: me.email, status: "claimed", conflictFlag: false, staff: true, githubLogin: me.githubLogin, lastLoginAt: at(0) });
  }
  return undefined;
});
on("GET", "/app/api/classrooms/:id/grades", (m): ClassroomGradesPayload => {
  const r = roomOr404(m.groups!.id!);
  const graded = r.assignments.filter((a) => a.gradingMode === "auto" && a.state !== "draft");
  return {
    classroom: { id: r.summary.id, name: r.summary.name },
    assignments: graded.map((a) => ({ id: a.id, name: a.name, deadlineAt: a.deadlineAt, gradesValidatedAt: validated.get(a.id) ?? null })),
    students: r.students.filter((s) => !s.staff).map((s) => ({
      enrollmentId: s.id, nom: s.nom, prenom: s.prenom, email: s.email, status: s.status,
      points: Object.fromEntries(graded.map((a) => [a.id, repoStatesOf(r, a).get(s.id)?.grade?.points ?? null])),
    })),
  };
});
on("POST", "/app/api/classrooms/:id/staff", (m, body) => {
  const r = roomOr404(m.groups!.id!);
  if (r.staff.some((s) => s.email === body.email)) throw new MockError(409, "Already on the staff");
  r.staff.push({ id: nextId("st"), email: String(body.email), role: body.role as ClassroomStaffMember["role"], givenName: null, familyName: null, claimed: false, createdAt: at(0) });
  return undefined;
});
on("DELETE", "/app/api/classrooms/:id/staff/:sid", (m) => {
  const r = roomOr404(m.groups!.id!);
  r.staff = r.staff.filter((s) => s.id !== m.groups!.sid);
  return undefined;
});
on("POST", "/app/api/classrooms/:id/roster", (m, body) => {
  const r = roomOr404(m.groups!.id!);
  const rowsIn = (body.rows as (string | null)[][] | undefined) ?? [];
  for (const row of rowsIn.slice(1)) {
    const [nom, prenom, email] = row;
    if (!nom || !prenom || !email) continue;
    r.students.push({ id: nextId("s"), nom, prenom, email, status: "pending", conflictFlag: false, staff: false, githubLogin: null, lastLoginAt: null });
  }
  if (rowsIn.length === 0) {
    // CSV text: add three placeholder students so the flow shows something.
    for (let i = 0; i < 3; i += 1) r.students.push(...makeStudents(1, 0, nextId("s")));
  }
  return { imported: Math.max(rowsIn.length - 1, 3) };
});
on("PATCH", "/app/api/classrooms/:id/roster/:sid", (m, body) => {
  const r = roomOr404(m.groups!.id!);
  const s = r.students.find((x) => x.id === m.groups!.sid);
  if (s) Object.assign(s, body);
  return undefined;
});
on("DELETE", "/app/api/classrooms/:id/roster/:sid", (m) => {
  const r = roomOr404(m.groups!.id!);
  r.students = r.students.filter((x) => x.id !== m.groups!.sid);
  return undefined;
});
on("POST", "/app/api/classrooms/:id/roster/:sid/unclaim", (m) => {
  const r = roomOr404(m.groups!.id!);
  const s = r.students.find((x) => x.id === m.groups!.sid);
  if (s) Object.assign(s, { status: "pending", conflictFlag: false, githubLogin: null });
  return undefined;
});

on("GET", "/app/api/classrooms/:id/org-repos", () => orgRepos);
on("GET", "/app/api/classrooms/:id/org-repos/:name/tree", (m) => repoTree(m.groups!.name!));

on("GET", "/app/api/classrooms/:id/assignments", (m, _b, url) => {
  const r = roomOr404(m.groups!.id!);
  const archived = Boolean(url.searchParams.get("archived"));
  return r.assignments.filter((a) => r.archivedAssignments.has(a.id) === archived);
});
on("POST", "/app/api/classrooms/:id/assignments", (m, body) => {
  const r = roomOr404(m.groups!.id!);
  const b = body as Partial<Assignment> & { sourceRepo?: string };
  const a = assignment(nextId("a"), String(b.name), r.summary.orgLogin, {
    start: b.startAt ? new Date(b.startAt).getTime() - now : 0,
    deadline: b.deadlineAt ? new Date(b.deadlineAt).getTime() - now : 0,
    state: "draft",
    sourceFullName: `${r.summary.orgLogin}/${b.sourceRepo ?? "repo"}`,
    squashedFullName: `${r.summary.orgLogin}/${b.sourceRepo ?? "repo"}-squashed`,
    publishMode: b.publishMode ?? "manual",
    durationMinutes: b.durationMinutes ?? null,
    gradingMode: b.gradingMode ?? "auto",
    deadlineStrategy: b.deadlineStrategy ?? "lock",
    sourceStrategy: b.sourceStrategy ?? "squash",
    protectedFiles: b.protectedFiles ?? [],
    workMode: b.workMode ?? "free",
    codespaceImage: b.codespaceImage || null,
    browserExamKeys: b.browserExamKeys ?? [],
  });
  r.assignments.push(a);
  return a;
});
on("PATCH", "/app/api/classrooms/:id/assignments/:aid", (m, body) => {
  const r = roomOr404(m.groups!.id!);
  const a = assignmentOr404(r, m.groups!.aid!);
  Object.assign(a, body);
  return a;
});
on("DELETE", "/app/api/classrooms/:id/assignments/:aid", (m) => {
  const r = roomOr404(m.groups!.id!);
  r.assignments = r.assignments.filter((a) => a.id !== m.groups!.aid);
  return undefined;
});
on("POST", "/app/api/classrooms/:id/assignments/:aid/publish", (m) => {
  const r = roomOr404(m.groups!.id!);
  const a = assignmentOr404(r, m.groups!.aid!);
  // Group mode: nobody may be left out, and there has to be a group at all.
  // Refused before any state change, exactly like the server.
  if (a.groupMode) {
    const payload = groupsPayload(r, a);
    if (payload.groups.length === 0 || payload.unassigned.length > 0) {
      const left = payload.unassigned;
      // No group at all with nobody to place (an empty roster) carries no
      // name: the message is the whole answer, and groups of one would
      // create nothing, so the dialog only offers the groups screen.
      throw new MockError(
        409,
        left.length
          ? `${left.length} student${left.length === 1 ? " is" : "s are"} not in any group`
          : "This assignment has no group yet — form at least one before publishing.",
        {
          error: "unassigned_students",
          students: left.map((s) => ({ enrollmentId: s.enrollmentId, nom: s.nom, prenom: s.prenom })),
        },
      );
    }
  }
  a.state = "published";
  a.startAt = at(0);
  if (a.durationMinutes) a.deadlineAt = at(a.durationMinutes * 60_000);
  return undefined;
});
on("POST", "/app/api/classrooms/:id/assignments/:aid/archive", (m) => {
  roomOr404(m.groups!.id!).archivedAssignments.add(m.groups!.aid!);
  return undefined;
});
on("POST", "/app/api/classrooms/:id/assignments/:aid/unarchive", (m) => {
  roomOr404(m.groups!.id!).archivedAssignments.delete(m.groups!.aid!);
  return undefined;
});
on("GET", "/app/api/classrooms/:id/assignments/:aid/detail", (m) => {
  const r = roomOr404(m.groups!.id!);
  return assignmentDetail(r, assignmentOr404(r, m.groups!.aid!));
});
on("POST", "/app/api/classrooms/:id/assignments/:aid/sync", () => undefined);
on("POST", "/app/api/classrooms/:id/assignments/:aid/codespace-sync", () => undefined);
on("POST", "/app/api/classrooms/:id/assignments/:aid/validate-grades", (m) => {
  validated.set(m.groups!.aid!, at(0));
  return undefined;
});
on("GET", "/app/api/classrooms/:id/assignments/:aid/milestones", (m) => milestones.get(m.groups!.aid!) ?? []);
on("POST", "/app/api/classrooms/:id/assignments/:aid/milestones", (m, body) => {
  const r = roomOr404(m.groups!.id!);
  const a = assignmentOr404(r, m.groups!.aid!);
  const list = milestones.get(a.id) ?? [];
  const offsetDays = typeof body.offsetDays === "number" ? body.offsetDays : null;
  const dueAt = offsetDays !== null ? new Date(new Date(a.deadlineAt).getTime() + offsetDays * D).toISOString() : String(body.dueAt);
  list.push({ id: nextId("m"), name: String(body.name), dueAt, offsetDays, dispatchedAt: null });
  milestones.set(a.id, list);
  return undefined;
});
on("DELETE", "/app/api/classrooms/:id/assignments/:aid/milestones/:mid", (m) => {
  milestones.set(m.groups!.aid!, (milestones.get(m.groups!.aid!) ?? []).filter((x) => x.id !== m.groups!.mid));
  return undefined;
});
// --- Group routes (issue #2, lot 1) ---
//
// Same URLs, bodies and 409 shapes as the server module, so the page is
// exercised against what it will actually meet in production.

/** Classroom, assignment and its groups, or the 404/409 the server sends. */
const groupsCtx = (m: RegExpMatchArray) => {
  const r = roomOr404(m.groups!.id!);
  const a = assignmentOr404(r, m.groups!.aid!);
  if (!a.groupMode) throw new MockError(409, "This assignment is not in group mode", { error: "group_mode_off" });
  return { r, a, list: groupsOf(r, a) };
};
const groupOr404 = (list: MockGroup[], gid: string) => {
  const g = list.find((x) => x.id === gid);
  if (!g) throw new MockError(404, "Group not found");
  return g;
};
/** A group whose repository exists is frozen until lot 2 can revoke access. */
const notLocked = (g: MockGroup) => {
  if (g.repo) {
    throw new MockError(409, `“${g.name}” already has a repository`, { error: "has_repo" });
  }
  return g;
};
const uniqueName = (list: MockGroup[], name: string, exceptId?: string) => {
  const slug = slugify(name);
  if (list.some((x) => x.id !== exceptId && (x.name === name || x.slug === slug))) {
    throw new MockError(409, `Another group is already called “${name}”`, {
      error: "duplicate_name",
    });
  }
  return slug;
};
/** `Group N` with the first free N, like the server. */
const defaultName = (list: MockGroup[]) => {
  let n = 1;
  while (list.some((g) => g.name === `Group ${n}`)) n += 1;
  return `Group ${n}`;
};

on("GET", "/app/api/classrooms/:id/assignments/:aid/groups", (m) => {
  const { r, a } = groupsCtx(m);
  return groupsPayload(r, a);
});
on("POST", "/app/api/classrooms/:id/assignments/:aid/groups", (m, body) => {
  const { r, list } = groupsCtx(m);
  const name =
    typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : defaultName(list);
  const g: MockGroup = {
    id: nextId("g"),
    name,
    slug: uniqueName(list, name),
    position: list.length,
    members: [],
    repo: null,
  };
  list.push(g);
  return groupView(r, g);
});
on("PATCH", "/app/api/classrooms/:id/assignments/:aid/groups/:gid", (m, body) => {
  const { r, list } = groupsCtx(m);
  const g = notLocked(groupOr404(list, m.groups!.gid!));
  const name = String(body.name ?? "").trim();
  g.slug = uniqueName(list, name, g.id);
  g.name = name;
  return groupView(r, g);
});
on("DELETE", "/app/api/classrooms/:id/assignments/:aid/groups/:gid", (m) => {
  const { a, list } = groupsCtx(m);
  const g = notLocked(groupOr404(list, m.groups!.gid!));
  groups.set(
    a.id,
    list.filter((x) => x.id !== g.id).map((x, i) => ({ ...x, position: i })),
  );
  return undefined;
});
on("POST", "/app/api/classrooms/:id/assignments/:aid/groups/copy", (m, body) => {
  const { r, a, list } = groupsCtx(m);
  list.forEach(notLocked);
  const from = r.assignments.find((x) => x.id === body.fromAssignmentId && x.groupMode);
  if (!from) throw new MockError(404, "Source assignment not found");
  const roster = new Set(r.students.map((s) => s.id));
  groups.set(
    a.id,
    groupsOf(r, from).map((g, i) => ({
      id: nextId("g"),
      name: g.name,
      slug: g.slug,
      position: i,
      members: g.members.filter((id) => roster.has(id)),
      repo: null,
    })),
  );
  return groupsPayload(r, a);
});
on("POST", "/app/api/classrooms/:id/assignments/:aid/groups/split", (m, body) => {
  const { r, a, list } = groupsCtx(m);
  const size = Math.min(10, Math.max(2, Number(body.size) || 2));
  const left = groupsPayload(r, a).unassigned;
  for (let i = 0; i < left.length; i += size) {
    const name = defaultName(list);
    list.push({
      id: nextId("g"),
      name,
      slug: slugify(name),
      position: list.length,
      members: left.slice(i, i + size).map((s) => s.enrollmentId),
      repo: null,
    });
  }
  return groupsPayload(r, a);
});
on("POST", "/app/api/classrooms/:id/assignments/:aid/groups/singles", (m) => {
  const { r, a, list } = groupsCtx(m);
  for (const s of groupsPayload(r, a).unassigned) {
    const name = `${s.prenom} ${s.nom}`;
    let slug = slugify(name);
    for (let n = 2; list.some((g) => g.slug === slug); n += 1) slug = `${slugify(name)}-${n}`;
    list.push({
      id: nextId("g"),
      name,
      slug,
      position: list.length,
      members: [s.enrollmentId],
      repo: null,
    });
  }
  return groupsPayload(r, a);
});
on("POST", "/app/api/classrooms/:id/assignments/:aid/groups/:gid/members", (m, body) => {
  const { r, a, list } = groupsCtx(m);
  const g = groupOr404(list, m.groups!.gid!);
  const enrollmentId = String(body.enrollmentId ?? "");
  if (!r.students.some((s) => s.id === enrollmentId && !s.staff)) {
    throw new MockError(404, "Student not found in this classroom");
  }
  // Moving out of the previous group is a removal, so a locked one refuses.
  const previous = list.find((x) => x.members.includes(enrollmentId));
  if (previous && previous.id !== g.id) {
    notLocked(previous);
    previous.members = previous.members.filter((id) => id !== enrollmentId);
  }
  if (!g.members.includes(enrollmentId)) g.members.push(enrollmentId);
  return groupsPayload(r, a);
});
on("DELETE", "/app/api/classrooms/:id/assignments/:aid/groups/:gid/members/:eid", (m) => {
  const { r, a, list } = groupsCtx(m);
  const g = notLocked(groupOr404(list, m.groups!.gid!));
  g.members = g.members.filter((id) => id !== m.groups!.eid);
  return groupsPayload(r, a);
});

const repoOf = (m: RegExpMatchArray) => {
  const r = roomOr404(m.groups!.id!);
  const a = assignmentOr404(r, m.groups!.aid!);
  for (const st of repoStatesOf(r, a).values()) if (st && st.id === m.groups!.rid) return { r, a, st };
  throw new MockError(404, "Repository not found");
};
on("POST", "/app/api/classrooms/:id/assignments/:aid/repos/:rid/lock", (m) => {
  repoOf(m).st.lockedAt = at(0);
  return undefined;
});
on("POST", "/app/api/classrooms/:id/assignments/:aid/repos/:rid/unlock", (m) => {
  repoOf(m).st.lockedAt = null;
  return undefined;
});
on("POST", "/app/api/classrooms/:id/assignments/:aid/repos/:rid/grade-now", () => undefined);
on("PATCH", "/app/api/classrooms/:id/assignments/:aid/repos/:rid/grade", (m, body) => {
  const { st } = repoOf(m);
  st.teacherPoints = (body.points as number | null) ?? null;
  st.teacherComment = (body.comment as string | null) ?? null;
  return undefined;
});
on("GET", "/app/api/classrooms/:id/assignments/:aid/repos/:rid/grade-runs", (m): GradeRunHistory => {
  const { st } = repoOf(m);
  const runs = Array.from({ length: 6 }, (_, i) => ({
    ...grade(Math.max(0, (st.grade?.points ?? 5) - (5 - i) * 0.5), 10, "ci" as const, (6 - i) * D),
    id: `run${i}`,
    workflowRunId: 9000 + i,
    runAttempt: i === 2 ? 2 : 1,
    afterDeadline: false,
  })).reverse();
  return { currentGradeRunId: "run5", frozenGradeRunId: st.frozenGrade ? "run5" : null, llmGradeRunId: null, runs };
});
on("GET", "/app/api/classrooms/:id/assignments/:aid/repos/:rid/activity", (m): ActivityData => {
  const { st } = repoOf(m);
  const n = st.commitCount;
  const shas = Array.from({ length: n }, () => sha());
  const commits = shas.map((s, i) => ({
    sha: s,
    message: pick(["Fix off-by-one in loop", "Add tests for util", "Implement parser", "Refactor main", "WIP", "Clean up Makefile", "Handle empty input", "Update README"]),
    author: "marie-dupo",
    date: iso(-(n - i) * 0.4 * D),
    parents: i + 1 < n ? [shas[i + 1]!] : [],
  }));
  return {
    commits,
    branches: [{ name: "main", headSha: shas[0]! }],
    tests: commits.slice(0, 8).reverse().map((c, i) => ({ date: c.date!, passed: Math.min(12, 2 + i * 2), total: 12 })),
  };
});

on("GET", "/app/api/student/classrooms", () => studentRooms());
on("POST", "/app/api/student/assignments/:aid/accept", (m) => {
  studentAccepted.add(m.groups!.aid!);
  return undefined;
});

on("GET", "/app/api/admin/teachers", () => teachers);
on("POST", "/app/api/admin/teachers", (_m, body) => {
  teachers.push({ id: nextId("t"), email: String(body.email), givenName: null, familyName: null, signedUp: false, classrooms: 0, assignments: 0, lastLoginAt: null, grantedAt: at(0), codespace: { enabled: false, maxActiveSessions: 0 } });
  return undefined;
});
on("PATCH", "/app/api/admin/teachers/:tid", (m, body) => {
  const t = teachers.find((x) => x.id === m.groups!.tid);
  if (t) t.codespace = { ...t.codespace, ...(body.codespace as object) };
  return undefined;
});
on("DELETE", "/app/api/admin/teachers/:tid", (m) => {
  const i = teachers.findIndex((x) => x.id === m.groups!.tid);
  if (i >= 0) teachers.splice(i, 1);
  return undefined;
});
on("GET", "/app/api/admin/tasks", () => tasks);
on("PATCH", "/app/api/admin/tasks/:key", (m, body) => {
  const t = tasks.find((x) => x.key === m.groups!.key);
  if (t) Object.assign(t, body);
  return undefined;
});
on("POST", "/app/api/admin/tasks/:key/run", (m) => {
  const t = tasks.find((x) => x.key === m.groups!.key);
  if (t) Object.assign(t, { lastRunAt: at(0), lastStatus: "ok", lastError: null, lastDurationMs: 420 });
  return undefined;
});

// --- fetch / EventSource interception ---

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(raw, window.location.origin);
  if (!url.pathname.startsWith("/app/")) return realFetch(input, init);
  await new Promise((r) => setTimeout(r, LATENCY()));
  const method = (init?.method ?? "GET").toUpperCase();
  // `?fail=1`: every read fails, except the session — the shell must still
  // render so the failing page is the one under test.
  if (flags.fail && method === "GET" && url.pathname !== "/app/api/me") {
    return new Response(JSON.stringify({ message: "Simulated failure" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  let body: Record<string, unknown> = {};
  if (typeof init?.body === "string" && init.body.startsWith("{")) {
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    try {
      const result = r.h(m, body, url);
      if (result === undefined) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      if (e instanceof MockError) {
        return new Response(JSON.stringify({ message: e.message, ...e.extra }), {
          status: e.status,
          headers: { "content-type": "application/json" },
        });
      }
      throw e;
    }
  }
  console.warn(`[mock] no route for ${method} ${url.pathname}`);
  return new Response(JSON.stringify({ message: "Not mocked" }), { status: 404 });
};

// SSE is a refresh hint channel; the mock simply never emits.
class MockEventSource {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  close() {}
}
(window as unknown as { EventSource: unknown }).EventSource = MockEventSource;

const on_ = FLAG_NAMES.filter((f) => flags[f]);
console.info(
  `[mock] persona: ${role} — switch with ?as=teacher|student|admin` +
    `\n[mock] scene flags: ${on_.length ? on_.join(", ") : "none"} — ?empty=1 ?fail=1 ?slow=1 ?many=1 (append =0 to clear)`,
);
