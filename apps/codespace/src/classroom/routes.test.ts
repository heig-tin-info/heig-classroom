/**
 * Frontière classroom → portail : le PUT de devoir et la route `/launch`.
 *
 * Tout est en mémoire — base SQLite `:memory:`, gestionnaire de sessions
 * simulé, vérificateur SEB en mode `simulated`. Ce qui est vérifié ici est la
 * logique de la frontière : l'authentification des deux jetons, l'idempotence
 * de l'upsert, la configuration SEB régénérée sur l'URL de classroom, et les
 * sept motifs de refus de `/launch`. Podman, Keycloak et Forgejo sont
 * exercés par `scripts/e2e.ts`.
 */
import cookie from "@fastify/cookie";
import { signHs256 } from "@hgc/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../auth/config.js";
import { openDb, type Db, type DbHandle } from "../db/client.js";
import { sessions, users, type SessionRow } from "../db/schema.js";
import { createSebVerifier, renderSebFile } from "../seb/index.js";
import type { SessionManager, StartOptions, StartResult } from "../sessions/manager.js";
import { findAssignment } from "../sessions/store.js";

import { classroomRoutes, consumeJti } from "./routes.js";

const SECRET = "secret-de-lancement-de-test-0123456789";
const CLASSROOM = "http://classroom.test";
const PORTAL = "http://portal.test";

function testConfig(over: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    PUBLIC_URL: PORTAL,
    CLASSROOM_URL: CLASSROOM,
    CODESPACE_LAUNCH_SECRET: SECRET,
    SEB_EXTRA_ALLOWED_HOSTS: "idp.test, ",
    SEB_VERIFIER: "simulated",
    DATABASE_PATH: ":memory:",
    ...over,
  } as NodeJS.ProcessEnv);
}

// --- jetons -----------------------------------------------------------------

const now = () => Math.floor(Date.now() / 1000);

function serviceToken(over: Record<string, unknown> = {}): Promise<string> {
  return signHs256(
    {
      iss: "heig-classroom",
      aud: "heig-codespace-api",
      iat: now(),
      exp: now() + 300,
      ...over,
    },
    SECRET,
  );
}

let jtiCounter = 0;
function launchToken(over: Record<string, unknown> = {}, secret = SECRET): Promise<string> {
  jtiCounter += 1;
  return signHs256(
    {
      iss: "heig-classroom",
      aud: "heig-codespace",
      iat: now(),
      exp: now() + 300,
      jti: `jti-${jtiCounter}`,
      sub: "u-sacha",
      email: "sacha@heig-vd.ch",
      displayName: "Sacha Student",
      githubLogin: "sacha-gh",
      assignmentId: "a-lab",
      repo: { fullName: "codespace/tp-sacha", defaultBranch: "main" },
      ...over,
    },
    secret,
  );
}

// --- corps du PUT -----------------------------------------------------------

function syncBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a-lab",
    slug: "tp-pointeurs",
    name: "TP 3 — pointeurs",
    classroomId: "c-info2",
    classroomName: "Info 2 TIN-B",
    mode: "online",
    image: null,
    sourceRepo: { fullName: "codespace/tp-modele", defaultBranch: "main" },
    browserExamKeys: [],
    teacher: { id: "t-tania", email: "tania@heig-vd.ch" },
    quota: { maxActiveSessions: 2 },
    startAt: "2020-01-01T00:00:00.000Z",
    deadlineAt: null,
    ...over,
  };
}

// --- gestionnaire de sessions simulé ----------------------------------------

interface Harness {
  app: FastifyInstance;
  db: Db;
  handle: DbHandle;
  config: AppConfig;
  starts: Array<{ login: string; assignmentId: string; opts: StartOptions }>;
}

