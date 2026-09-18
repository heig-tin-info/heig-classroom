/**
 * Portal configuration: environment variables validated at startup (immediate
 * failure), like `apps/server/src/config.ts` of heig-classroom.
 *
 * It lives under `auth/` rather than at the root of `src/` so as to stay inside
 * the write scope of the V1 task; it is re-exported by `server.ts`, which is
 * the composition root.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

/**
 * Repository root: the first ancestor of this module that carries the
 * application's `package.json`. The relative paths of the configuration are
 * resolved against it, not against the launch directory: `infra/seccomp/...`
 * must designate the same file whether one starts from the root, from
 * `apps/codespace` (what `pnpm --filter` does) or from a script.
 *
 * The walk up is searched rather than counted: the compiled module lives in
 * `dist/auth/`, not in `src/auth/`, and a fixed number of `..` would designate
 * two different directories depending on whether `pnpm dev` or `pnpm start` is
 * run.
 */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("application root not found (no package.json among the ancestors)");
}

function fromRepoRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(repoRoot(), path);
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  /**
   * 3100 by default: in the monorepo, `apps/server` (classroom) occupies 3000
   * and both applications run together in development
   * (docs/integration-classroom.md).
   */
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** Public origin of the portal; base of the OIDC redirect URIs. */
  PUBLIC_URL: z.string().default("http://localhost:3100"),
  DATABASE_PATH: z.string().default("./var/codespace.sqlite"),

  // --- Container engine (engine/) -----------------------------------------
  /** Always through the rootful socket, always `--remote` (setup-poste.md). */
  PODMAN_URL: z.string().default("unix:///run/podman/podman.sock"),
  CODESPACE_NETWORK: z.string().default("codespace"),
  CODESPACE_GATEWAY: z.string().default("10.77.0.254"),
  CODESPACE_GIT_PORT: z.coerce.number().int().min(1).max(65535).default(9418),
  VOLUMES_ROOT: z.string().default("./var/volumes"),
  /** The project's seccomp profile; absolute path passed as is to Podman. */
  SECCOMP_PROFILE: z.string().default("./infra/seccomp/codespace.json"),
  CODESPACE_IMAGE: z.string().default("codespace/c-dev:4.137.0"),
  CODESPACE_MEMORY: z.string().default("1536m"),
  CODESPACE_CPUS: z.string().default("1"),
  CODESPACE_PIDS_LIMIT: z.coerce.number().int().min(16).default(256),

  // --- Session lifecycle (sessions/) ---------------------------------------
  /** Grace period after the last heartbeat before the container is destroyed. */
  SESSION_GRACE_MS: z.coerce.number().int().min(1000).default(10 * 60 * 1000),
  /** Period of the garbage collector. */
  SESSION_GC_INTERVAL_MS: z.coerce.number().int().min(1000).default(60 * 1000),
  /** Period of the shadow repository snapshots (analyse.md 3.3). */
  SHADOW_INTERVAL_MS: z.coerce.number().int().min(1000).default(3 * 60 * 1000),
  /** Maximum wait for the container's `/healthz` when a session starts. */
  SESSION_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),

  // --- OIDC (invariant 4: real even in development) ------------------------
  OIDC_ISSUER: z.string().default("http://localhost:8080/realms/hgc-dev"),
  OIDC_CLIENT_ID: z.string().default("codespace-portal"),
  OIDC_CLIENT_SECRET: z.string().default("dev-secret-not-for-production"),
  /** Name of the claim carrying the realm roles (dev realm mapper). */
  OIDC_ROLES_CLAIM: z.string().default("codespace_roles"),
  /** Role value that grants the teacher role. */
  OIDC_TEACHER_ROLE: z.string().default("teacher"),
  /** Signs the login state cookie and the portal session cookie. */
  COOKIE_SECRET: z.string().min(16).default("dev-cookie-secret-change-me"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),

  // --- Forge (git/relay.ts) -----------------------------------------------
  FORGE_KIND: z.enum(["forgejo", "github", "none"]).default("forgejo"),
  FORGE_URL: z.string().default("http://localhost:3300"),
  FORGE_TOKEN: z.string().default(""),
  FORGE_USER: z.string().default("codespace"),
  /**
   * GitHub App — **the names of heig-classroom, word for word**
   * (`apps/server/src/config.ts`), because it is the same App and the operator
   * copies a value from one `.env` to the other.
   *
   * `FORGE_KIND=github` + `GITHUB_APP_ID` + a readable PEM file = complete
   * forge: installation token resolved by the repository's organization,
   * authenticated bootstrap `git fetch`, authenticated relay. Without either of
   * the two, the forge stays "not configured": only public repositories are
   * reachable and the relay leaves the `PushEvent`s pending
   * (docs/deploy.md § 5).
   *
   * The private key is a **file**, never a variable: a PEM spans several lines
   * and a systemd `EnvironmentFile=` would read only the first one.
   */
  GITHUB_APP_ID: z.string().default(""),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().default(""),

  // --- Classroom integration (classroom/) ----------------------------------
  /**
   * HS256 secret shared with heig-classroom (`packages/contracts`
   * `codespace.ts`). **Empty = integration disabled**: `PUT
   * /api/assignments/:id`, `GET /api/assignments/:id/sessions` and `GET
   * /launch` are not registered and answer 404, and the portal stays usable
   * standalone with its own OIDC login.
   *
   * Thirty-two characters at the very least: an HMAC-SHA256 brings nothing
   * below the size of its output block.
   */
  CODESPACE_LAUNCH_SECRET: z
    .string()
    .default("")
    .refine((v) => v === "" || v.length >= 32, {
      message: "CODESPACE_LAUNCH_SECRET must be at least 32 characters long",
    }),
  /** Public origin of classroom: `startURL` of the `.seb` files and return link. */
  CLASSROOM_URL: z.string().default("http://localhost:3000"),
  /**
   * Image given to a synchronized assignment whose `image` is `null`. Distinct
   * from `CODESPACE_IMAGE`, which is the **engine**'s fallback when a session
   * designates none.
   */
  CODESPACE_DEFAULT_IMAGE: z.string().default("codespace/c-dev:4.137.0"),

  // --- SEB (seb/) ----------------------------------------------------------
  SEB_VERIFIER: z.enum(["real", "simulated"]).default("simulated"),
  /**
   * Hosts allowed by SEB's URL filter **in addition to** classroom's (the host
   * of the `startURL`) and the portal's: the identity provider, without which
   * the login page is blocked (docs/pistes.md, "Correction to the framing
   * document raised by the SEB test"). Comma-separated list.
   */
  SEB_EXTRA_ALLOWED_HOSTS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((h) => h.trim())
        .filter((h) => h !== ""),
    ),
  /**
   * Origin on which SEB computes its hashes. Empty = rebuilt from `Host`,
   * acceptable in development over plain HTTP only (analyse.md 4.6).
   */
  SEB_PUBLIC_ORIGIN: z.string().default(""),
  /** HMAC secret of the `exam_session` cookie. */
  EXAM_COOKIE_SECRET: z.string().min(16).default("dev-exam-cookie-secret-change-me"),
  EXAM_COOKIE_MAX_AGE_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(4 * 60 * 60 * 1000),

  /**
   * Fastify's `trustProxy`. **Development only**: it makes `request.ip`
   * controllable through `X-Forwarded-For`, which `scripts/e2e.ts` needs in
   * order to simulate a second workstation. In production, the portal sits
   * behind a controlled front end or behind nothing at all.
   */
  TRUST_PROXY: z
    .string()
    .default("")
    .transform((v) => v === "1" || v === "true"),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  /** Made absolute at load time, relative to the repository root. */
  volumesRoot: string;
  seccompProfile: string;
  databasePath: string;
  /** Absolute path of the GitHub App PEM; empty string if there is none. */
  githubAppPrivateKeyPath: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" ; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const data = parsed.data;
  if (data.NODE_ENV === "production") {
    // Same guard as heig-classroom: a development secret in production is a
    // deployment mistake, not a setting.
    for (const [key, marker] of [
      ["OIDC_CLIENT_SECRET", "not-for-production"],
      ["COOKIE_SECRET", "change-me"],
      ["EXAM_COOKIE_SECRET", "change-me"],
    ] as const) {
      if (data[key].includes(marker)) {
        throw new Error(`Invalid configuration: development ${key} forbidden in production`);
      }
    }
    if (data.TRUST_PROXY) {
      throw new Error("Invalid configuration: TRUST_PROXY is a development setting");
    }
    // Invariant 8: the deep guard is in `createSebVerifier`; this one makes
    // startup fail earlier and with a configuration message.
    if (data.SEB_VERIFIER === "simulated") {
      throw new Error("Invalid configuration: SEB_VERIFIER=simulated forbidden in production");
    }
    if (data.SEB_PUBLIC_ORIGIN === "") {
      throw new Error("Invalid configuration: SEB_PUBLIC_ORIGIN is required in production");
    }
    if (data.CODESPACE_LAUNCH_SECRET.includes("change-me")) {
      throw new Error(
        "Invalid configuration: development CODESPACE_LAUNCH_SECRET forbidden in production",
      );
    }
  }
  return {
    ...data,
    volumesRoot: fromRepoRoot(data.VOLUMES_ROOT),
    seccompProfile: fromRepoRoot(data.SECCOMP_PROFILE),
    databasePath: fromRepoRoot(data.DATABASE_PATH),
    githubAppPrivateKeyPath:
      data.GITHUB_APP_PRIVATE_KEY_PATH === ""
        ? ""
        : fromRepoRoot(data.GITHUB_APP_PRIVATE_KEY_PATH),
  };
}
