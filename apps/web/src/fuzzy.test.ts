import { describe, expect, it } from "vitest";

import { fuzzyFilter, fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("matches subsequences and rejects non-matches", () => {
    expect(fuzzyScore("lbo", "labo-02")).not.toBeNull();
    expect(fuzzyScore("xyz", "labo-02")).toBeNull();
  });

  it("returns 0 for an empty query", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("is diacritics- and case-insensitive", () => {
    expect(fuzzyScore("emile", "Émile")).not.toBeNull();
    expect(fuzzyScore("ÉMILE", "emile")).not.toBeNull();
  });

  it("favours word starts over mid-word hits", () => {
    expect(fuzzyScore("ma", "Martin")!).toBeGreaterThan(fuzzyScore("ma", "Amanda")!);
  });
});

describe("fuzzyFilter", () => {
  const items = ["Amanda", "Martin", "Zoé"];

  it("keeps the input order on an empty query", () => {
    expect(fuzzyFilter("", items, (s) => s)).toEqual(items);
    expect(fuzzyFilter("   ", items, (s) => s)).toEqual(items);
  });

  it("filters out non-matches and sorts by descending score", () => {
    expect(fuzzyFilter("ma", items, (s) => s)).toEqual(["Martin", "Amanda"]);
  });
});
