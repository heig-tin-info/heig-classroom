import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

// M1 foundation: the server must start and respond even without a reachable
// database (healthz "degraded", never a crash), a precondition for the 11 pm
// diagnosis.
describe("app (without a database)", () => {
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

  it("healthz answers 503 degraded when the database is unreachable", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: "degraded",
      checks: { database: "down" },
    });
  });

  it("metrics exposes hgc_database_up", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("hgc_database_up 0");
  });
});

describe("config", () => {
  it("rejects an invalid PORT", () => {
    expect(() => loadConfig({ PORT: "99999" })).toThrow(/Invalid configuration/);
  });
  it("WORKER_MODE defaults to all", () => {
    expect(loadConfig({}).WORKER_MODE).toBe("all");
  });
});