function fakeManager(db: Db, starts: Harness["starts"]): SessionManager {
  return {
    async start(user, assignment, opts: StartOptions = {}): Promise<StartResult> {
      starts.push({ login: user.login, assignmentId: assignment.id, opts });
      const id = `sess-${user.login}-${assignment.id}`;
      const at = new Date();
      const row = {
        id,
        userId: user.id,
        student: user.login,
        assignmentId: assignment.id,
        volumeDir: `/tmp/${id}`,
        state: "running" as const,
        createdAt: at,
        lastSeen: at,
        cookieToken: "jeton-de-cookie",
        sebVerified: opts.sebVerified ?? false,
        teacherId: opts.teacherId ?? null,
        launchJti: opts.launchJti ?? null,
        targetRepo: opts.targetRepo ?? null,
      };
      const [session] = db
        .insert(sessions)
        .values(row)
        .onConflictDoUpdate({ target: sessions.id, set: row })
        .returning()
        .all();
      return {
        session: session as SessionRow,
        launched: true,
        healthyInMs: 1,
        cookieToken: "jeton-de-cookie",
      };
    },
  } as unknown as SessionManager;
}

async function harness(over: Record<string, string> = {}): Promise<Harness> {
  const config = testConfig(over);
  const handle = openDb(":memory:");
  const starts: Harness["starts"] = [];
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: config.COOKIE_SECRET });
  await app.register(classroomRoutes, {
    config,
    db: handle.db,
    manager: fakeManager(handle.db, starts),
    verifier: createSebVerifier({ mode: config.SEB_VERIFIER, nodeEnv: config.NODE_ENV }),
    repoUrl: (repo) => `http://forge.test/${repo.owner}/${repo.name}.git`,
  });
  await app.ready();
  return { app, db: handle.db, handle, config, starts };
}

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.app.close();
  h.handle.close();
});

async function put(
  body: unknown,
  token: string | null,
  id = "a-lab",
): Promise<{ statusCode: number; json: () => unknown }> {
  return h.app.inject({
    method: "PUT",
    url: `/api/assignments/${id}`,
    ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
    payload: body,
  });
}

// --- PUT /api/assignments/:id -----------------------------------------------

