import { describe, expect, it } from "vitest";

import type { NoticeKind } from "@hgc/contracts";

import {
  type AppEvent,
  type Audience,
  type EventType,
  classroomTopics,
  noticeFor,
  reaches,
  STUDENT_ACTIVITY_KINDS,
  staffTopic,
} from "./events.js";

const audience = (topics: string[], studentActivity: string[] = []): Audience => ({
  topics: new Set(topics),
  studentActivity: new Set(studentActivity),
});

/** Alice, student of c1. */
const student = audience(["user:alice", "classroom:c1"]);
/** Owner of c1: student toasts on by default. */
const owner = audience(["user:t", "teacher:t", "classroom-staff:c1"], ["c1"]);
/** Co-teacher of c1 who never opted in. */
const coTeacher = audience(["user:co", "teacher:co", "classroom-staff:c1"]);
/** The same co-teacher after turning "Notify me about students" on. */
const coTeacherOptedIn = audience(["user:co", "teacher:co", "classroom-staff:c1"], ["c1"]);
/** Teacher of another classroom only. */
const otherTeacher = audience(["user:o", "teacher:o", "classroom-staff:c2"], ["c2"]);

const ALL_KINDS: NoticeKind[] = [
  "student_joined",
  "assignment_accepted",
  "commit_pushed",
  "grade_captured",
  "protected_reverted",
  "deadline_applied",
  "llm_review_dispatched",
  "sync",
];

describe("reaches", () => {
  it("keeps a classmate's repository and grade events away from students", () => {
    const push: AppEvent = { type: "repos", topics: [staffTopic("c1"), "user:bob"] };
    const grade: AppEvent = {
      type: "grades",
      topics: [staffTopic("c1"), "user:bob"],
      notice: { kind: "grade_captured", message: "Grade 8/10 captured on labo02-bob" },
    };
    expect(reaches(push, student)).toBe(false);
    expect(reaches(grade, student)).toBe(false);
    expect(reaches(push, owner)).toBe(true);
    expect(reaches(grade, owner)).toBe(true);
  });

  it("never lets a per-repository family through classroom:, even if misaddressed", () => {
    for (const type of ["repos", "grades", "roster", "orgs"] as EventType[]) {
      expect(reaches({ type, topics: classroomTopics("c1") }, student)).toBe(false);
      expect(reaches({ type, topics: classroomTopics("c1") }, owner)).toBe(true);
    }
  });

  it("still tells a student about their own repository", () => {
    const own: AppEvent = { type: "grades", topics: [staffTopic("c1"), "user:alice"] };
    expect(reaches(own, student)).toBe(true);
  });

  it("broadcasts classroom-level shared data to everyone in the classroom", () => {
    for (const type of ["assignments", "journal", "mutation"] as EventType[]) {
      const e: AppEvent = { type, topics: classroomTopics("c1") };
      expect(reaches(e, student)).toBe(true);
      expect(reaches(e, owner)).toBe(true);
      expect(reaches(e, coTeacher)).toBe(true);
      expect(reaches(e, otherTeacher)).toBe(false);
    }
  });

  it("keeps staff-only hints away from students", () => {
    const e: AppEvent = { type: "assignments", topics: [staffTopic("c1")] };
    expect(reaches(e, student)).toBe(false);
    expect(reaches(e, owner)).toBe(true);
  });

  it("ignores other classrooms", () => {
    const other: AppEvent = { type: "assignments", topics: classroomTopics("c2") };
    expect(reaches(other, student)).toBe(false);
    expect(reaches(other, owner)).toBe(false);
    expect(reaches(other, otherTeacher)).toBe(true);
  });
});

describe("noticeFor: role × topic × notice kind", () => {
  const notice = (kind: NoticeKind) => ({ kind, message: kind });

  it("a student never gets a notice through classroom:, whatever the kind", () => {
    for (const kind of ALL_KINDS) {
      const e: AppEvent = { type: "assignments", topics: classroomTopics("c1"), notice: notice(kind) };
      expect(reaches(e, student)).toBe(true); // the silent refresh still arrives
      expect(noticeFor(e, student)).toBeNull();
    }
  });

  it("a student gets the notices addressed to them on user:", () => {
    for (const kind of ALL_KINDS) {
      const e: AppEvent = {
        type: "grades",
        topics: [staffTopic("c1"), "user:alice"],
        notice: notice(kind),
      };
      expect(noticeFor(e, student)?.kind).toBe(kind);
    }
  });

  it("the matrix on classroom-staff:", () => {
    for (const kind of ALL_KINDS) {
      const e: AppEvent = { type: "repos", topics: [staffTopic("c1")], notice: notice(kind) };
      const studentActivity = STUDENT_ACTIVITY_KINDS.has(kind);
      // The owner hears everything by default.
      expect(noticeFor(e, owner)?.kind).toBe(kind);
      // Co-staff: operations always, student activity only after opting in —
      // but the refresh hint reaches them either way.
      expect(reaches(e, coTeacher)).toBe(true);
      expect(noticeFor(e, coTeacher)?.kind ?? null).toBe(studentActivity ? null : kind);
      expect(noticeFor(e, coTeacherOptedIn)?.kind).toBe(kind);
      // Nobody outside the classroom.
      expect(reaches(e, otherTeacher)).toBe(false);
      expect(noticeFor(e, otherTeacher)).toBeNull();
      expect(reaches(e, student)).toBe(false);
    }
  });

  it("the opt-in is per classroom", () => {
    const both = audience(["user:co", "classroom-staff:c1", "classroom-staff:c2"], ["c2"]);
    const inC1: AppEvent = {
      type: "repos",
      topics: [staffTopic("c1")],
      notice: notice("commit_pushed"),
    };
    const inC2: AppEvent = { ...inC1, topics: [staffTopic("c2")] };
    expect(noticeFor(inC1, both)).toBeNull();
    expect(noticeFor(inC2, both)?.kind).toBe("commit_pushed");
  });

  it("what concerns you on user: always notifies, even muted staff", () => {
    const e: AppEvent = {
      type: "repos",
      topics: [staffTopic("c1"), "user:co"],
      notice: notice("assignment_accepted"),
    };
    expect(noticeFor(e, coTeacher)?.kind).toBe("assignment_accepted");
  });

  it("an event without a notice has none", () => {
    expect(noticeFor({ type: "repos", topics: [staffTopic("c1")] }, owner)).toBeNull();
  });
});
