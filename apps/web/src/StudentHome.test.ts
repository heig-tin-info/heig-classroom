import { describe, expect, it } from "vitest";

import { gradeToSix } from "./charts";
import { indicativeGrade, rowAffordances } from "./StudentHome";
import { makeGrade, makeStudentRepo } from "./test/fixtures";
import { DICTS } from "./i18n";

/**
 * What an assignment row shows the student, mode by mode.
 *
 * Feedback from 2026-09-18 on the real student view: in online mode the "Open
 * your repository" button is pointless (the student only has read access, or
 * nothing at all under SEB) and the mode badge cluttered the name row. "Start"
 * stays the primary action. Free mode, for its part, does not move a pixel.
 */
describe("rowAffordances", () => {
  const free = { workMode: "free" as const, accepted: true, locked: false };
  const online = { workMode: "online" as const, accepted: true, locked: false };
  const seb = { workMode: "online_seb" as const, accepted: true, locked: false };

  it("free mode: rendering unchanged -- clickable name and repository button, no Start", () => {
    expect(rowAffordances(free)).toEqual({
      nameIsLink: true,
      repoButton: true,
      startButton: false,
      modeNote: null,
    });
  });

  it("free mode, not accepted: neither link nor button", () => {
    expect(rowAffordances({ ...free, accepted: false })).toEqual({
      nameIsLink: false,
      repoButton: false,
      startButton: false,
      modeNote: null,
    });
  });

  it("online mode: no more \"Open your repository\" button, Start and a discreet link", () => {
    expect(rowAffordances(online)).toEqual({
      nameIsLink: true,
      repoButton: false,
      startButton: true,
      modeNote: "student.workspace",
    });
  });

  it("exam mode: no repository access at all, not even the name link", () => {
    expect(rowAffordances(seb)).toEqual({
      nameIsLink: false,
      repoButton: false,
      startButton: true,
      modeNote: "student.workspaceSeb",
    });
  });

  it("locked assignment: Start disappears, the mode note stays", () => {
    expect(rowAffordances({ ...online, locked: true }).startButton).toBe(false);
    expect(rowAffordances({ ...online, locked: true }).modeNote).toBe("student.workspace");
    expect(rowAffordances({ ...seb, locked: true }).startButton).toBe(false);
  });

  it("the repository button only exists in the mode where it is useful", () => {
    for (const mode of ["free", "online", "online_seb"] as const) {
      const a = rowAffordances({ workMode: mode, accepted: true, locked: false });
      expect(a.repoButton).toBe(mode === "free");
      expect(a.startButton).toBe(mode !== "free");
    }
  });

  it("the mode note is translated in both English and French", () => {
    for (const key of ["student.workspace", "student.workspaceSeb"] as const) {
      expect(DICTS.en[key]).toBeTruthy();
      expect(DICTS.fr[key]).toBeTruthy();
      expect(DICTS.fr[key]).not.toBe(DICTS.en[key]);
    }
  });
});

/**
 * The indicative grade, from the 2026-09-23 linked-list lab: 22/22 tests
 * showed "2.8/6 ≈ 3.3/6". The score pipeline already publishes a Swiss mark
 * (no second conversion), and that per-push mark only covers build + tests,
 * so it gives way to the tests donut when the CI publishes its counters.
 */
describe("indicative grade", () => {
  it("takes a GRADE out of 6 as the Swiss mark it already is", () => {
    expect(gradeToSix(2.8, 6)).toBe(2.8);
    expect(gradeToSix(15, 20)).toBe(4.75);
  });

  it("hides the partial mark of the score pipeline behind its test counters", () => {
    const repo = makeStudentRepo({ grade: makeGrade({ points: 2.8, testsPassed: 22, testsTotal: 22 }) });
    expect(indicativeGrade(repo)).toBeNull();
  });

  it("keeps the grade of a workflow that publishes no test counters", () => {
    const grade = makeGrade({ points: 15, max: 20, testsPassed: null, testsTotal: null });
    expect(indicativeGrade(makeStudentRepo({ grade }))).toBe(grade);
  });

  it("shows nothing for a malformed grade", () => {
    const grade = makeGrade({ parseStatus: "malformed", testsTotal: null });
    expect(indicativeGrade(makeStudentRepo({ grade }))).toBeNull();
  });
});
