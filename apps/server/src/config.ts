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
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  /** URL publique du portail (base des redirect URIs OIDC/OAuth). */
  PUBLIC_URL: z.string().default("http://localhost:3000"),

  /** Dossier du SPA buildé (apps/web/dist) ; vide = API seule (dev Vite). */
  STATIC_DIR: z.string().default(""),

  // --- OIDC (AU-01..03) : Keycloak local en dev, Switch edu-ID en prod. ---
  OIDC_ISSUER: z.string().default("http://localhost:8080/realms/hgc-dev"),
  OIDC_CLIENT_ID: z.string().default("hgc-portal"),
  OIDC_CLIENT_SECRET: z.string().default("dev-secret-not-for-production"),

  /** Signature des cookies d'état de login (pas des sessions, qui vivent en base). */
  COOKIE_SECRET: z.string().min(16).default("dev-cookie-secret-change-me"),
  /** Durée de session (AU-06 : 12 h par défaut). */
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(72).default(12),
  /**
   * Provisionnement des teachers par liste d'e-mails (H2 : pas de rôle admin en
   * v1). Vérifié à chaque login : promotion et rétrogradation suivent la liste.
   */
  TEACHER_EMAILS: z.string().default(""),

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

export type AppConfig = z.infer<typeof EnvSchema> & { teacherEmails: Set<string> };

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
  const teacherEmails = new Set(
    parsed.data.TEACHER_EMAILS.split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
  return { ...parsed.data, teacherEmails };
}
