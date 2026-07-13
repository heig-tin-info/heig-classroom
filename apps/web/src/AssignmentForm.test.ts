import { describe, expect, it } from "vitest";

import { compactDuration, humanize } from "./AssignmentForm";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("compactDuration", () => {
  it("formats sub-hour durations in minutes", () => {
    expect(compactDuration(45 * MIN)).toBe("45 min");
  });

  it("formats hours with a minute remainder", () => {
    expect(compactDuration(90 * MIN)).toBe("1 h 30 min");
    expect(compactDuration(2 * HOUR)).toBe("2 h");
  });

  it("formats days with an hour remainder", () => {
    expect(compactDuration(3 * DAY + 4 * HOUR)).toBe("3 d 4 h");
    expect(compactDuration(26 * DAY)).toBe("26 d");
  });
});

describe("humanize", () => {
  it("turns a repo slug into a title-cased name", () => {
    expect(humanize("labo-02-quadratic")).toBe("Labo 02 Quadratic");
  });

  it("handles underscores and repeated separators", () => {
    expect(humanize("intro__c_pointers")).toBe("Intro C Pointers");
    expect(humanize("-edge--case-")).toBe("Edge Case");
  });
});
