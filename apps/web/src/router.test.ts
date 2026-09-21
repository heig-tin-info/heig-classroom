import { describe, expect, it } from "vitest";

import { parsePath, routeToPath, type Route } from "./router";

describe("routeToPath / parsePath", () => {
  const routes: Route[] = [
    { view: "home" },
    { view: "settings" },
    { view: "classroom", id: "c-1" },
    { view: "assignment", classroomId: "c-1", assignmentId: "a-2" },
    { view: "assignment-groups", classroomId: "c-1", assignmentId: "a-2" },
  ];

  it("round-trips every route", () => {
    for (const r of routes) {
      expect(parsePath(routeToPath(r))).toEqual(r);
    }
  });

  it("falls back to home on unknown or partial paths", () => {
    expect(parsePath("/")).toEqual({ view: "home" });
    expect(parsePath("/nope")).toEqual({ view: "home" });
    expect(parsePath("/classrooms")).toEqual({ view: "home" });
  });

  it("treats a classrooms path without assignment as the classroom view", () => {
    expect(parsePath("/classrooms/c-1/assignments")).toEqual({ view: "classroom", id: "c-1" });
    expect(parsePath("/classrooms/c-1/")).toEqual({ view: "classroom", id: "c-1" });
  });

  it("reads the group-formation screen of an assignment", () => {
    expect(parsePath("/classrooms/c-1/assignments/a-2/groups")).toEqual({
      view: "assignment-groups",
      classroomId: "c-1",
      assignmentId: "a-2",
    });
    // Anything else under the assignment is still the assignment itself: an
    // unknown tail must not take the reader to a page that does not exist.
    expect(parsePath("/classrooms/c-1/assignments/a-2/nope")).toEqual({
      view: "assignment",
      classroomId: "c-1",
      assignmentId: "a-2",
    });
  });
});
