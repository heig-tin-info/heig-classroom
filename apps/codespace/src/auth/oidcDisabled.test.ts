/**
 * Le portail déployé **sans fournisseur d'identité**.
 *
 * C'est l'état du déploiement de `docs/deploy.md` : Switch edu-ID n'est pas
 * encore déclaré, les étudiants arrivent tous par le jeton de lancement de
 * classroom. `OIDC_ISSUER` vide doit alors faire disparaître les routes de
 * connexion — et rien d'autre. En particulier, `/launch` reste entier, et
 * aucun autre chemin ne permet de devenir `request.user` (invariant 4).
 */
import { afterEach, describe, expect, it } from "vitest";

import { openDb, type DbHandle } from "../db/client.js";
import type { ContainerInfo, Engine } from "../engine/index.js";
import { buildPortal, type Portal } from "../server.js";

import { loadConfig } from "./config.js";

const LAUNCH_SECRET = "secret-de-lancement-de-test-0123456789";

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

describe("OIDC_ISSUER vide : connexion autonome désactivée", () => {
  it("les routes de connexion n'existent pas", async () => {
    const p = await portalWith("");
    for (const url of ["/auth/login", "/auth/callback", "/auth/logout"]) {
      const reply = await p.app.inject({ url, headers: HTML });
      expect(reply.statusCode, url).toBe(404);
    }
  });

  it("une page qui exige un utilisateur répond 503 et nomme la cause", async () => {
    const p = await portalWith("");
    const reply = await p.app.inject({ url: "/", headers: HTML });
    // Surtout pas une redirection vers `/auth/login`, qui serait un 404.
    expect(reply.statusCode).toBe(503);
    expect(reply.body).toContain("heig-classroom");
    const json = await p.app.inject({ url: "/teacher/sessions" });
    expect(json.statusCode).toBe(503);
    expect(json.json()).toEqual({ error: "oidc_disabled" });
  });

  it("/launch et /healthz restent entiers : c'est le chemin des étudiants", async () => {
    const p = await portalWith("");
    expect((await p.app.inject({ url: "/healthz" })).statusCode).toBe(200);
    // La route existe (pas 404) et oppose son propre refus au jeton bidon.
    const launch = await p.app.inject({ url: "/launch?token=pas-un-jeton", headers: HTML });
    expect(launch.statusCode).toBe(403);
  });

  it("avec un émetteur, les routes de connexion sont de nouveau là", async () => {
    const p = await portalWith("http://localhost:8080/realms/hgc-dev");
    expect(p.app.hasRoute({ method: "GET", url: "/auth/login" })).toBe(true);
    expect(p.app.hasRoute({ method: "GET", url: "/auth/callback" })).toBe(true);
    // Et la garde redirige de nouveau au lieu de répondre 503.
    const reply = await p.app.inject({ url: "/", headers: HTML });
    expect(reply.statusCode).toBe(303);
    expect(reply.headers["location"]).toBe("/auth/login");
  });
});
