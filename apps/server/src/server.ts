import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";

const config = loadConfig();

// Déploiement conteneur (ADR-009) : migrations appliquées au démarrage.
// Drizzle sérialise par verrou en base — sûr même à plusieurs démarrages.
if (config.MIGRATE_ON_START) {
  const { db, pool } = createDb(config.DATABASE_URL);
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
  await migrate(db, { migrationsFolder });
  await pool.end();
}

const app = await buildApp({ config });

// ADR-001 : en mode `worker`, le processus n'écoute pas — il ne fera tourner
// que pg-boss et les tickers (branchés au jalon M3/M4).
if (config.WORKER_MODE !== "worker") {
  await app.listen({ host: config.HOST, port: config.PORT });
}

app.log.info({ workerMode: config.WORKER_MODE }, "hgc-server démarré");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "arrêt en cours");
    void app.close().then(() => process.exit(0));
  });
}
