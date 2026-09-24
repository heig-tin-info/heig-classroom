import { describe, expect, it } from "vitest";

import { type AppEvent, reaches } from "./events.js";

const student = new Set(["user:alice", "classroom:c1"]);
const teacher = new Set(["user:t", "teacher:t", "classroom:c1"]);

describe("reaches", () => {
  it("keeps a classmate's repository and grade events away from students", () => {
    const push: AppEvent = { type: "repos", topics: ["classroom:c1", "user:bob"] };
    const grade: AppEvent = {
      type: "grades",
      topics: ["classroom:c1", "user:bob"],
      notice: { kind: "grade_captured", message: "Grade 8/10 captured on labo02-bob" },
    };
    expect(reaches(push, student, false)).toBe(false);
    expect(reaches(grade, student, false)).toBe(false);
    expect(reaches(push, teacher, true)).toBe(true);
    expect(reaches(grade, teacher, true)).toBe(true);
  });

  it("still tells a student about their own repository", () => {
    const own: AppEvent = { type: "grades", topics: ["classroom:c1", "user:alice"] };
    expect(reaches(own, student, false)).toBe(true);
  });

  it("broadcasts classroom-level changes to everyone in the classroom", () => {
    const published: AppEvent = { type: "assignments", topics: ["classroom:c1"] };
    const mutation: AppEvent = { type: "mutation", topics: ["classroom:c1"] };
    expect(reaches(published, student, false)).toBe(true);
    expect(reaches(mutation, student, false)).toBe(true);
  });

  it("ignores other classrooms", () => {
    const other: AppEvent = { type: "assignments", topics: ["classroom:c2"] };
    expect(reaches(other, student, false)).toBe(false);
    expect(reaches(other, teacher, true)).toBe(false);
  });
});
