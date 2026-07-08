import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";

const config = loadConfig();

// Container deployment (ADR-009): migrations applied at startup. Drizzle
// serializes them with a database lock, safe even with concurrent startups.
if (config.MIGRATE_ON_START) {
  const { db, pool } = createDb(config.DATABASE_URL);
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
  await migrate(db, { migrationsFolder });
  await pool.end();
}

const app = await buildApp({ config });

// ADR-001: in `worker` mode the process does not listen; it only runs
// pg-boss and the tickers (wired in at milestone M3/M4).
if (config.WORKER_MODE !== "worker") {
  await app.listen({ host: config.HOST, port: config.PORT });
}

app.log.info({ workerMode: config.WORKER_MODE }, "hgc-server started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close().then(() => process.exit(0));
  });
}
