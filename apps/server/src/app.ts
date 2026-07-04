import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { collectDefaultMetrics, Gauge, Registry } from "prom-client";

import type { HealthResponse } from "@hgc/contracts";
import type { AppConfig } from "./config.js";
import { createDb } from "./db/client.js";

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
