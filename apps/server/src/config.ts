import { resolve } from "node:path";

import { z } from "zod";

/**
 * Configuration via environment variables, validated at startup (fail-fast).
 * Secrets only travel through the environment (ADR-010).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** ADR-001: `all` (default) | `web` | `worker`; roles can split without code changes. */
  WORKER_MODE: z.enum(["all", "web", "worker"]).default("all"),
  DATABASE_URL: z
    .string()
    .default("postgres://hgc:hgc@localhost:5432/hgc"),
  /** Apply Drizzle migrations at startup (container deployment). */
  MIGRATE_ON_START: z
    .string()
    .default("")
    .transform((v) => v === "1" || v === "true"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  /** Public URL of the portal (base for OIDC/OAuth redirect URIs). */
  PUBLIC_URL: z.string().default("http://localhost:3000"),

  /** Directory of the built SPA (apps/web/dist); empty = API only (Vite dev). */
  STATIC_DIR: z.string().default(""),

  // --- OIDC (AU-01..03): local Keycloak in dev, Switch edu-ID in prod. ---
  OIDC_ISSUER: z.string().default("http://localhost:8080/realms/hgc-dev"),
  OIDC_CLIENT_ID: z.string().default("hgc-portal"),
  OIDC_CLIENT_SECRET: z.string().default("dev-secret-not-for-production"),
  /**
   * `private_key_jwt` client authentication (recommended by SWITCH):
   * path to a PKCS8 private key whose public JWK is registered in the
   * Resource Registry. Empty = client_secret (dev Keycloak).
   */
  OIDC_PRIVATE_KEY_PATH: z.string().default(""),
  OIDC_PRIVATE_KEY_KID: z.string().default("hgc-eduid-2026"),

  /** Signs the login state cookies (not the sessions, which live in the database). */
  COOKIE_SECRET: z.string().min(16).default("dev-cookie-secret-change-me"),
  /**
   * Session idle timeout (AU-06: 12 h by default). Sessions renew while in
   * use (sliding expiry), so this bounds the inactivity gap, not the total
   * signed-in time. 720 h = 30 days.
   */
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  /**
   * Super administrator (H2 revision, 2026-07-07): the only email managed
   * through the environment. Teachers are managed in the database, from the
   * admin screen.
   */
  SUPER_ADMIN_EMAIL: z.string().default(""),

  // --- Transactional email (Scaleway TEM). Without the two SCW credentials
  // the mailer runs in dry-run mode: emails are logged, never sent. ---
  SCW_SECRET_KEY: z.string().default(""),
  SCW_DEFAULT_PROJECT_ID: z.string().default(""),
  MAIL_FROM: z.string().default("no-reply@chevallier.io"),
  MAIL_FROM_NAME: z.string().default("HEIG Classroom"),
  MAIL_REGION: z.string().default("fr-par"),

  // --- GitHub App (GH-01..03): provisioning, webhooks, bot identity. ---
  // Empty until the App is configured; the GitHub modules refuse to start
  // without them, the rest of the portal keeps working.
  GITHUB_APP_ID: z.string().default(""),
  /** Path to the PEM (ADR-010: secret in a file, never in the repository). */
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().default(""),
  GITHUB_APP_SLUG: z.string().default(""),
  GITHUB_WEBHOOK_SECRET: z.string().default(""),

  // --- Account linking (AU-08..12): user-to-server OAuth of the GitHub App
  // itself (Settings → the App → Client ID / Generate a client secret).
  // The former separate OAuth App is gone: a GitHub App carries up to ten
  // callback URLs and its user tokens serve GET /user without any scope.
  GITHUB_APP_CLIENT_ID: z.string().default(""),
  GITHUB_APP_CLIENT_SECRET: z.string().default(""),
  /** Legacy names (pre single-app); read as fallback, remove eventually. */
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
    throw new Error(`Invalid configuration: ${issues}`);
  }
  if (parsed.data.NODE_ENV === "production") {
    for (const [key, marker] of [
      ["OIDC_CLIENT_SECRET", "not-for-production"],
      ["COOKIE_SECRET", "change-me"],
    ] as const) {
      if (parsed.data[key].includes(marker)) {
        throw new Error(`Invalid configuration: dev ${key} forbidden in production`);
      }
    }
  }
  return {
    ...parsed.data,
    SUPER_ADMIN_EMAIL: parsed.data.SUPER_ADMIN_EMAIL.trim().toLowerCase(),
    // Single-app migration: the old OAuth App variables keep working until
    // the environment is updated to the App's own client.
    GITHUB_APP_CLIENT_ID: parsed.data.GITHUB_APP_CLIENT_ID || parsed.data.GITHUB_OAUTH_CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET:
      parsed.data.GITHUB_APP_CLIENT_SECRET || parsed.data.GITHUB_OAUTH_CLIENT_SECRET,
    // PEM path made absolute at load time: the process no longer depends on
    // its launch directory (ADR-010, secret in a file).
    GITHUB_APP_PRIVATE_KEY_PATH: parsed.data.GITHUB_APP_PRIVATE_KEY_PATH
      ? resolve(parsed.data.GITHUB_APP_PRIVATE_KEY_PATH)
      : "",
    OIDC_PRIVATE_KEY_PATH: parsed.data.OIDC_PRIVATE_KEY_PATH
      ? resolve(parsed.data.OIDC_PRIVATE_KEY_PATH)
      : "",
  };
}
