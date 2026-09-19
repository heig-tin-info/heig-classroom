import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/*
 * The SPA served by the monolith (ADR-009). Nothing exercised this before:
 * STATIC_DIR is empty by default, so the whole branch — @fastify/static and
 * the not-found handler that falls back to index.html — was skipped in tests
 * while production always sets it. A deep link 404ing for every student is
 * exactly the kind of break a @fastify/static major can introduce with the
 * suite still green.
 */
describe("app (serving the built SPA)", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "hgc-static-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>SPA</title>");
    await writeFile(join(dir, "app.js"), "export const x = 1;\n");
    app = await buildApp({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgres://nobody:nope@127.0.0.1:59999/absent",
        STATIC_DIR: dir,
      }),
    });
  });
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves a built asset from the static root", async () => {
    const res = await app.inject({ method: "GET", url: "/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("export const x = 1;");
  });

  it("falls back to index.html on a deep link, so a reload keeps the page", async () => {
    const res = await app.inject({ method: "GET", url: "/classrooms/c1/assignments/a2" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>SPA</title>");
  });

  it("leaves the API surfaces their JSON 404", async () => {
    for (const url of ["/app/api/nope", "/api/nope", "/webhooks/nope"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
    }
  });

  it("does not hand the SPA to a non-GET request", async () => {
    const res = await app.inject({ method: "POST", url: "/whatever" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });
});
