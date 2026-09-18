/**
 * The portal without classroom in front of it.
 *
 * An empty `CODESPACE_LAUNCH_SECRET` is not a "degraded mode": the plugin is
 * not registered at all, the three routes do not exist, and the portal keeps
 * its YAML seed, its OIDC login and its Start button. This test builds a real
 * portal (Fastify, database, plugins, fake engine) both ways and compares.
 */
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../auth/config.js";
import { openDb, type DbHandle } from "../db/client.js";
import type { ContainerInfo, Engine } from "../engine/index.js";
import { buildPortal, type Portal } from "../server.js";

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

async function portalWith(launchSecret: string): Promise<Portal> {
  handle = openDb(":memory:");
  portal = await buildPortal({
    config: loadConfig({
      LOG_LEVEL: "fatal",
      SEB_VERIFIER: "simulated",
      CODESPACE_LAUNCH_SECRET: launchSecret,
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

const ROUTES = [
  { method: "PUT" as const, url: "/api/assignments/a1" },
  { method: "GET" as const, url: "/api/assignments/a1/sessions" },
  { method: "GET" as const, url: "/launch?token=whatever" },
];

describe("classroom integration disabled", () => {
  it("without a shared secret, the three routes do not exist", async () => {
    const p = await portalWith("");
    for (const route of ROUTES) {
      const reply = await p.app.inject({ method: route.method, url: route.url, payload: {} });
      expect(reply.statusCode, route.url).toBe(404);
    }
    // The standalone portal, for its part, answers.
    expect((await p.app.inject({ url: "/healthz" })).statusCode).toBe(200);
  });

  it("with the secret, the three routes exist and oppose their own refusal", async () => {
    const p = await portalWith("test-launch-secret-0123456789012345");
    const puts = await p.app.inject({ method: "PUT", url: "/api/assignments/a1", payload: {} });
    expect(puts.statusCode).toBe(401);
    const list = await p.app.inject({ url: "/api/assignments/a1/sessions" });
    expect(list.statusCode).toBe(401);
    const launch = await p.app.inject({ url: "/launch?token=whatever" });
    expect(launch.statusCode).toBe(403);
  });

  it("refuses a too-short secret rather than half-accepting it", () => {
    expect(() => loadConfig({ CODESPACE_LAUNCH_SECRET: "too-short" })).toThrow(
      /CODESPACE_LAUNCH_SECRET/,
    );
  });

  it("refuses a development secret in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        OIDC_CLIENT_SECRET: "real",
        COOKIE_SECRET: "a-real-production-secret",
        EXAM_COOKIE_SECRET: "another-real-prod-secret",
        SEB_VERIFIER: "real",
        SEB_PUBLIC_ORIGIN: "https://codespace.heig-vd.ch",
        CODESPACE_LAUNCH_SECRET: "dev-launch-secret-change-me-0123456789",
      }),
    ).toThrow(/CODESPACE_LAUNCH_SECRET/);
  });
});
