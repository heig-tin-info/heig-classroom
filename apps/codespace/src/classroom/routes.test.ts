/**
 * Classroom → portal boundary: the assignment PUT and the `/launch` route.
 *
 * Everything is in memory — `:memory:` SQLite database, fake session manager,
 * SEB verifier in `simulated` mode. What is checked here is the logic of the
 * boundary: the authentication of the two tokens, the idempotence of the
 * upsert, the SEB configuration regenerated on classroom's URL, and the seven
 * refusal reasons of `/launch`. Podman, Keycloak and Forgejo are exercised by
 * `scripts/e2e.ts`.
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

const SECRET = "test-launch-secret-0123456789012345";
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

// --- tokens -----------------------------------------------------------------

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

// --- PUT body ---------------------------------------------------------------

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

// --- fake session manager ---------------------------------------------------

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
        cookieToken: "cookie-token",
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
        cookieToken: "cookie-token",
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
  it("401 without a service token", async () => {
    expect((await put(syncBody(), null)).statusCode).toBe(401);
  });

  it("401 with a signature made with another secret", async () => {
    const forged = await signHs256(
      { iss: "heig-classroom", aud: "heig-codespace-api", iat: now(), exp: now() + 300 },
      "another-secret-of-thirty-two-chars",
    );
    expect((await put(syncBody(), forged)).statusCode).toBe(401);
  });

  it("401 with the right signature but the wrong audience", async () => {
    // A *launch* token must not open the service API.
    const token = await serviceToken({ aud: "heig-codespace" });
    expect((await put(syncBody(), token)).statusCode).toBe(401);
  });

  it("401 with an unexpected issuer", async () => {
    const token = await serviceToken({ iss: "heig-codespace" });
    expect((await put(syncBody(), token)).statusCode).toBe(401);
  });

  it("401 with an expired token", async () => {
    const token = await serviceToken({ iat: now() - 7200, exp: now() - 3600 });
    expect((await put(syncBody(), token)).statusCode).toBe(401);
  });

  it("400 on a body that is not the contract's", async () => {
    const token = await serviceToken();
    const reply = await put(syncBody({ mode: "free" }), token);
    expect(reply.statusCode).toBe(400);
    expect((reply.json() as { error: string }).error).toBe("invalid_body");
  });

  it("400 if the body id and the URL id differ", async () => {
    const token = await serviceToken();
    const reply = await put(syncBody({ id: "a-other" }), token, "a-lab");
    expect(reply.statusCode).toBe(400);
  });

  it("400 if the id cannot name a volume directory", async () => {
    const token = await serviceToken();
    const reply = await put(syncBody({ id: "a$b" }), token, "a$b");
    expect(reply.statusCode).toBe(400);
  });

  it("400 for an exam-mode assignment without a Browser Exam Key", async () => {
    const token = await serviceToken();
    const reply = await put(syncBody({ mode: "online_seb", browserExamKeys: [] }), token);
    expect(reply.statusCode).toBe(400);
    expect((reply.json() as { error: string }).error).toBe("missing_browser_exam_keys");
  });

  it("creates the assignment, translates the mode and sets classroom's fields", async () => {
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
    // Invariant 6: the teacher's template, in its clonable form.
    expect(row?.templateRepo).toBe("http://forge.test/codespace/tp-modele.git");
    // The target repository is no longer an attribute of the assignment: it
    // comes from the token.
    expect(row?.targetRepo).toBeNull();
    expect(row?.targetRepoPattern).toBeNull();
    expect(row?.image).toBe(h.config.CODESPACE_DEFAULT_IMAGE);
  });

  it("`image` from the body wins over the default image", async () => {
    const token = await serviceToken();
    await put(syncBody({ image: "codespace/python:1" }), token);
    expect(findAssignment(h.db, "a-lab")?.image).toBe("codespace/python:1");
  });

  it("is idempotent: two identical PUTs, one row and the same Config Key", async () => {
    const token = await serviceToken();
    const body = syncBody({ mode: "online_seb", browserExamKeys: ["bek-windows"] });
    const first = await put(body, token);
    const second = await put(body, token);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());

    const rows = h.db.all<{ n: number }>("SELECT count(*) AS n FROM assignments");
    expect(rows[0]?.n).toBe(1);
    // The BEK salt does not move: changing it would invalidate the `.seb`
    // files already distributed, and the idempotence of the PUT depends on it.
    const created = findAssignment(h.db, "a-lab")?.createdAt;
    await put(syncBody({ mode: "online_seb", browserExamKeys: ["bek-windows", "bek-mac"] }), token);
    const after = findAssignment(h.db, "a-lab");
    expect(after?.beks).toEqual(["bek-windows", "bek-mac"]);
    expect(after?.createdAt).toEqual(created);
  });

  it("exam mode: SEB configuration regenerated on classroom's startURL", async () => {
    const token = await serviceToken();
    const reply = await put(
      syncBody({ mode: "online_seb", browserExamKeys: ["bek-windows"] }),
      token,
    );
    const body = reply.json() as { id: string; configKey: string; sebLink: string };
    const row = findAssignment(h.db, "a-lab");

    expect(row?.mode).toBe("exam");
    // It is classroom that authenticates the student, then redirects to /launch.
    expect(row?.sebConfig?.startUrl).toBe("http://classroom.test/app/codespace/start/a-lab");
    // The URL filter must let the portal and the identity provider through in
    // addition to classroom (docs/pistes.md).
    expect(row?.sebConfig?.extraAllowedHosts).toEqual(["portal.test", "idp.test"]);
    expect(row?.configKey).toBe(body.configKey);

    // The announced Config Key is indeed the one of that very configuration.
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
    // The `.seb` file itself is still served by the portal.
    expect(body.sebLink).toBe("seb://portal.test/exam/a-lab.seb");
  });

  it("switching an exam assignment back to online mode clears its SEB configuration", async () => {
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
  it("401 without a service token, 404 on an unknown assignment", async () => {
    const anonymous = await h.app.inject({ url: "/api/assignments/a-lab/sessions" });
    expect(anonymous.statusCode).toBe(401);
    const token = await serviceToken();
    const missing = await h.app.inject({
      url: "/api/assignments/a-unknown/sessions",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("returns the session summary with classroom's id", async () => {
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

  it("403 without a token", async () => {
    const reply = await h.app.inject({ url: "/launch" });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toContain("Lancement refusé");
  });

  it("403 on a signature made with another secret", async () => {
    await syncedAssignment();
    const token = await launchToken({}, "another-secret-of-thirty-two-chars");
    const reply = await h.app.inject({ url: `/launch?token=${token}` });
    expect(reply.statusCode).toBe(403);
    expect(h.starts).toHaveLength(0);
  });

  it("403 on an expired token", async () => {
    await syncedAssignment();
    const token = await launchToken({ iat: now() - 7200, exp: now() - 3600 });
    const reply = await h.app.inject({ url: `/launch?token=${token}` });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toContain("expiré");
  });

  it("403 on a service token audience", async () => {
    await syncedAssignment();
    const token = await launchToken({ aud: "heig-codespace-api" });
    expect((await h.app.inject({ url: `/launch?token=${token}` })).statusCode).toBe(403);
  });

  it("single use: the same token does not serve twice", async () => {
    await syncedAssignment();
    const token = await launchToken();
    const first = await h.app.inject({ url: `/launch?token=${token}` });
    expect(first.statusCode).toBe(303);
    const second = await h.app.inject({ url: `/launch?token=${token}` });
    expect(second.statusCode).toBe(403);
    expect(second.body).toContain("déjà servi");
    expect(h.starts).toHaveLength(1);
  });

  it("403 on an assignment not synchronized from classroom", async () => {
    const token = await launchToken({ assignmentId: "a-never-seen" });
    const reply = await h.app.inject({ url: `/launch?token=${token}` });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toContain("non synchronisé depuis classroom");
  });

  it("403 outside the assignment window", async () => {
    await syncedAssignment({ deadlineAt: "2020-06-01T00:00:00.000Z" });
    const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toContain("fenêtre d'ouverture");
  });

  it("403 when the token carries no repository", async () => {
    await syncedAssignment();
    const reply = await h.app.inject({ url: `/launch?token=${await launchToken({ repo: null })}` });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toContain("dépôt");
    expect(h.starts).toHaveLength(0);
  });

  it("opens the session, sets the portal cookie and redirects", async () => {
    await syncedAssignment();
    const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });

    expect(reply.statusCode).toBe(303);
    expect(reply.headers["location"]).toBe("/s/sess-u-sacha-a-lab/");
    const cookies = reply.cookies as Array<{ name: string; value: string; path?: string }>;
    const portal = cookies.find((c) => c.name === "cs_session");
    expect(portal?.value).toBe("sess-u-sacha-a-lab.cookie-token");
    // `Path=/s/<id>`: two sessions in the same browser do not step on each
    // other.
    expect(portal?.path).toBe("/s/sess-u-sacha-a-lab");
    // No exam cookie on a lab assignment.
    expect(cookies.find((c) => c.name === "exam_session")).toBeUndefined();

    // The token's repository, the assignment's teacher and the `jti` are
    // passed on.
    expect(h.starts[0]?.opts).toMatchObject({
      sebVerified: false,
      teacherId: "t-tania",
      targetRepo: { fullName: "codespace/tp-sacha", defaultBranch: "main" },
    });
    expect(h.starts[0]?.opts.launchJti).toMatch(/^jti-/);
  });

  it("registers the user from the claims, without logging them in again", async () => {
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
      // A launch token never grants the teacher role.
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

  describe("per-teacher quota", () => {
    /** Live session of another student, on another assignment of the same teacher. */
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

    it("429 when the teacher's live sessions reach the quota", async () => {
      await syncedAssignment({ quota: { maxActiveSessions: 1 } });
      occupy("u-other", "a-lab");
      const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
      expect(reply.statusCode).toBe(429);
      expect(reply.body).toContain("Quota atteint");
      expect(h.starts).toHaveLength(0);
    });

    it("the quota counts all the teacher's assignments, not only this one", async () => {
      await syncedAssignment({ quota: { maxActiveSessions: 1 } });
      await syncedAssignment({ id: "a-other", quota: { maxActiveSessions: 1 } });
      occupy("u-other", "a-other");
      const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
      expect(reply.statusCode).toBe(429);
    });

    it("resuming one's own live session does not consume quota", async () => {
      await syncedAssignment({ quota: { maxActiveSessions: 1 } });
      // The student already has their session on this assignment: resuming
      // does not open one more container (analyse.md D5).
      occupy("u-sacha", "a-lab");
      const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
      expect(reply.statusCode).toBe(303);
      expect(h.starts).toHaveLength(1);
    });

    it("a closed session no longer counts", async () => {
      await syncedAssignment({ quota: { maxActiveSessions: 1 } });
      occupy("u-other", "a-lab");
      h.db.run("UPDATE sessions SET state = 'closed'" as never);
      const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
      expect(reply.statusCode).toBe(303);
    });
  });

  describe("exam mode", () => {
    async function syncedExam(): Promise<void> {
      const token = await serviceToken();
      const reply = await put(
        syncBody({ mode: "online_seb", browserExamKeys: ["bek-windows"] }),
        token,
      );
      expect(reply.statusCode).toBe(200);
    }

    it("refuses without an SEB verification header", async () => {
      await syncedExam();
      const reply = await h.app.inject({ url: `/launch?token=${await launchToken()}` });
      expect(reply.statusCode).toBe(403);
      expect(reply.body).toContain("Safe Exam Browser");
      expect(h.starts).toHaveLength(0);
    });

    it("accepts with the header and sets both cookies", async () => {
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
      // The session is marked verified: that is what the proxy will require.
      expect(h.starts[0]?.opts.sebVerified).toBe(true);
    });
  });
});

// --- registry of consumed tokens --------------------------------------------

describe("consumeJti", () => {
  it("accepts a fresh `jti`, refuses the second one, purges the expired ones", () => {
    const handle = openDb(":memory:");
    const t = Math.floor(Date.now() / 1000);
    expect(consumeJti(handle.db, "a", t + 300)).toBe(true);
    expect(consumeJti(handle.db, "a", t + 300)).toBe(false);
    // An already expired token: the row is inserted then swept on the next
    // pass, because `verifyHs256` refuses it anyway.
    consumeJti(handle.db, "old", t - 3600);
    consumeJti(handle.db, "b", t + 300);
    const rows = handle.db.all<{ jti: string }>("SELECT jti FROM launch_tokens_used ORDER BY jti");
    expect(rows.map((r) => r.jti)).toEqual(["a", "b"]);
    handle.close();
  });
});