describe("PUT /api/assignments/:id", () => {
  it("401 sans jeton de service", async () => {
    expect((await put(syncBody(), null)).statusCode).toBe(401);
  });

  it("401 avec une signature faite d'un autre secret", async () => {
    const forged = await signHs256(
      { iss: "heig-classroom", aud: "heig-codespace-api", iat: now(), exp: now() + 300 },
      "un-autre-secret-de-trente-deux-caracteres",
    );
    expect((await put(syncBody(), forged)).statusCode).toBe(401);
  });

  it("401 avec la bonne signature mais la mauvaise audience", async () => {
    // Un jeton de *lancement* ne doit pas ouvrir l'API de service.
    const token = await serviceToken({ aud: "heig-codespace" });
    expect((await put(syncBody(), token)).statusCode).toBe(401);
  });

  it("401 avec un émetteur inattendu", async () => {
    const token = await serviceToken({ iss: "heig-codespace" });
    expect((await put(syncBody(), token)).statusCode).toBe(401);
  });

  it("401 avec un jeton expiré", async () => {
    const token = await serviceToken({ iat: now() - 7200, exp: now() - 3600 });
    expect((await put(syncBody(), token)).statusCode).toBe(401);
  });

  it("400 sur un corps qui n'est pas celui du contrat", async () => {
    const token = await serviceToken();
    const reply = await put(syncBody({ mode: "free" }), token);
    expect(reply.statusCode).toBe(400);
    expect((reply.json() as { error: string }).error).toBe("invalid_body");
  });

  it("400 si l'identifiant du corps et celui de l'URL diffèrent", async () => {
    const token = await serviceToken();
    const reply = await put(syncBody({ id: "a-autre" }), token, "a-lab");
    expect(reply.statusCode).toBe(400);
  });

  it("400 si l'identifiant ne peut pas nommer un répertoire de volume", async () => {
    const token = await serviceToken();
    const reply = await put(syncBody({ id: "a$b" }), token, "a$b");
    expect(reply.statusCode).toBe(400);
  });

  it("400 pour un devoir en mode examen sans Browser Exam Key", async () => {
    const token = await serviceToken();
    const reply = await put(syncBody({ mode: "online_seb", browserExamKeys: [] }), token);
    expect(reply.statusCode).toBe(400);
    expect((reply.json() as { error: string }).error).toBe("missing_browser_exam_keys");
  });

  it("crée le devoir, traduit le mode et pose les champs de classroom", async () => {
    const token = await serviceToken();
    const reply = await put(syncBody(), token);
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ id: "a-lab", configKey: null, sebLink: null });

    const row = findAssignment(h.db, "a-lab");
    expect(row?.mode).toBe("lab");
    expect(row?.title).toBe("TP 3 — pointeurs");
    expect(row?.teacherId).toBe("t-tania");
    expect(row?.teacherEmail).toBe("tania@heig-vd.ch");
    expect(row?.maxActiveSessions).toBe(2);
    expect(row?.classroomId).toBe("c-info2");
    expect(row?.classroomName).toBe("Info 2 TIN-B");
    expect(row?.sourceRepo).toEqual({ fullName: "codespace/tp-modele", defaultBranch: "main" });
    // Invariant 6 : le modèle de l'enseignant, sous sa forme clonable.
    expect(row?.templateRepo).toBe("http://forge.test/codespace/tp-modele.git");
    // Le dépôt cible n'est plus un attribut du devoir : il vient du jeton.
    expect(row?.targetRepo).toBeNull();
    expect(row?.targetRepoPattern).toBeNull();
    expect(row?.image).toBe(h.config.CODESPACE_DEFAULT_IMAGE);
  });

  it("`image` du corps l'emporte sur l'image par défaut", async () => {
    const token = await serviceToken();
    await put(syncBody({ image: "codespace/python:1" }), token);
    expect(findAssignment(h.db, "a-lab")?.image).toBe("codespace/python:1");
  });

  it("est idempotent : deux PUT identiques, une ligne et la même Config Key", async () => {
    const token = await serviceToken();
    const body = syncBody({ mode: "online_seb", browserExamKeys: ["bek-windows"] });
    const first = await put(body, token);
    const second = await put(body, token);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());

    const rows = h.db.all<{ n: number }>("SELECT count(*) AS n FROM assignments");
    expect(rows[0]?.n).toBe(1);
    // Le sel du BEK ne bouge pas : le changer invaliderait les `.seb` déjà
    // distribués, et l'idempotence du PUT en dépend.
    const created = findAssignment(h.db, "a-lab")?.createdAt;
    await put(syncBody({ mode: "online_seb", browserExamKeys: ["bek-windows", "bek-mac"] }), token);
    const after = findAssignment(h.db, "a-lab");
    expect(after?.beks).toEqual(["bek-windows", "bek-mac"]);
    expect(after?.createdAt).toEqual(created);
  });

  it("mode examen : configuration SEB régénérée sur la startURL de classroom", async () => {
    const token = await serviceToken();
    const reply = await put(
      syncBody({ mode: "online_seb", browserExamKeys: ["bek-windows"] }),
      token,
    );
    const body = reply.json() as { id: string; configKey: string; sebLink: string };
    const row = findAssignment(h.db, "a-lab");

    expect(row?.mode).toBe("exam");
    // C'est classroom qui authentifie l'étudiant, puis redirige vers /launch.
    expect(row?.sebConfig?.startUrl).toBe("http://classroom.test/app/codespace/start/a-lab");
    // Le filtre d'URL doit laisser passer le portail et le fournisseur
    // d'identité en plus de classroom (docs/pistes.md).
    expect(row?.sebConfig?.extraAllowedHosts).toEqual(["portal.test", "idp.test"]);
    expect(row?.configKey).toBe(body.configKey);

    // La Config Key annoncée est bien celle de cette configuration-là.
    const rendered = renderSebFile({
      startUrl: "http://classroom.test/app/codespace/start/a-lab",
      quitUrl: "http://classroom.test/",
      examKeySalt: row?.sebConfig?.examKeySalt as string,
      extraAllowedHosts: ["portal.test", "idp.test"],
    });
    expect(rendered.configKey).toBe(body.configKey);
    expect(rendered.xml).toContain("classroom.test");
    expect(rendered.xml).toContain("portal.test");
    expect(rendered.xml).toContain("idp.test");
    // Le fichier `.seb`, lui, reste servi par le portail.
    expect(body.sebLink).toBe("seb://portal.test/exam/a-lab.seb");
  });

  it("repasser un devoir d'examen en mode en ligne efface sa configuration SEB", async () => {
    const token = await serviceToken();
    await put(syncBody({ mode: "online_seb", browserExamKeys: ["bek"] }), token);
    const reply = await put(syncBody(), token);
    expect((reply.json() as { configKey: string | null }).configKey).toBeNull();
    const row = findAssignment(h.db, "a-lab");
    expect(row?.mode).toBe("lab");
    expect(row?.configKey).toBeNull();
    expect(row?.sebConfig).toBeNull();
  });
});

