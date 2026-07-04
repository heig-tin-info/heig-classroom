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
  return parsed.data;
}
