import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

// Socle M1 : le serveur doit démarrer et répondre même sans base joignable
// (healthz « degraded », jamais de crash) — condition du diagnostic à 23 h.
describe("app (sans base de données)", () => {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://nobody:nope@127.0.0.1:59999/absent",
  });
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({ config });
  });
  afterAll(async () => {
    await app.close();
  });

  it("healthz répond 503 degraded quand la base est injoignable", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: "degraded",
      checks: { database: "down" },
    });
  });

  it("metrics expose hgc_database_up", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("hgc_database_up 0");
  });
});

describe("config", () => {
  it("rejette un PORT invalide", () => {
    expect(() => loadConfig({ PORT: "99999" })).toThrow(/Configuration invalide/);
  });
  it("WORKER_MODE par défaut = all", () => {
    expect(loadConfig({}).WORKER_MODE).toBe("all");
  });
});
