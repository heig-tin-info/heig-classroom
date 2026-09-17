/**
 * Configuration du portail : variables d'environnement validées au démarrage
 * (échec immédiat), comme `apps/server/src/config.ts` de heig-classroom.
 *
 * Elle vit sous `auth/` plutôt qu'à la racine de `src/` pour rester dans le
 * périmètre d'écriture de la tâche V1 ; elle est réexportée par `server.ts`,
 * qui est la racine de composition.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

/**
 * Racine du dépôt : le premier ancêtre de ce module qui porte
 * `pnpm-workspace.yaml`. Les chemins relatifs de la configuration s'y
 * rapportent, et non au répertoire de lancement : `infra/seccomp/...` doit
 * désigner le même fichier qu'on démarre depuis la racine, depuis
 * `apps/portal` (ce que fait `pnpm --filter`) ou depuis un script.
 *
 * La remontée est cherchée plutôt que comptée : le module compilé vit dans
 * `dist/auth/`, pas dans `src/auth/`, et un nombre fixe de `..` désignerait
 * deux répertoires différents selon qu'on lance `pnpm dev` ou `pnpm start`.
 */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("racine du dépôt introuvable (pnpm-workspace.yaml absent des ancêtres)");
}

function fromRepoRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(repoRoot(), path);
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** Origine publique du portail ; base des URI de redirection OIDC. */
  PUBLIC_URL: z.string().default("http://localhost:3000"),
  DATABASE_PATH: z.string().default("./var/codespace.sqlite"),

  // --- Moteur de conteneurs (engine/) -------------------------------------
  /** Toujours par le socket rootful, toujours `--remote` (setup-poste.md). */
  PODMAN_URL: z.string().default("unix:///run/podman/podman.sock"),
  CODESPACE_NETWORK: z.string().default("codespace"),
  CODESPACE_GATEWAY: z.string().default("10.77.0.254"),
  CODESPACE_GIT_PORT: z.coerce.number().int().min(1).max(65535).default(9418),
  VOLUMES_ROOT: z.string().default("./var/volumes"),
  /** Profil seccomp du projet ; chemin absolu passé tel quel à Podman. */
  SECCOMP_PROFILE: z.string().default("./infra/seccomp/codespace.json"),
  CODESPACE_IMAGE: z.string().default("codespace/c-dev:4.137.0"),
  CODESPACE_MEMORY: z.string().default("1536m"),
  CODESPACE_CPUS: z.string().default("1"),
  CODESPACE_PIDS_LIMIT: z.coerce.number().int().min(16).default(256),

  // --- Cycle de vie des sessions (sessions/) -------------------------------
  /** Grâce après le dernier battement avant destruction du conteneur. */
  SESSION_GRACE_MS: z.coerce.number().int().min(1000).default(10 * 60 * 1000),
  /** Période du ramasse-miettes. */
  SESSION_GC_INTERVAL_MS: z.coerce.number().int().min(1000).default(60 * 1000),
  /** Période des instantanés du dépôt fantôme (analyse.md 3.3). */
  SHADOW_INTERVAL_MS: z.coerce.number().int().min(1000).default(3 * 60 * 1000),
  /** Attente maximale de `/healthz` du conteneur au démarrage d'une session. */
  SESSION_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),

  // --- OIDC (invariant 4 : réel même en dev) -------------------------------
  OIDC_ISSUER: z.string().default("http://localhost:8080/realms/codespace-dev"),
  OIDC_CLIENT_ID: z.string().default("codespace-portal"),
  OIDC_CLIENT_SECRET: z.string().default("dev-secret-not-for-production"),
  /** Nom de la revendication portant les rôles de realm (mappeur du realm dev). */
  OIDC_ROLES_CLAIM: z.string().default("codespace_roles"),
  /** Valeur de rôle qui donne le rôle enseignant. */
  OIDC_TEACHER_ROLE: z.string().default("teacher"),
  /** Signe le cookie d'état de connexion et le cookie de session du portail. */
  COOKIE_SECRET: z.string().min(16).default("dev-cookie-secret-change-me"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),

  // --- Forge (git/relay.ts) -----------------------------------------------
  FORGE_KIND: z.enum(["forgejo", "github", "none"]).default("forgejo"),
  FORGE_URL: z.string().default("http://localhost:3300"),
  FORGE_TOKEN: z.string().default(""),
  FORGE_USER: z.string().default("codespace"),

  // --- SEB (seb/) ----------------------------------------------------------
  SEB_VERIFIER: z.enum(["real", "simulated"]).default("simulated"),
  /**
   * Origine sur laquelle SEB calcule ses hachés. Vide = reconstruction depuis
   * `Host`, acceptable en développement en clair seulement (analyse.md 4.6).
   */
  SEB_PUBLIC_ORIGIN: z.string().default(""),
  /** Secret HMAC du cookie `exam_session`. */
  EXAM_COOKIE_SECRET: z.string().min(16).default("dev-exam-cookie-secret-change-me"),
  EXAM_COOKIE_MAX_AGE_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(4 * 60 * 60 * 1000),

  /**
   * `trustProxy` de Fastify. **Développement uniquement** : il rend
   * `request.ip` contrôlable par `X-Forwarded-For`, ce dont `scripts/e2e.ts`
   * a besoin pour simuler un second poste. En production, le portail est
   * derrière un frontal maîtrisé ou rien du tout.
   */
  TRUST_PROXY: z
    .string()
    .default("")
    .transform((v) => v === "1" || v === "true"),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  /** Rendus absolus au chargement, relativement à la racine du dépôt. */
  volumesRoot: string;
  seccompProfile: string;
  databasePath: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" ; ");
    throw new Error(`Configuration invalide : ${issues}`);
  }
  const data = parsed.data;
  if (data.NODE_ENV === "production") {
    // Même garde que heig-classroom : un secret de développement en production
    // est une erreur de déploiement, pas un réglage.
    for (const [key, marker] of [
      ["OIDC_CLIENT_SECRET", "not-for-production"],
      ["COOKIE_SECRET", "change-me"],
      ["EXAM_COOKIE_SECRET", "change-me"],
    ] as const) {
      if (data[key].includes(marker)) {
        throw new Error(`Configuration invalide : ${key} de développement interdit en production`);
      }
    }
    if (data.TRUST_PROXY) {
      throw new Error("Configuration invalide : TRUST_PROXY est un réglage de développement");
    }
    // Invariant 8 : la garde de fond est dans `createSebVerifier`, celle-ci
    // fait échouer le démarrage plus tôt et avec un message de configuration.
    if (data.SEB_VERIFIER === "simulated") {
      throw new Error("Configuration invalide : SEB_VERIFIER=simulated interdit en production");
    }
    if (data.SEB_PUBLIC_ORIGIN === "") {
      throw new Error("Configuration invalide : SEB_PUBLIC_ORIGIN est obligatoire en production");
    }
  }
  return {
    ...data,
    volumesRoot: fromRepoRoot(data.VOLUMES_ROOT),
    seccompProfile: fromRepoRoot(data.SECCOMP_PROFILE),
    databasePath: fromRepoRoot(data.DATABASE_PATH),
  };
}
