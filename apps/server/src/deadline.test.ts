import { describe, expect, it } from "vitest";

import { zurichIso } from "./github/commit.js";
import { TASK_DEFS, taskDef } from "./tasks.js";

describe("zurichIso (GH-42)", () => {
  it("formats a summer instant with the +02:00 offset", () => {
    // 2026-07-03T21:59:00Z = 23:59 summer time in Zurich.
    expect(zurichIso(new Date("2026-07-03T21:59:00Z"))).toBe("2026-07-03T23:59:00+02:00");
  });

  it("formats a winter instant with the +01:00 offset", () => {
    expect(zurichIso(new Date("2026-01-15T11:00:00Z"))).toBe("2026-01-15T12:00:00+01:00");
  });

  it("crosses the date boundary through the offset", () => {
    // 23:30 UTC on the 1st = 01:30 on the 2nd in Zurich (summer).
    expect(zurichIso(new Date("2026-07-01T23:30:00Z"))).toBe("2026-07-02T01:30:00+02:00");
  });
});

describe("task registry", () => {
  it("has unique keys and sane defaults", () => {
    const keys = TASK_DEFS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const def of TASK_DEFS) {
      expect(def.defaultIntervalMinutes).toBeGreaterThanOrEqual(5);
      expect(def.description).toMatch(/^[A-Z]/); // UI in English
    }
  });

  it("resolves known keys and rejects unknown ones", () => {
    expect(taskDef("reconcile.repos")).toBeDefined();
    expect(taskDef("nope")).toBeUndefined();
  });
});
