import type {
  Assignment,
  AssignmentDetailPayload,
  AssignmentDetailRepo,
  AssignmentDetailStudent,
  AssignmentGroup,
  AssignmentGroupsPayload,
  ClassroomDetail,
  ClassroomSummary,
  GradeView,
  GroupMember,
  Me,
  RosterEntry,
  StudentAssignment,
  StudentClassroom,
  StudentRepo,
} from "@hgc/contracts";

/*
 * Payload fixtures, typed against @hgc/contracts on purpose: when the wire
 * format moves, these stop compiling and the page tests are told about it
 * instead of silently asserting on a shape the server no longer sends.
 *
 * Dates are offsets from one instant captured when this module loads, not
 * literals: "the deadline is four days away" has to stay true whenever the
 * suite runs, and a hard-coded 2026 date would quietly become a past deadline
 * and change which branch of a component renders. No test asserts on a
 * formatted date or on a countdown for the same reason.
 */

/** Reference instant of the fixtures, captured once per test file. */
export const NOW = new Date();
const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** ISO string `offsetMs` away from `NOW`. */
export const at = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();

export function makeMe(overrides: Partial<Me> = {}): Me {
  return {
    id: "u-1",
    email: "marie.dupont@heig-vd.ch",
    givenName: "Marie",
    familyName: "Dupont",
    role: "teacher",
    githubLogin: "marie-dup",
    lastLoginAt: at(-DAY),
    avatarUrl: null,
    hasUploadedAvatar: false,
    locale: "en",
    dateFormat: "iso",
    emailPrefs: {},
    codespace: null,
    codespaceHost: null,
    ...overrides,
  };
}

export function makeClassroomSummary(overrides: Partial<ClassroomSummary> = {}): ClassroomSummary {
  return {
    id: "c1",
    name: "PRG1 2026",
    orgLogin: "heig-prg1-2026",
    createdAt: at(-40 * DAY),
    archivedAt: null,
    isOwner: true,
    students: 24,
    claimed: 20,
    assignments: [
      {
        id: "a1",
        name: "Labo 02 quadratic",
        state: "published",
        startAt: at(-3 * DAY),
        deadlineAt: at(4 * DAY),
      },
    ],
    roster: [{ nom: "Dupont", prenom: "Marie", claimed: true, staff: false }],
    ...overrides,
  };
}

export function makeRosterEntry(overrides: Partial<RosterEntry> = {}): RosterEntry {
  return {
    id: "e-1",
    nom: "Rochat",
    prenom: "Lucas",
    email: "lucas.rochat@heig-vd.ch",
    status: "claimed",
    conflictFlag: false,
    staff: false,
    githubLogin: "lucas-roch",
    lastLoginAt: at(-DAY),
    avatarUrl: null,
    hasUploadedAvatar: false,
    ...overrides,
  };
}

export function makeClassroomDetail(overrides: Partial<ClassroomDetail> = {}): ClassroomDetail {
  return {
    id: "c1",
    name: "PRG1 2026",
    org: {
      login: "heig-prg1-2026",
      installationId: 4242,
      githubOrgId: 99,
      plan: "team",
      status: "active",
      exists: true,
      llmSecret: "ok",
    },
    roster: [makeRosterEntry()],
    staff: [],
    isOwner: true,
    appSlug: "heig-classroom",
    ...overrides,
  };
}

export function makeAssignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: "a1",
    name: "Labo 02 quadratic",
    slug: "labo-02-quadratic",
    state: "published",
    startAt: at(-3 * DAY),
    deadlineAt: at(4 * DAY),
    graceMinutes: 30,
    sourceFullName: "heig-prg1-2026/labo-02-quadratic",
    squashedFullName: "heig-prg1-2026/labo-02-quadratic-squashed",
    sourceStrategy: "squash",
    deadlineStrategy: "lock",
    gradingMode: "auto",
    publishMode: "scheduled",
    durationMinutes: null,
    branches: ["main"],
    protectedFiles: [],
    workMode: "free",
    codespaceImage: null,
    browserExamKeys: [],
    groupMode: false,
    groupMaxSize: null,
    ...overrides,
  };
}

export function makeGrade(overrides: Partial<GradeView> = {}): GradeView {
  return {
    points: 4.5,
    max: 6,
    testsPassed: 8,
    testsTotal: 10,
    parseStatus: "ok",
    conclusion: "success",
    sha: "0".repeat(40),
    branch: "main",
    kind: "ci",
    afterDeadline: false,
    completedAt: at(-HOUR),
    ...overrides,
  };
}

