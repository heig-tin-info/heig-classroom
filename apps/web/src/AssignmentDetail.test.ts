import { describe, expect, it } from "vitest";

import { sebFileState } from "./AssignmentDetail";
import { DICTS } from "./i18n";

/**
 * The teacher's `.seb` download (2026-09-18 security audit, item 1).
 *
 * What is under test is the decision, not the markup: when does the download
 * exist at all, and when is it honest to offer it. The portal answers 404 on
 * `GET /exam/<id>.seb` for an assignment it has never received, so the button
 * must not appear before the first successful synchronisation.
 */
const base = {
  workMode: "online_seb" as const,
  codespaceSebUrl: "https://code.example.ch/exam/a1.seb",
  codespaceSyncedAt: "2026-09-18T08:00:00.000Z",
  codespaceConfigKey: "a".repeat(64),
};

describe("sebFileState", () => {
  it("offers the download with its Config Key once the assignment is synced", () => {
    expect(sebFileState(base)).toEqual({
      kind: "ready",
      url: "https://code.example.ch/exam/a1.seb",
      configKey: "a".repeat(64),
    });
  });

  it("is hidden outside exam mode: there is no .seb for a lab or a free assignment", () => {
    for (const workMode of ["free", "online"] as const) {
      expect(sebFileState({ ...base, workMode })).toEqual({ kind: "hidden" });
    }
  });

  it("says so when no portal is configured rather than showing a dead link", () => {
    expect(sebFileState({ ...base, codespaceSebUrl: null })).toEqual({
      kind: "unavailable",
      reason: "portal",
    });
  });

  it("refuses to offer a file the portal does not have yet", () => {
    expect(sebFileState({ ...base, codespaceSyncedAt: null })).toEqual({
      kind: "unavailable",
      reason: "not-synced",
    });
  });

  it("still offers the download when the Config Key has not come back yet", () => {
    // A sync that succeeded before this field existed, or a portal that
    // answered a body we could not read: the file is valid, only the
    // comparison value is missing.
    expect(sebFileState({ ...base, codespaceConfigKey: null })).toEqual({
      kind: "ready",
      url: base.codespaceSebUrl,
      configKey: null,
    });
  });

  it("the download is never the sebs:// deep link — that one launches SEB", () => {
    const state = sebFileState(base);
    expect(state.kind).toBe("ready");
    if (state.kind === "ready") expect(state.url.startsWith("https://")).toBe(true);
  });
});

describe("exam strings", () => {
  it("exist in both dictionaries and are actually translated", () => {
    const keys = [
      "exam.sebFile",
      "exam.sebFileHint",
      "exam.download",
      "exam.downloadTip",
      "exam.noPortal",
      "exam.notSynced",
      "exam.configKeyTip",
      "exam.configKeyPending",
      "exam.copy",
      "exam.copied",
    ] as const;
    for (const key of keys) {
      expect(DICTS.en[key]).toBeTruthy();
      expect(DICTS.fr[key]).toBeTruthy();
      expect(DICTS.fr[key]).not.toBe(DICTS.en[key]);
    }
    // "Config Key" is the name SEB itself gives the value: it is not
    // translated, on purpose — the teacher looks for that exact label in the
    // configuration tool.
    expect(DICTS.fr["exam.configKey"]).toBe(DICTS.en["exam.configKey"]);
  });
});
