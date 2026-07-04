import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
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
