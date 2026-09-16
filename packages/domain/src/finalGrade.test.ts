import { describe, expect, it } from "vitest";

import { finalPoints, resolveFinalGrade } from "./finalGrade.js";

const g = (points: number | null, max: number | null = 6, parseStatus = "ok") => ({
  points,
  max,
  parseStatus,
});

describe("resolveFinalGrade", () => {
  it("prefers the teacher's adjustment over everything", () => {
    expect(
      resolveFinalGrade({ teacherPoints: 5.5, llmGrade: g(4), frozenGrade: g(3) }),
    ).toEqual({ points: 5.5, max: 6, source: "teacher" });
  });

  it("keeps a teacher's zero (not a missing grade)", () => {
    expect(resolveFinalGrade({ teacherPoints: 0, llmGrade: g(4) })).toEqual({
      points: 0,
      max: 6,
      source: "teacher",
    });
  });

  it("falls back to the LLM review", () => {
    expect(resolveFinalGrade({ teacherPoints: null, llmGrade: g(4), frozenGrade: g(3) })).toEqual({
      points: 4,
      max: 6,
      source: "llm",
    });
  });

  it("falls back to the frozen CI grade", () => {
    expect(resolveFinalGrade({ frozenGrade: g(3), grade: g(2) })).toEqual({
      points: 3,
      max: 6,
      source: "ci",
    });
  });

  it("uses the current CI grade while nothing is frozen", () => {
    expect(resolveFinalGrade({ grade: g(2) })).toEqual({ points: 2, max: 6, source: "ci" });
  });

  it("ignores grades whose annotation did not parse", () => {
    expect(resolveFinalGrade({ llmGrade: g(null, null, "no_annotation"), grade: g(2) })).toEqual({
      points: 2,
      max: 6,
      source: "ci",
    });
    expect(resolveFinalGrade({ frozenGrade: g(null, null, "malformed") })).toBeNull();
  });

  it("returns null when the student has no grade at all", () => {
    expect(resolveFinalGrade({})).toBeNull();
    expect(finalPoints({ teacherPoints: null, llmGrade: null, grade: null })).toBeNull();
  });

  it("finalPoints exposes the points only", () => {
    expect(finalPoints({ llmGrade: g(4.5) })).toBe(4.5);
  });
});
