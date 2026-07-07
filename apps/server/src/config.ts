import { resolve } from "node:path";

import { z } from "zod";

/**
 * Configuration par variables d'environnement, validée au démarrage (fail-fast).
 * Les secrets ne transitent que par l'environnement (ADR-010).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** ADR-001 : `all` (défaut) | `web` | `worker` — scission sans changement de code. */
  WORKER_MODE: z.enum(["all", "web", "worker"]).default("all"),
  DATABASE_URL: z
    .string()
    .default("postgres://hgc:hgc@localhost:5432/hgc"),
  /** Applique les migrations Drizzle au démarrage (déploiement conteneur). */
  MIGRATE_ON_START: z
    .string()
    .default("")
    .transform((v) => v === "1" || v === "true"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  /** URL publique du portail (base des redirect URIs OIDC/OAuth). */
  PUBLIC_URL: z.string().default("http://localhost:3000"),

  /** Dossier du SPA buildé (apps/web/dist) ; vide = API seule (dev Vite). */
  STATIC_DIR: z.string().default(""),

  // --- OIDC (AU-01..03) : Keycloak local en dev, Switch edu-ID en prod. ---
  OIDC_ISSUER: z.string().default("http://localhost:8080/realms/hgc-dev"),
  OIDC_CLIENT_ID: z.string().default("hgc-portal"),
  OIDC_CLIENT_SECRET: z.string().default("dev-secret-not-for-production"),
  /**
   * Authentification client `private_key_jwt` (recommandée par SWITCH) :
   * chemin d'une clé privée PKCS8 dont le JWK public est enregistré au
   * Resource Registry. Vide = client_secret (Keycloak de dev).
   */
  OIDC_PRIVATE_KEY_PATH: z.string().default(""),
  OIDC_PRIVATE_KEY_KID: z.string().default("hgc-eduid-2026"),

  /** Signature des cookies d'état de login (pas des sessions, qui vivent en base). */
  COOKIE_SECRET: z.string().min(16).default("dev-cookie-secret-change-me"),
  /** Durée de session (AU-06 : 12 h par défaut). */
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(72).default(12),
  /**
   * Super administrateur (révision de H2, 2026-07-07) : seul e-mail géré par
   * l'environnement. Les teachers sont gérés en base, depuis l'écran admin.
   */
  SUPER_ADMIN_EMAIL: z.string().default(""),

  // --- GitHub App (GH-01..03) : provisionnement, webhooks, identité bot. ---
  // Vides tant que l'App n'est pas configurée ; les modules GitHub refusent
  // de démarrer sans elles, le reste du portail fonctionne.
  GITHUB_APP_ID: z.string().default(""),
  /** Chemin du PEM (ADR-010 : secret en fichier, jamais dans le dépôt). */
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().default(""),
  GITHUB_APP_SLUG: z.string().default(""),
  GITHUB_WEBHOOK_SECRET: z.string().default(""),

  // --- OAuth App (AU-08..12) : liaison du compte GitHub, scope read:user. ---
  GITHUB_OAUTH_CLIENT_ID: z.string().default(""),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().default(""),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Configuration invalide — ${issues}`);
  }
  if (parsed.data.NODE_ENV === "production") {
    for (const [key, marker] of [
      ["OIDC_CLIENT_SECRET", "not-for-production"],
      ["COOKIE_SECRET", "change-me"],
    ] as const) {
      if (parsed.data[key].includes(marker)) {
        throw new Error(`Configuration invalide — ${key} de dev interdit en production`);
      }
    }
  }
  return {
    ...parsed.data,
    SUPER_ADMIN_EMAIL: parsed.data.SUPER_ADMIN_EMAIL.trim().toLowerCase(),
    // Chemin du PEM absolu dès le chargement : le processus ne dépend plus
    // de son répertoire de lancement (ADR-010, secret en fichier).
    GITHUB_APP_PRIVATE_KEY_PATH: parsed.data.GITHUB_APP_PRIVATE_KEY_PATH
      ? resolve(parsed.data.GITHUB_APP_PRIVATE_KEY_PATH)
      : "",
    OIDC_PRIVATE_KEY_PATH: parsed.data.OIDC_PRIVATE_KEY_PATH
      ? resolve(parsed.data.OIDC_PRIVATE_KEY_PATH)
      : "",
  };
}