// --- GET /api/assignments/:id/sessions --------------------------------------

describe("GET /api/assignments/:id/sessions", () => {
  it("401 sans jeton de service, 404 sur un devoir inconnu", async () => {
    const anonymous = await h.app.inject({ url: "/api/assignments/a-lab/sessions" });
    expect(anonymous.statusCode).toBe(401);
    const token = await serviceToken();
    const missing = await h.app.inject({
      url: "/api/assignments/a-inconnu/sessions",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("rend le résumé des sessions avec l'identifiant de classroom", async () => {
    const token = await serviceToken();
    await put(syncBody(), token);
    const launch = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
    expect(launch.statusCode).toBe(303);

    const reply = await h.app.inject({
      url: "/api/assignments/a-lab/sessions",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(reply.statusCode).toBe(200);
    const list = reply.json() as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]?.["userId"]).toBe("u-sacha");
    expect(list[0]?.["email"]).toBe("sacha@heig-vd.ch");
    expect(list[0]?.["state"]).toBe("running");
    expect(list[0]?.["lastPushAt"]).toBeNull();
    expect(typeof list[0]?.["createdAt"]).toBe("string");
  });
});

// --- GET /launch ------------------------------------------------------------

describe("GET /launch", () => {
  async function syncedAssignment(over: Record<string, unknown> = {}): Promise<void> {
    const token = await serviceToken();
    const reply = await put(syncBody(over), token, (over["id"] as string) ?? "a-lab");
    expect(reply.statusCode).toBe(200);
  }

  it("403 sans jeton", async () => {
    const reply = await h.app.inject({ url: "/launch" });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toContain("Lancement refusé");
  });

  it("403 sur une signature faite d'un autre secret", async () => {
    await syncedAssignment();
    const token = await launchToken({}, "un-autre-secret-de-trente-deux-caracteres");
    const reply = await h.app.inject({ url: `/launch?token=${token}` });
    expect(reply.statusCode).toBe(403);
    expect(h.starts).toHaveLength(0);
  });

  it("403 sur un jeton expiré", async () => {
    await syncedAssignment();
    const token = await launchToken({ iat: now() - 7200, exp: now() - 3600 });
    const reply = await h.app.inject({ url: `/launch?token=${token}` });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toContain("expiré");
  });

  it("403 sur une audience de jeton de service", async () => {
    await syncedAssignment();
    const token = await launchToken({ aud: "heig-codespace-api" });
    expect((await h.app.inject({ url: `/launch?token=${token}` })).statusCode).toBe(403);
  });

  it("usage unique : le même jeton ne sert pas deux fois", async () => {
    await syncedAssignment();
    const token = await launchToken();
    const first = await h.app.inject({ url: `/launch?token=${token}` });
    expect(first.statusCode).toBe(303);
    const second = await h.app.inject({ url: `/launch?token=${token}` });
    expect(second.statusCode).toBe(403);
    expect(second.body).toContain("déjà servi");
    expect(h.starts).toHaveLength(1);
  });

  it("403 « devoir non synchronisé depuis classroom »", async () => {
    const token = await launchToken({ assignmentId: "a-jamais-vu" });
    const reply = await h.app.inject({ url: `/launch?token=${token}` });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toContain("non synchronisé depuis classroom");
  });

  it("403 hors de la fenêtre du devoir", async () => {
    await syncedAssignment({ deadlineAt: "2020-06-01T00:00:00.000Z" });
    const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toContain("fenêtre d'ouverture");
  });

  it("403 quand le jeton ne porte pas de dépôt", async () => {
    await syncedAssignment();
    const reply = await h.app.inject({ url: `/launch?token=${await launchToken({ repo: null })}` });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toContain("dépôt");
    expect(h.starts).toHaveLength(0);
  });

  it("ouvre la session, pose le cookie du portail et redirige", async () => {
    await syncedAssignment();
    const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });

    expect(reply.statusCode).toBe(303);
    expect(reply.headers["location"]).toBe("/s/sess-u-sacha-a-lab/");
    const cookies = reply.cookies as Array<{ name: string; value: string; path?: string }>;
    const portal = cookies.find((c) => c.name === "cs_session");
    expect(portal?.value).toBe("sess-u-sacha-a-lab.jeton-de-cookie");
    // `Path=/s/<id>` : deux sessions dans le même navigateur ne se marchent
    // pas dessus.
    expect(portal?.path).toBe("/s/sess-u-sacha-a-lab");
    // Aucun cookie d'examen sur un devoir de travaux pratiques.
    expect(cookies.find((c) => c.name === "exam_session")).toBeUndefined();

    // Le dépôt du jeton, l'enseignant du devoir et le `jti` sont transmis.
    expect(h.starts[0]?.opts).toMatchObject({
      sebVerified: false,
      teacherId: "t-tania",
      targetRepo: { fullName: "codespace/tp-sacha", defaultBranch: "main" },
    });
    expect(h.starts[0]?.opts.launchJti).toMatch(/^jti-/);
  });

  it("inscrit l'utilisateur depuis les revendications, sans le reconnecter", async () => {
    await syncedAssignment();
    await h.app.inject({ url: `/launch?token=${await launchToken()}` });
    const rows = h.db.all<{ login: string; email: string; github_login: string; oidc_sub: string; role: string }>(
      "SELECT login, email, github_login, oidc_sub, role FROM users",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      login: "u-sacha",
      email: "sacha@heig-vd.ch",
      github_login: "sacha-gh",
      oidc_sub: "classroom:u-sacha",
      // Un jeton de lancement n'attribue jamais le rôle enseignant.
      role: "student",
    });

    await h.app.inject({
      url: `/launch?token=${await launchToken({ email: "sacha2@heig-vd.ch", githubLogin: null })}`,
    });
    const after = h.db.all<{ n: number }>("SELECT count(*) AS n FROM users");
    expect(after[0]?.n).toBe(1);
    expect(
      h.db.all<{ email: string; github_login: string | null }>(
        "SELECT email, github_login FROM users",
      )[0],
    ).toEqual({ email: "sacha2@heig-vd.ch", github_login: null });
  });

  describe("quota par enseignant", () => {
    /** Session vivante d'un autre étudiant, sur un autre devoir du même enseignant. */
    function occupy(student: string, assignmentId: string): void {
      const at = new Date();
      h.db
        .insert(users)
        .values({
          id: `user-${student}`,
          oidcSub: `classroom:${student}`,
          login: student,
          email: `${student}@heig-vd.ch`,
          displayName: student,
          createdAt: at,
        })
        .onConflictDoNothing()
        .run();
      h.db
        .insert(sessions)
        .values({
          id: `sess-${student}-${assignmentId}`,
          userId: `user-${student}`,
          student,
          assignmentId,
          volumeDir: `/tmp/${student}`,
          state: "running",
          createdAt: at,
          lastSeen: at,
          cookieToken: "x",
          teacherId: "t-tania",
        })
        .run();
    }

    it("429 quand les sessions vivantes de l'enseignant atteignent le quota", async () => {
      await syncedAssignment({ quota: { maxActiveSessions: 1 } });
      occupy("u-autre", "a-lab");
      const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
      expect(reply.statusCode).toBe(429);
      expect(reply.body).toContain("Quota atteint");
      expect(h.starts).toHaveLength(0);
    });

    it("le quota compte tous les devoirs de l'enseignant, pas seulement celui-ci", async () => {
      await syncedAssignment({ quota: { maxActiveSessions: 1 } });
      await syncedAssignment({ id: "a-autre", quota: { maxActiveSessions: 1 } });
      occupy("u-autre", "a-autre");
      const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
      expect(reply.statusCode).toBe(429);
    });

    it("la reprise de sa propre session vivante ne consomme pas de quota", async () => {
      await syncedAssignment({ quota: { maxActiveSessions: 1 } });
      // L'étudiant a déjà sa session sur ce devoir : la reprise n'ouvre pas de
      // conteneur de plus (analyse.md D5).
      occupy("u-sacha", "a-lab");
      const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
      expect(reply.statusCode).toBe(303);
      expect(h.starts).toHaveLength(1);
    });

    it("une session fermée ne compte plus", async () => {
      await syncedAssignment({ quota: { maxActiveSessions: 1 } });
      occupy("u-autre", "a-lab");
      h.db.run("UPDATE sessions SET state = 'closed'" as never);
      const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
      expect(reply.statusCode).toBe(303);
    });
  });

  describe("mode examen", () => {
    async function syncedExam(): Promise<void> {
      const token = await serviceToken();
      const reply = await put(
        syncBody({ mode: "online_seb", browserExamKeys: ["bek-windows"] }),
        token,
      );
      expect(reply.statusCode).toBe(200);
    }

    it("refuse sans en-tête de vérification SEB", async () => {
      await syncedExam();
      const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
      expect(reply.statusCode).toBe(403);
      expect(reply.body).toContain("Safe Exam Browser");
      expect(h.starts).toHaveLength(0);
    });

    it("accepte avec l'en-tête et pose les deux cookies", async () => {
      await syncedExam();
      const reply = await h.app.inject({
        url: `/launch?token=${await launchToken()}`,
        headers: { "x-dev-seb": "ok" },
      });
      expect(reply.statusCode).toBe(303);
      expect(reply.headers["location"]).toBe("/s/sess-u-sacha-a-lab/");
      const cookies = reply.cookies as Array<{ name: string; path?: string }>;
      expect(cookies.find((c) => c.name === "exam_session")?.path).toBe("/");
      expect(cookies.find((c) => c.name === "cs_session")).toBeDefined();
      // La session est marquée vérifiée : c'est ce que le proxy exigera.
      expect(h.starts[0]?.opts.sebVerified).toBe(true);
    });
  });
});

// --- registre des jetons consommés ------------------------------------------

describe("consumeJti", () => {
  it("accepte un `jti` neuf, refuse le second, purge les expirés", () => {
    const handle = openDb(":memory:");
    const t = Math.floor(Date.now() / 1000);
    expect(consumeJti(handle.db, "a", t + 300)).toBe(true);
    expect(consumeJti(handle.db, "a", t + 300)).toBe(false);
    // Un jeton déjà expiré : la ligne est posée puis balayée au passage
    // suivant, parce que `verifyHs256` le refuse de toute façon.
    consumeJti(handle.db, "vieux", t - 3600);
    consumeJti(handle.db, "b", t + 300);
    const rows = handle.db.all<{ jti: string }>("SELECT jti FROM launch_tokens_used ORDER BY jti");
    expect(rows.map((r) => r.jti)).toEqual(["a", "b"]);
    handle.close();
  });
});
