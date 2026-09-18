import { describe, expect, it } from "vitest";

import type { AssignmentRow, SessionRow } from "../db/schema.js";

import { escapeHtml, homePage, teacherSessionsPage } from "./pages.js";

const lab = {
  id: "tp-pointeurs",
  title: "TP 3 — pointeurs",
  mode: "lab",
  image: "codespace/c-dev:4.137.0",
} as AssignmentRow;

const exam = {
  id: "exam-c",
  title: "Épreuve",
  mode: "exam",
  image: "codespace/c-dev:4.137.0",
} as AssignmentRow;

const session = {
  id: "s1",
  student: "student",
  state: "running",
  lastSeen: new Date("2026-06-01T09:59:00Z"),
  sebVerified: false,
} as SessionRow;

describe("escaping", () => {
  it("neutralizes the HTML of an assignment title", () => {
    expect(escapeHtml('<script>"&')).toBe("&lt;script&gt;&quot;&amp;");
  });

  it("a hostile title does not come out as a tag", () => {
    const html = homePage(
      { login: "s", displayName: "S", role: "student" },
      [{ assignment: { ...lab, title: "<img onerror=x>" }, session: null }],
    );
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("&lt;img onerror=x&gt;");
  });
});

describe("home page", () => {
  it("offers the Start button of a lab assignment", () => {
    const html = homePage({ login: "s", displayName: "S", role: "student" }, [
      { assignment: lab, session: null },
    ]);
    expect(html).toContain('action="/assignments/tp-pointeurs/start"');
    expect(html).toContain("Démarrer");
  });

  it("does not offer a Start button for an exam (invariant 5)", () => {
    const html = homePage({ login: "s", displayName: "S", role: "student" }, [
      { assignment: exam, session: null },
    ]);
    expect(html).not.toContain('action="/assignments/exam-c/start"');
    expect(html).toContain("/exam/exam-c.seb");
  });

  it("offers to join an already open session", () => {
    const html = homePage({ login: "s", displayName: "S", role: "student" }, [
      { assignment: lab, session },
    ]);
    expect(html).toContain('href="/s/s1/"');
  });

  it("shows the teacher link only to teachers", () => {
    const asStudent = homePage({ login: "s", displayName: "S", role: "student" }, []);
    const asTeacher = homePage({ login: "t", displayName: "T", role: "teacher" }, []);
    expect(asStudent).not.toContain("/teacher/sessions");
    expect(asTeacher).toContain("/teacher/sessions");
  });

  it("says clearly that there is nothing rather than showing a void", () => {
    expect(homePage({ login: "s", displayName: "S", role: "student" }, [])).toContain(
      "Aucun devoir ouvert",
    );
  });
});

describe("sessions dashboard", () => {
  const now = new Date("2026-06-01T10:00:00Z");

  it("shows the student, the state, the heartbeat, the last push and the Close button", () => {
    const html = teacherSessionsPage(
      [
        {
          session,
          assignmentTitle: "TP 3 — pointeurs",
          displayName: "Sacha Student",
          lastPushAt: new Date("2026-06-01T09:58:00Z"),
        },
      ],
      now,
    );
    expect(html).toContain("Sacha Student");
    expect(html).toContain("TP 3 — pointeurs");
    expect(html).toContain("running");
    expect(html).toContain("il y a 1 min");
    expect(html).toContain("il y a 2 min");
    expect(html).toContain('action="/teacher/sessions/s1/close"');
  });

  it("does not offer a Close button on an already closed session", () => {
    const html = teacherSessionsPage(
      [
        {
          session: { ...session, state: "closed" },
          assignmentTitle: "TP",
          displayName: "Sacha",
          lastPushAt: null,
        },
      ],
      now,
    );
    expect(html).not.toContain("/close");
    expect(html).toContain("—");
  });

  it("flags a session born from an SEB verification", () => {
    const html = teacherSessionsPage(
      [
        {
          session: { ...session, sebVerified: true },
          assignmentTitle: "Épreuve",
          displayName: "Sacha",
          lastPushAt: null,
        },
      ],
      now,
    );
    expect(html).toContain("SEB");
  });
});
