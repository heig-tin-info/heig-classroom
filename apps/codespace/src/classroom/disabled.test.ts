/**
 * Le portail sans classroom en face.
 *
 * `CODESPACE_LAUNCH_SECRET` vide n'est pas un « mode dégradé » : le greffon
 * n'est pas enregistré du tout, les trois routes n'existent pas, et le portail
 * garde sa graine YAML, sa connexion OIDC et son bouton Démarrer. Ce test
 * monte un vrai portail (Fastify, base, greffons, moteur simulé) des deux
 * façons et compare.
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
  { method: "GET" as const, url: "/launch?token=peu-importe" },
];

describe("intégration classroom désactivée", () => {
  it("sans secret partagé, les trois routes n'existent pas", async () => {
    const p = await portalWith("");
    for (const route of ROUTES) {
      const reply = await p.app.inject({ method: route.method, url: route.url, payload: {} });
      expect(reply.statusCode, route.url).toBe(404);
    }
    // Le portail autonome, lui, répond.
    expect((await p.app.inject({ url: "/healthz" })).statusCode).toBe(200);
  });

  it("avec le secret, les trois routes existent et opposent leur propre refus", async () => {
    const p = await portalWith("secret-de-lancement-de-test-0123456789");
    const puts = await p.app.inject({ method: "PUT", url: "/api/assignments/a1", payload: {} });
    expect(puts.statusCode).toBe(401);
    const list = await p.app.inject({ url: "/api/assignments/a1/sessions" });
    expect(list.statusCode).toBe(401);
    const launch = await p.app.inject({ url: "/launch?token=peu-importe" });
    expect(launch.statusCode).toBe(403);
  });

  it("refuse un secret trop court plutôt que de l'accepter à moitié", () => {
    expect(() => loadConfig({ CODESPACE_LAUNCH_SECRET: "trop-court" })).toThrow(
      /CODESPACE_LAUNCH_SECRET/,
    );
  });

  it("refuse un secret de développement en production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        OIDC_CLIENT_SECRET: "vrai",
        COOKIE_SECRET: "un-vrai-secret-de-production",
        EXAM_COOKIE_SECRET: "un-autre-vrai-secret-de-prod",
        SEB_VERIFIER: "real",
        SEB_PUBLIC_ORIGIN: "https://codespace.heig-vd.ch",
        CODESPACE_LAUNCH_SECRET: "dev-launch-secret-change-me-0123456789",
      }),
    ).toThrow(/CODESPACE_LAUNCH_SECRET/);
  });
});