export function makeDetailRepo(overrides: Partial<AssignmentDetailRepo> = {}): AssignmentDetailRepo {
  return {
    id: "r-1",
    fullName: "heig-prg1-2026/labo-02-quadratic-lucas",
    provisionStatus: "ok",
    provisionError: null,
    invitationStatus: "accepted",
    acceptedAt: at(-2 * DAY),
    lockedAt: null,
    syncPr: null,
    grade: makeGrade(),
    frozenGrade: null,
    llmGrade: null,
    teacherPoints: null,
    teacherComment: null,
    lastCommitSha: "abcdef1234567890",
    lastCommitAt: at(-HOUR),
    commitCount: 7,
    checksPassed: 8,
    checksTotal: 10,
    ciStatus: "pass",
    ...overrides,
  };
}

export function makeDetailStudent(
  overrides: Partial<AssignmentDetailStudent> = {},
): AssignmentDetailStudent {
  return {
    enrollmentId: "e-1",
    nom: "Rochat",
    prenom: "Lucas",
    email: "lucas.rochat@heig-vd.ch",
    claimStatus: "claimed",
    githubLogin: "lucas-roch",
    repo: makeDetailRepo(),
    ...overrides,
  };
}

export function makeAssignmentDetail(
  assignment: Partial<AssignmentDetailPayload["assignment"]> = {},
  students: AssignmentDetailStudent[] = [makeDetailStudent()],
): AssignmentDetailPayload {
  return {
    assignment: {
      id: "a1",
      name: "Labo 02 quadratic",
      slug: "labo-02-quadratic",
      classroom: "PRG1 2026",
      state: "published",
      startAt: at(-3 * DAY),
      deadlineAt: at(4 * DAY),
      graceMinutes: 30,
      gradingMode: "auto",
      frozenAt: null,
      llmDispatchedAt: null,
      gradesValidatedAt: null,
      sourceAheadSha: null,
      sourcePushedAt: null,
      syncedAt: at(-3 * DAY),
      workMode: "free",
      codespaceImage: null,
      browserExamKeys: [],
      codespaceSyncedAt: null,
      codespaceSyncError: null,
      codespaceConfigKey: null,
      codespaceSebUrl: null,
      groupMode: false,
      groupMaxSize: null,
      ...assignment,
    },
    students,
  };
}

export function makeGroupMember(overrides: Partial<GroupMember> = {}): GroupMember {
  return {
    enrollmentId: "e-1",
    nom: "Rochat",
    prenom: "Lucas",
    email: "lucas.rochat@heig-vd.ch",
    claimStatus: "claimed",
    githubLogin: "lucas-roch",
    avatarUrl: null,
    ...overrides,
  };
}

export function makeGroup(overrides: Partial<AssignmentGroup> = {}): AssignmentGroup {
  return {
    id: "g-1",
    name: "Group 1",
    slug: "group-1",
    members: [],
    repo: null,
    ...overrides,
  };
}

export function makeGroupsPayload(
  overrides: Partial<AssignmentGroupsPayload> = {},
): AssignmentGroupsPayload {
  return {
    assignment: {
      id: "a1",
      name: "Labo 02 quadratic",
      state: "draft",
      groupMode: true,
      groupMaxSize: null,
    },
    groups: [makeGroup()],
    unassigned: [],
    copySources: [],
    ...overrides,
  };
}

export function makeStudentRepo(overrides: Partial<StudentRepo> = {}): StudentRepo {
  return {
    fullName: "heig-prg1-2026/labo-02-quadratic-lucas",
    provisionStatus: "ok",
    invitationStatus: "accepted",
    ciStatus: "pass",
    lockedAt: null,
    commitCount: 7,
    checksPassed: 8,
    checksTotal: 10,
    grade: makeGrade(),
    llmGrade: null,
    gradeFrozen: false,
    teacherPoints: null,
    ...overrides,
  };
}

export function makeStudentAssignment(
  overrides: Partial<StudentAssignment> = {},
): StudentAssignment {
  return {
    id: "a1",
    name: "Labo 02 quadratic",
    state: "published",
    startAt: at(-3 * DAY),
    deadlineAt: at(4 * DAY),
    graceMinutes: 30,
    gradingMode: "auto",
    gradesValidatedAt: null,
    workMode: "free",
    repo: makeStudentRepo(),
    ...overrides,
  };
}

export function makeStudentClassroom(
  overrides: Partial<StudentClassroom> = {},
): StudentClassroom {
  return {
    id: "c1",
    name: "PRG1 2026",
    orgLogin: "heig-prg1-2026",
    teacher: "Marie Dupont",
    assignments: [makeStudentAssignment()],
    ...overrides,
  };
}
