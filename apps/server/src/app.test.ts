import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
    // Shape of a Drizzle failure: the SQL and its params in the message, the
    // pg error (SQLSTATE and all) in `cause`. Registered here because routes
    // cannot be added once the app is ready.
    app.get("/__boom", async () => {
      throw new Error(
        'Failed query: select "users"."id" from "sessions" where "sid_hash" = $1 limit $2\nparams: 8ae4ab,1',
        {
          cause: Object.assign(
            new Error("terminating connection due to administrator command"),
            { code: "57P01" },
          ),
        },
      );
    });
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

  it("a failing route answers a generic 500 and logs the cause", async () => {
    // Fastify logs through a per-request child logger: intercept its creation.
    const logged: Array<{ cause?: { code?: string } }> = [];
    const makeChild = app.log.child.bind(app.log);
    const spy = vi
      .spyOn(app.log, "child")
      .mockImplementation((...args: Parameters<typeof makeChild>) => {
        const child = makeChild(...args);
        child.error = ((entry: { cause?: { code?: string } }) => {
          logged.push(entry);
        }) as typeof child.error;
        return child;
      });

    const res = await app.inject({ method: "GET", url: "/__boom" });
    spy.mockRestore();

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error" });
    // Neither the SQL nor the params reach the browser.
    expect(res.body).not.toContain("Failed query");
    expect(res.body).not.toContain("sid_hash");
    // ... while the pg error behind the Drizzle wrapper is kept in the logs.
    expect(logged.at(-1)?.cause?.code).toBe("57P01");
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
