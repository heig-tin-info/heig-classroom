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

describe("échappement", () => {
  it("neutralise le HTML d'un titre de devoir", () => {
    expect(escapeHtml('<script>"&')).toBe("&lt;script&gt;&quot;&amp;");
  });

  it("un titre hostile ne sort pas balise", () => {
    const html = homePage(
      { login: "s", displayName: "S", role: "student" },
      [{ assignment: { ...lab, title: "<img onerror=x>" }, session: null }],
    );
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("&lt;img onerror=x&gt;");
  });
});

describe("page d'accueil", () => {
  it("offre le bouton Démarrer d'un devoir de travaux pratiques", () => {
    const html = homePage({ login: "s", displayName: "S", role: "student" }, [
      { assignment: lab, session: null },
    ]);
    expect(html).toContain('action="/assignments/tp-pointeurs/start"');
    expect(html).toContain("Démarrer");
  });

  it("n'offre pas de bouton Démarrer pour une épreuve (invariant 5)", () => {
    const html = homePage({ login: "s", displayName: "S", role: "student" }, [
      { assignment: exam, session: null },
    ]);
    expect(html).not.toContain('action="/assignments/exam-c/start"');
    expect(html).toContain("/exam/exam-c.seb");
  });

  it("propose de rejoindre une session déjà ouverte", () => {
    const html = homePage({ login: "s", displayName: "S", role: "student" }, [
      { assignment: lab, session },
    ]);
    expect(html).toContain('href="/s/s1/"');
  });

  it("ne montre le lien enseignant qu'aux enseignants", () => {
    const asStudent = homePage({ login: "s", displayName: "S", role: "student" }, []);
    const asTeacher = homePage({ login: "t", displayName: "T", role: "teacher" }, []);
    expect(asStudent).not.toContain("/teacher/sessions");
    expect(asTeacher).toContain("/teacher/sessions");
  });

  it("dit clairement qu'il n'y a rien plutôt que d'afficher un vide", () => {
    expect(homePage({ login: "s", displayName: "S", role: "student" }, [])).toContain(
      "Aucun devoir ouvert",
    );
  });
});

describe("tableau des sessions", () => {
  const now = new Date("2026-06-01T10:00:00Z");

  it("montre l'étudiant, l'état, le battement, le dernier push et le bouton Fermer", () => {
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

  it("n'offre pas de bouton Fermer sur une session déjà fermée", () => {
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

  it("signale une session née d'une vérification SEB", () => {
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
