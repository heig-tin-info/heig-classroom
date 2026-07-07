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
import { classroomsPlugin } from "./modules/classrooms.js";
import { eventsPlugin } from "./modules/events.js";
import { studentPlugin } from "./modules/student.js";

export interface AppDeps {
  config: AppConfig;
}

export async function buildApp({ config }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // AU-41 : jamais de credentials dans les logs.
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    trustProxy: true, // toujours derrière Caddy (ADR-009)
  });

  const { db, pool } = createDb(config.DATABASE_URL);
  app.decorate("db", db);
  app.addHook("onClose", async () => {
    await pool.end();
  });

  // Import du roster : le CSV arrive tel quel dans req.body (AU-13).
  app.addContentTypeParser(["text/csv", "text/plain"], { parseAs: "string" }, (_req, body, done) =>
    done(null, body),
  );

  // Toute mutation HTTP réussie émet un indice de rafraîchissement SSE
  // (ADR-005). Les changements hors mutation directe (claim automatique,
  // acceptation, liaison GitHub) publient explicitement dans leurs modules.
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
  await app.register(classroomsPlugin, { config });
  await app.register(assignmentsPlugin, { config });
  await app.register(studentPlugin, { config });

  // SPA buildé servi par le monolithe (ADR-009 : image unique, front inclus).
  if (config.STATIC_DIR && existsSync(config.STATIC_DIR)) {
    await app.register(fastifyStatic, { root: resolve(config.STATIC_DIR) });
    app.setNotFoundHandler((req, reply) => {
      // Fallback SPA pour la navigation ; les surfaces API restent en 404 JSON.
      const isApi = ["/app/", "/api/", "/webhooks/"].some((p) => req.url.startsWith(p));
      if (req.method === "GET" && !isApi) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "not_found" });
    });
  }

  // --- Observabilité (NFR-08, docs/03 « Observabilité orientée exigences ») ---
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const dbUp = new Gauge({
    name: "hgc_database_up",
    help: "1 si PostgreSQL répond à SELECT 1",
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
        // pg-boss démarre en M3 (webhooks/jobs) ; jusque-là l'état suit la base.
        jobs: databaseOk ? "up" : "down",
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
