import { describe, expect, it } from "vitest";

import { rowAffordances } from "./StudentHome";
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
