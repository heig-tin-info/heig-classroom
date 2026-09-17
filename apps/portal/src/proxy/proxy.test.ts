/**
 * Refus du proxy, montés sur un vrai portail (Fastify, base, greffons) avec un
 * moteur simulé.
 *
 * Seuls les chemins de **refus** sont testés ici : ils n'atteignent jamais
 * l'amont, donc le test n'a pas besoin d'un code-server. Le chemin nominal —
 * poste de travail servi, websocket établi — est vérifié pour de vrai par
 * `scripts/e2e.ts`, avec un conteneur.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../auth/config.js";
import { AUTH_COOKIE, issueAuthCookie } from "../auth/session.js";
import { openDb, type DbHandle } from "../db/client.js";
import { assignments, sessions, users } from "../db/schema.js";
import type { ContainerInfo, Engine } from "../engine/index.js";
import { EXAM_COOKIE, issueExamCookie } from "../seb/index.js";
import { buildPortal, type Portal } from "../server.js";

import { SESSION_COOKIE, cookieValue, isEntryRequest, parseCookieValue } from "./index.js";

const COOKIE_SECRET = "secret-de-test-assez-long-1";
const EXAM_SECRET = "secret-de-test-assez-long-2";
const TOKEN = "jeton-de-session-de-test";

const fakeEngine: Engine = {
  runArgs: () => [],
  run: async (req) => ({
    id: "ctr",
    name: req.name,
    sessionId: req.sessionId,
    state: "running",
    ip: "10.77.0.9",
  }),
  inspect: async (name): Promise<ContainerInfo | null> => ({
    id: "ctr",
    name,
    sessionId: "s1",
    state: "running",
    ip: "10.77.0.9",
  }),
  stop: async () => undefined,
  rm: async () => undefined,
  listSessions: async () => [],
  waitHealthy: async () => 1,
  exec: async () => "",
};

let handle: DbHandle;
let portal: Portal;
let config: AppConfig;

beforeEach(async () => {
  handle = openDb(":memory:");
  config = loadConfig({
    COOKIE_SECRET,
    EXAM_COOKIE_SECRET: EXAM_SECRET,
    SEB_VERIFIER: "simulated",
    TRUST_PROXY: "1",
    LOG_LEVEL: "fatal",
  });
  const now = new Date();
  handle.db
    .insert(users)
    .values({
      id: "u1",
      oidcSub: "sub-1",
      login: "student",
      email: "s@heig-vd.ch",
      displayName: "Sacha",
      role: "student",
      createdAt: now,
    })
    .run();
  for (const [id, mode] of [
    ["tp", "lab"],
    ["ex", "exam"],
  ] as const) {
    handle.db
      .insert(assignments)
      .values({
        id,
        title: id,
        mode,
        image: "codespace/c-dev:4.137.0",
        uploadPack: true,
        beks: ["0".repeat(64)],
        sebConfig: { examKeySalt: "sel" },
        configKey: "0".repeat(64),
        createdAt: now,
      })
      .run();
  }
  for (const [id, assignmentId] of [
    ["s1", "tp"],
    ["s2", "ex"],
  ] as const) {
    handle.db
      .insert(sessions)
      .values({
        id,
        userId: "u1",
        student: "student",
        assignmentId,
        containerId: "ctr",
        containerName: `cs-${id}`,
        containerIp: "10.77.0.9",
        volumeDir: `/tmp/vol/${id}`,
        state: "running",
        createdAt: now,
        lastSeen: now,
        cookieToken: TOKEN,
        sebVerified: assignmentId === "ex",
      })
      .run();
  }
  portal = await buildPortal({
    config,
    dbHandle: handle,
    engine: fakeEngine,
    withGitServer: false,
    withTimers: false,
  });
});

afterEach(async () => {
  await portal.close();
});

function authCookie(): string {
  return issueAuthCookie(
    { userId: "u1", login: "student", role: "student", expiresAt: Date.now() + 60_000 },
    COOKIE_SECRET,
  );
}

describe("valeur du cookie de session de codespace", () => {
  it("se relit", () => {
    expect(parseCookieValue(cookieValue("s1", TOKEN))).toEqual({
      sessionId: "s1",
      token: TOKEN,
    });
  });
  it("rejette une valeur sans séparateur", () => {
    expect(parseCookieValue("s1")).toBeNull();
    expect(parseCookieValue(undefined)).toBeNull();
    expect(parseCookieValue(".jeton")).toBeNull();
  });
});

describe("requête d'entrée", () => {
  it("reconnaît le rechargement de page et lui seul", () => {
    expect(isEntryRequest("/s/s1/", "s1")).toBe(true);
    expect(isEntryRequest("/s/s1", "s1")).toBe(true);
    expect(isEntryRequest("/s/s1/?folder=/work", "s1")).toBe(true);
    expect(isEntryRequest("/s/s1/static/out/vs/workbench.js", "s1")).toBe(false);
  });
});

describe("refus du proxy", () => {
  it("403 sans cookie de session", async () => {
    const res = await portal.app.inject({ method: "GET", url: "/s/s1/" });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Session non autorisée");
  });

  it("403 avec un cookie d'une autre session", async () => {
    const res = await portal.app.inject({
      method: "GET",
      url: "/s/s1/",
      cookies: { [SESSION_COOKIE]: cookieValue("s2", TOKEN) },
    });
    expect(res.statusCode).toBe(403);
  });

  it("403 avec un jeton faux pour la bonne session", async () => {
    const res = await portal.app.inject({
      method: "GET",
      url: "/s/s1/",
      cookies: { [SESSION_COOKIE]: cookieValue("s1", "mauvais-jeton") },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404 pour une session inconnue", async () => {
    const res = await portal.app.inject({
      method: "GET",
      url: "/s/inconnue/",
      cookies: { [SESSION_COOKIE]: cookieValue("inconnue", TOKEN) },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("mode examen — invariant 5 : le proxy ne lit aucun en-tête SEB", () => {
  const examCookie = (address: string, sessionId = "s2"): string =>
    issueExamCookie(
      { assignmentId: "ex", sessionId, clientAddress: address, issuedAt: Date.now() },
      { secret: EXAM_SECRET },
    );

  it("refuse même avec les en-têtes SEB, s'il n'y a pas de cookie d'examen", async () => {
    const res = await portal.app.inject({
      method: "GET",
      url: "/s/s2/",
      cookies: { [SESSION_COOKIE]: cookieValue("s2", TOKEN) },
      headers: {
        "x-dev-seb": "ok",
        "x-safeexambrowser-configkeyhash": "0".repeat(64),
        "x-safeexambrowser-requesthash": "0".repeat(64),
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Safe Exam Browser");
  });

  it("refuse un cookie d'examen émis pour une autre adresse (analyse.md D5)", async () => {
    const res = await portal.app.inject({
      method: "GET",
      url: "/s/s2/",
      remoteAddress: "192.0.2.4",
      cookies: {
        [SESSION_COOKIE]: cookieValue("s2", TOKEN),
        [EXAM_COOKIE]: examCookie("192.0.2.1"),
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("autre poste");
  });

  it("refuse un cookie d'examen émis pour une autre session", async () => {
    const res = await portal.app.inject({
      method: "GET",
      url: "/s/s2/",
      remoteAddress: "192.0.2.1",
      cookies: {
        [SESSION_COOKIE]: cookieValue("s2", TOKEN),
        [EXAM_COOKIE]: examCookie("192.0.2.1", "s1"),
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("gardes d'autorisation des pages", () => {
  it("/ redirige vers la connexion sans session de portail", async () => {
    const res = await portal.app.inject({
      method: "GET",
      url: "/",
      headers: { accept: "text/html" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers["location"]).toBe("/auth/login");
  });

  it("/teacher/sessions est refusé à un étudiant connecté", async () => {
    const res = await portal.app.inject({
      method: "GET",
      url: "/teacher/sessions",
      headers: { accept: "text/html" },
      cookies: { [AUTH_COOKIE]: authCookie() },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("réservée aux enseignants");
  });

  it("un devoir d'examen ne se démarre pas par le bouton Démarrer", async () => {
    const res = await portal.app.inject({
      method: "POST",
      url: "/assignments/ex/start",
      headers: { accept: "text/html" },
      cookies: { [AUTH_COOKIE]: authCookie() },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Safe Exam Browser");
  });

  it("/exam/<id>/start sans session de portail renvoie à la connexion", async () => {
    const res = await portal.app.inject({
      method: "GET",
      url: "/exam/ex/start",
      headers: { accept: "text/html", "x-dev-seb": "ok" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers["location"]).toBe("/auth/login");
  });

  it("/exam/<id>/start sans en-tête SEB est refusé même connecté", async () => {
    const res = await portal.app.inject({
      method: "GET",
      url: "/exam/ex/start",
      headers: { accept: "text/html" },
      cookies: { [AUTH_COOKIE]: authCookie() },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Safe Exam Browser");
  });

  it("le `.seb` d'un devoir de travaux pratiques n'existe pas", async () => {
    const res = await portal.app.inject({ method: "GET", url: "/exam/tp.seb" });
    expect(res.statusCode).toBe(404);
  });
});
