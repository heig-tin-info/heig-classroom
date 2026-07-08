import { existsSync } from "node:fs";
import { resolve } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { sql } from "drizzle-orm";
import { collectDefaultMetrics, Gauge, Registry } from "prom-client";

import type { HealthResponse } from "@hgc/contracts";
import { githubLinkPlugin } from "./auth/github-link.js";
import { authPlugin } from "./auth/plugin.js";
import type { AppConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { assignmentsPlugin } from "./modules/assignments.js";
import { publish } from "./events.js";
import { adminPlugin } from "./modules/admin.js";
import { avatarPlugin } from "./modules/avatar.js";
import { classroomsPlugin } from "./modules/classrooms.js";
import { eventsPlugin } from "./modules/events.js";
import { studentPlugin } from "./modules/student.js";
import { makeWebhookHandler, webhooksPlugin } from "./modules/webhooks.js";
import { makeDeadlineHandler } from "./deadline.js";
import { startJobs } from "./jobs.js";
import { runTask, seedTasks } from "./tasks.js";
import { startTicker } from "./ticker.js";

export interface AppDeps {
  config: AppConfig;
}

export async function buildApp({ config }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // AU-41: never put credentials in the logs.
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    trustProxy: true, // always behind Caddy (ADR-009)
  });

  const { db, pool } = createDb(config.DATABASE_URL);
  app.decorate("db", db);
  app.addHook("onClose", async () => {
    await pool.end();
  });

  // Roster import: the CSV arrives as-is in req.body (AU-13).
  app.addContentTypeParser(["text/csv", "text/plain"], { parseAs: "string" }, (_req, body, done) =>
    done(null, body),
  );
  // Avatars: raw binary image (≤ 1 MB, default Fastify limit).
  app.addContentTypeParser(
    ["image/jpeg", "image/png", "image/webp"],
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  // Every successful HTTP mutation emits an SSE refresh hint (ADR-005).
  // Changes outside a direct mutation (automatic claim, acceptance,
  // GitHub linking) publish explicitly from their own modules.
  app.addHook("onResponse", async (req, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    if (reply.statusCode >= 400 || !req.user) return;
    const classroom = /^\/app\/api\/classrooms\/([0-9a-f-]{36})/.exec(req.url);
    if (classroom) publish("mutation", [`classroom:${classroom[1]}`]);
    else if (req.url.startsWith("/app/api/classrooms")) publish("mutation", [`teacher:${req.user.id}`]);
    else publish("mutation", [`user:${req.user.id}`]);
  });

  await app.register(fastifyCookie, { secret: config.COOKIE_SECRET });
  await app.register(authPlugin, { config });
  await app.register(eventsPlugin);
  await app.register(githubLinkPlugin, { config });
  await app.register(adminPlugin, { config });
  await app.register(avatarPlugin);
  await app.register(classroomsPlugin, { config });
  await app.register(assignmentsPlugin, { config });
  await app.register(studentPlugin, { config });

  // Job queue + webhooks (M3). The webhooks plugin is encapsulated: its raw
  // JSON parser (HMAC) does not leak onto other routes. A database that is
  // unreachable at boot does not kill the server: healthz stays degraded and
  // the webhook endpoint answers 503 until restart.
  const runWorkers = config.WORKER_MODE !== "web";
  try {
    await startJobs(app, {
      connectionString: config.DATABASE_URL,
      runWorkers,
      webhookHandler: makeWebhookHandler(app, config),
      deadlineHandler: makeDeadlineHandler(app, config),
      taskRunner: (key) => runTask(app, config, key),
    });
    await seedTasks(app);
    // Deadline ticker + scheduled tasks (ADR-006): worker side only.
    if (runWorkers) startTicker(app, config);
  } catch (err) {
    app.log.error({ err }, "pg-boss start failed — job queue disabled");
  }
  await app.register(webhooksPlugin, { config });

  // Built SPA served by the monolith (ADR-009: single image, frontend included).
  if (config.STATIC_DIR && existsSync(config.STATIC_DIR)) {
    await app.register(fastifyStatic, { root: resolve(config.STATIC_DIR) });
    app.setNotFoundHandler((req, reply) => {
      // SPA fallback for navigation; API surfaces keep their JSON 404.
      const isApi = ["/app/", "/api/", "/webhooks/"].some((p) => req.url.startsWith(p));
      if (req.method === "GET" && !isApi) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "not_found" });
    });
  }

  // --- Observability (NFR-08, docs/03 « Observabilité orientée exigences ») ---
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const dbUp = new Gauge({
    name: "hgc_database_up",
    help: "1 if PostgreSQL answers SELECT 1",
    registers: [registry],
  });

  async function checkDatabase(): Promise<boolean> {
    try {
      await db.execute(sql`SELECT 1`);
      dbUp.set(1);
      return true;
    } catch {
      dbUp.set(0);
      return false;
    }
  }

  app.get("/healthz", async (_req, reply) => {
    const databaseOk = await checkDatabase();
    const body: HealthResponse = {
      status: databaseOk ? "ok" : "degraded",
      checks: {
        database: databaseOk ? "up" : "down",
        jobs: app.boss ? "up" : "down",
      },
      uptimeSeconds: Math.round(process.uptime()),
    };
    return reply.code(databaseOk ? 200 : 503).send(body);
  });

  app.get("/metrics", async (_req, reply) => {
    await checkDatabase();
    return reply.type(registry.contentType).send(await registry.metrics());
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    db: ReturnType<typeof createDb>["db"];
  }
}
