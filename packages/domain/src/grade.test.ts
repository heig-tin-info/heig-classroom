import { describe, expect, it } from "vitest";

import { extractGrade, parseGradeMessage } from "./grade.js";

describe("parseGradeMessage (GR-02)", () => {
  it.each([
    ["4.5/6", 4.5, 6],
    ["10/10", 10, 10],
    ["0/6", 0, 6],
    ["  85 / 100  ", 85, 100],
    ["5.25/6.0", 5.25, 6],
  ])("accepte %s", (msg, points, max) => {
    expect(parseGradeMessage(msg)).toEqual({ status: "ok", points, max });
  });

  it.each([
    "6/0", // max nul
    "7/6", // points > max
    "-1/6", // négatif (le signe n'est pas dans la grammaire)
    "4,5/6", // virgule décimale
    "4.5", // pas de dénominateur
    "note: 4/6", // préfixe parasite
    "4/6 points", // suffixe parasite
    "",
  ])("rejette %s", (msg) => {
    expect(parseGradeMessage(msg).status).toBe("malformed");
  });
});

describe("extractGrade (GR-17)", () => {
  const grade = (message: string) => ({ title: "GRADE", message });

  it("annotation unique valide", () => {
    expect(extractGrade([grade("4/6"), { title: "info", message: "x" }])).toEqual({
      status: "ok",
      points: 4,
      max: 6,
    });
  });

  it("aucune annotation GRADE", () => {
    expect(extractGrade([{ title: "warning", message: "4/6" }])).toEqual({
      status: "no_annotation",
    });
  });

  it("annotations multiples, même identiques, invalident (anti-falsification H5)", () => {
    expect(extractGrade([grade("4/6"), grade("4/6")])).toEqual({
      status: "multiple",
      count: 2,
    });
  });

  it("message null traité comme malformé", () => {
    expect(extractGrade([{ title: "GRADE", message: null }])).toMatchObject({
      status: "malformed",
    });
  });
});
