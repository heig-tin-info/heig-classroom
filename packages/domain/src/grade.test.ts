import { describe, expect, it } from "vitest";

import { extractGrade, parseGradeMessage } from "./grade.js";

describe("parseGradeMessage (GR-02)", () => {
  it.each([
    ["4.5/6", 4.5, 6],
    ["10/10", 10, 10],
    ["0/6", 0, 6],
    ["  85 / 100  ", 85, 100],
    ["5.25/6.0", 5.25, 6],
  ])("accepts %s", (msg, points, max) => {
    expect(parseGradeMessage(msg)).toEqual({ status: "ok", points, max });
  });

  it.each([
    "6/0", // zero max
    "7/6", // points > max
    "-1/6", // negative (the sign is not in the grammar)
    "4,5/6", // decimal comma
    "4.5", // no denominator
    "note: 4/6", // stray prefix
    "4/6 points", // stray suffix
    "",
  ])("rejects %s", (msg) => {
    expect(parseGradeMessage(msg).status).toBe("malformed");
  });
});

describe("extractGrade (GR-17)", () => {
  const grade = (message: string) => ({ title: "GRADE", message });

  it("single valid annotation", () => {
    expect(extractGrade([grade("4/6"), { title: "info", message: "x" }])).toEqual({
      status: "ok",
      points: 4,
      max: 6,
    });
  });

  it("no GRADE annotation", () => {
    expect(extractGrade([{ title: "warning", message: "4/6" }])).toEqual({
      status: "no_annotation",
    });
  });

  it("multiple annotations, even identical, invalidate (anti-tampering H5)", () => {
    expect(extractGrade([grade("4/6"), grade("4/6")])).toEqual({
      status: "multiple",
      count: 2,
    });
  });

  it("null message treated as malformed", () => {
    expect(extractGrade([{ title: "GRADE", message: null }])).toMatchObject({
      status: "malformed",
    });
  });
});
