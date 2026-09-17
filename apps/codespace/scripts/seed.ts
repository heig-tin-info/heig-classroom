/**
 * Enveloppe de `src/db/seed.ts`. La logique est dans le paquet
 * parce que la racine du dépôt n'a pas de `node_modules` (pnpm workspace).
 *
 *     pnpm seed
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/auth/config.js";
import { runSeed } from "../src/db/seed.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await runSeed({ config: loadConfig(), seedDir: join(repoRoot, "seed") });
