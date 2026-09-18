/**
 * The portal deployed **without an identity provider**.
 *
 * This is the state of the `docs/deploy.md` deployment: Switch edu-ID is not
 * declared yet, the students all arrive through classroom's launch token. An
 * empty `OIDC_ISSUER` must then make the login routes disappear — and nothing
 * else. In particular, `/launch` stays whole, and no other path allows becoming
 * `request.user` (invariant 4).
 */
import { afterEach, describe, expect, it } from "vitest";

import { openDb, type DbHandle } from "../db/client.js";
import type { ContainerInfo, Engine } from "../engine/index.js";
import { buildPortal, type Portal } from "../server.js";

import { loadConfig } from "./config.js";

const LAUNCH_SECRET = "test-launch-secret-0123456789012345";

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

let handle: DbHandle | null = null;
let portal: Portal | null = null;

async function portalWith(issuer: string): Promise<Portal> {
  handle = openDb(":memory:");
  portal = await buildPortal({
    config: loadConfig({
      LOG_LEVEL: "fatal",
      SEB_VERIFIER: "simulated",
      OIDC_ISSUER: issuer,
      CODESPACE_LAUNCH_SECRET: LAUNCH_SECRET,
    }),
    dbHandle: handle,
    engine: fakeEngine,
    withGitServer: false,
    withTimers: false,
  });
  return portal;
}

afterEach(async () => {
  await portal?.close();
  handle?.close();
  portal = null;
  handle = null;
});

const HTML = { accept: "text/html" };

describe("empty OIDC_ISSUER: standalone login disabled", () => {
  it("the login routes do not exist", async () => {
    const p = await portalWith("");
    for (const url of ["/auth/login", "/auth/callback", "/auth/logout"]) {
      const reply = await p.app.inject({ url, headers: HTML });
      expect(reply.statusCode, url).toBe(404);
    }
  });

  it("a page that requires a user answers 503 and names the cause", async () => {
    const p = await portalWith("");
    const reply = await p.app.inject({ url: "/", headers: HTML });
    // Certainly not a redirect to `/auth/login`, which would be a 404.
    expect(reply.statusCode).toBe(503);
    expect(reply.body).toContain("heig-classroom");
    const json = await p.app.inject({ url: "/teacher/sessions" });
    expect(json.statusCode).toBe(503);
    expect(json.json()).toEqual({ error: "oidc_disabled" });
  });

  it("/launch and /healthz stay whole: this is the students' path", async () => {
    const p = await portalWith("");
    expect((await p.app.inject({ url: "/healthz" })).statusCode).toBe(200);
    // The route exists (not a 404) and opposes its own refusal to the bogus token.
    const launch = await p.app.inject({ url: "/launch?token=not-a-token", headers: HTML });
    expect(launch.statusCode).toBe(403);
  });

  it("with an issuer, the login routes are back", async () => {
    const p = await portalWith("http://localhost:8080/realms/hgc-dev");
    expect(p.app.hasRoute({ method: "GET", url: "/auth/login" })).toBe(true);
    expect(p.app.hasRoute({ method: "GET", url: "/auth/callback" })).toBe(true);
    // And the guard redirects again instead of answering 503.
    const reply = await p.app.inject({ url: "/", headers: HTML });
    expect(reply.statusCode).toBe(303);
    expect(reply.headers["location"]).toBe("/auth/login");
  });
});
