/**
 * Composition root of the portal (V1 of docs/jalon-0.md).
 *
 * Two listening surfaces, and that is deliberate (analyse.md § 4.1):
 *
 *  - the **portal** on `HOST:PORT` (127.0.0.1 in development): pages, OIDC,
 *    proxy to code-server, SEB routes;
 *  - the **Git channel** on `CODESPACE_GATEWAY:9418`, the address of the `cs0`
 *    bridge and nothing else, because that is the only surface a container must
 *    be able to reach. The nftables `input` rule is the second half of it.
 *
 * No dependency injection, no decorator: the modules receive what they need as
 * parameters, here.
 */
import { readFileSync } from "node:fs";

import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import { loadConfig, type AppConfig } from "./auth/config.js";
import { authPlugin } from "./auth/plugin.js";
import { classroomRoutes } from "./classroom/routes.js";
import { openDb, type Db, type DbHandle } from "./db/client.js";
import { createEngine, type Engine } from "./engine/index.js";
import {
  createForgejoForge,
  createGithubForge,
  createUnconfiguredGithubForge,
  createPushEventStore,
  createRelayWorker,
  stagingTargets,
  startGitServer,
  type Forge,
  type PushEventStore,
  type RelayWorker,
} from "./git/index.js";
import { SESSION_COOKIE, cookieValue, proxyPlugin } from "./proxy/index.js";
import { createSebVerifier, sebRoutes, sebStartPath, type AssignmentLookup } from "./seb/index.js";
import { createSessionManager, type SessionManager } from "./sessions/manager.js";
import { findAssignment, isOpen } from "./sessions/store.js";
import { sessionCookieOptions, webRoutes } from "./web/routes.js";

export { loadConfig, type AppConfig } from "./auth/config.js";
export { SESSION_COOKIE, cookieValue } from "./proxy/index.js";
export { sessionCookieOptions } from "./web/routes.js";

export interface Portal {
  app: FastifyInstance;
  gitApp: FastifyInstance | null;
  db: Db;
  engine: Engine;
  manager: SessionManager;
  store: PushEventStore;
  relay: RelayWorker | null;
  config: AppConfig;
  close(): Promise<void>;
}

/**
 * Destination forge of the relay **and** source of the authorization that seeds
 * the staging repository. `none` = everything stays in the staging repository.
 *
 * On the GitHub side, the private key is read **once**, at start-up: an
 * unreadable PEM file must show up in the start-up log, not at the first
 * session. The installation, for its part, is resolved per organisation on
 * demand (`createGithubForge`), because one portal serves several classes and
 * therefore several GitHub organisations.
 */
export function createForge(
  config: AppConfig,
  log?: { warn: (o: object, m: string) => void },
): Forge | null {
  if (config.FORGE_KIND === "none") return null;
  if (config.FORGE_KIND === "github") {
    const appId = config.GITHUB_APP_ID;
    const keyPath = config.githubAppPrivateKeyPath;
    // Without an App, the forge is still useful for what needs no token: the
    // clone URL of a **public** repository. The relay and the seeding of a
    // private repository, for their part, refuse explicitly and by name
    // (`createUnconfiguredGithubForge`). `baseUrl` is not passed, as for
    // `createGithubForge`: github.com.
    if (!appId || !keyPath) return createUnconfiguredGithubForge();
    let privateKey = "";
    try {
      privateKey = readFileSync(keyPath, "utf8");
    } catch (err) {
      log?.warn(
        { path: keyPath, err: String((err as Error).message ?? err) },
        "GitHub App private key unreadable: GitHub forge not configured",
      );
      return createUnconfiguredGithubForge();
    }
    return createGithubForge({ appId, privateKey });
  }
  if (!config.FORGE_TOKEN) return null;
  return createForgejoForge({ baseUrl: config.FORGE_URL, token: config.FORGE_TOKEN });
}

export interface BuildOptions {
  config?: AppConfig;
  /** Database already open (tests); otherwise `DATABASE_PATH`. */
  dbHandle?: DbHandle;
  /** Engine already built (tests); otherwise a real Podman client. */
  engine?: Engine;
  /** Bind the Git server to the gateway. True by default. */
  withGitServer?: boolean;
  /** Reconcile and start the timers. True by default. */
  withTimers?: boolean;
}

export async function buildPortal(options: BuildOptions = {}): Promise<Portal> {
  const config = options.config ?? loadConfig();
  const handle = options.dbHandle ?? openDb(config.databasePath);
  const db = handle.db;

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // Development only: makes `request.ip` controllable through
    // `X-Forwarded-For`, which `scripts/e2e.ts` needs in order to simulate a
    // second machine. `loadConfig` forbids it in production.
    trustProxy: config.TRUST_PROXY,
  });

  const engine =
    options.engine ??
    createEngine({
      podmanUrl: config.PODMAN_URL,
      network: config.CODESPACE_NETWORK,
      gateway: config.CODESPACE_GATEWAY,
      seccompProfile: config.seccompProfile,
      image: config.CODESPACE_IMAGE,
      memory: config.CODESPACE_MEMORY,
      cpus: config.CODESPACE_CPUS,
      pidsLimit: config.CODESPACE_PIDS_LIMIT,
      log: app.log,
    });

  const forge = createForge(config, app.log);
  const manager = createSessionManager({
    db,
    engine,
    volumesRoot: config.volumesRoot,
    graceMs: config.SESSION_GRACE_MS,
    gcIntervalMs: config.SESSION_GC_INTERVAL_MS,
    shadowIntervalMs: config.SHADOW_INTERVAL_MS,
    healthTimeoutMs: config.SESSION_HEALTH_TIMEOUT_MS,
    // `portal.internal` is the name `--add-host` gives to the gateway inside
    // the container; the remote written into the workspace uses it.
    gitRemoteHost: "portal.internal",
    gitRemotePort: config.CODESPACE_GIT_PORT,
    // Return origins of the status-bar extension's "Close" button
    // (images/c-dev/extension): classroom for a session that came from a launch
    // token, the portal otherwise.
    classroomUrl: config.CLASSROOM_URL,
    publicUrl: config.PUBLIC_URL,
    log: app.log,
    ...(forge
      ? {
          forgeUrlOf: (repo) => forge.pushUrl(repo),
          // A student's repository is private: the seeding of the staging
          // repository carries the same authorization as the relay, through the
          // environment.
          forgeAuthorization: (repo) => forge.authorization(repo),
        }
      : {}),
  });

  const store = createPushEventStore(db);
  const relay = forge
    ? createRelayWorker({
        store,
        forge,
        targets: stagingTargets(config.volumesRoot, (row) => manager.repoOfEvent(row)),
        log: app.log,
      })
    : null;

  await app.register(cookie, { secret: config.COOKIE_SECRET });
  await app.register(formbody);
  await app.register(authPlugin, { config, db });

  // --- exam side -----------------------------------------------------------
  const verifier = createSebVerifier({
    mode: config.SEB_VERIFIER,
    nodeEnv: config.NODE_ENV,
    url:
      config.SEB_PUBLIC_ORIGIN !== ""
        ? { publicOrigin: config.SEB_PUBLIC_ORIGIN }
        : { defaultProtocol: "http" as const },
  });
  const publicOrigin = config.SEB_PUBLIC_ORIGIN || config.PUBLIC_URL;
  const lookup: AssignmentLookup = {
    find(assignmentId) {
      const row = findAssignment(db, assignmentId);
      // Only an assignment in exam mode has a `.seb` and a start route.
      if (!row || row.mode !== "exam" || !row.sebConfig) return undefined;
      const seb = row.sebConfig;
      return {
        id: row.id,
        configKey: row.configKey ?? "",
        beks: row.beks,
        // An assignment synchronised from classroom carries its own
        // `startURL`: it is classroom that authenticates the student and then
        // redirects to `/launch`. The Config Key was computed on that URL, so
        // the `.seb` served here must reuse it as it is.
        startUrl: seb.startUrl ?? new URL(sebStartPath(row.id), publicOrigin).href,
        quitUrl: seb.quitUrl ?? new URL("/", publicOrigin).href,
        examKeySalt: seb.examKeySalt,
        ...(seb.extraAllowedHosts ? { extraAllowedHosts: seb.extraAllowedHosts } : {}),
      };
    },
  };

  /**
   * `seb/routes.ts` sets the `exam_session` cookie itself; the codespace session
   * cookie, for its part, belongs to this composition root. `onStart` drops it
   * here and the `onSend` hook below writes it — the `StartOutcome` signature
   * carries only the id and the redirection, and it is not the exam side's
   * business to know the format of the proxy's cookie.
   */
  const pendingSessionCookie = new WeakMap<FastifyRequest, { id: string; value: string }>();

  // Explicit guard on the `/exam/:id/start` route, which belongs to `seb/`:
  // the SEB verification proves the machine, not the person. The hook is
  // registered after `authPlugin`, so `request.user` is already resolved.
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/exam/") || !request.url.includes("/start")) return;
    if (request.user) return;
    return reply.redirect("/auth/login", 303);
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const pending = pendingSessionCookie.get(request);
    if (pending) {
      reply.setCookie(
        SESSION_COOKIE,
        pending.value,
        sessionCookieOptions(pending.id, config.NODE_ENV === "production"),
      );
    }
    return payload;
  });

  await app.register(sebRoutes, {
    lookup,
    verifier,
    cookieSecret: config.EXAM_COOKIE_SECRET,
    cookieSecure: config.NODE_ENV === "production",
    cookieMaxAgeMs: config.EXAM_COOKIE_MAX_AGE_MS,
    // The Start button and the exam route create the session in the same way;
    // only the provenance differs, and it has already been verified.
    async onStart(ctx) {
      const assignment = findAssignment(db, ctx.assignment.id);
      if (!assignment) throw new Error(`assignment ${ctx.assignment.id} not found`);
      if (!isOpen(assignment)) throw new Error(`assignment ${assignment.id} outside its window`);
      const user = ctx.request.user;
      if (!user) throw new Error("exam start without a portal session");
      const result = await manager.start(user, assignment, { sebVerified: true });
      pendingSessionCookie.set(ctx.request, {
        id: result.session.id,
        value: cookieValue(result.session.id, result.cookieToken),
      });
      ctx.request.log.info(
        { sessionId: result.session.id, healthyInMs: result.healthyInMs },
        "exam session started",
      );
      return { sessionId: result.session.id, redirectTo: `/s/${result.session.id}/` };
    },
  });

  // --- boundary with heig-classroom ---------------------------------------
  // Without a shared secret, the plugin is not registered: `/launch` and
  // `/api/assignments/*` answer 404 and the portal stays standalone.
  if (config.CODESPACE_LAUNCH_SECRET !== "") {
    await app.register(classroomRoutes, {
      config,
      db,
      manager,
      verifier,
      ...(forge ? { repoUrl: (repo) => forge.pushUrl(repo) } : {}),
    });
  } else {
    app.log.info(
      {},
      "CODESPACE_LAUNCH_SECRET missing: classroom integration disabled (standalone portal)",
    );
  }

  await app.register(webRoutes, { config, db, manager });
  await app.register(proxyPlugin, {
    db,
    manager,
    examCookieSecret: config.EXAM_COOKIE_SECRET,
    examCookieMaxAgeMs: config.EXAM_COOKIE_MAX_AGE_MS,
  });

  app.get("/healthz", async () => ({ ok: true }));

  // --- Git channel ---------------------------------------------------------
  let gitApp: FastifyInstance | null = null;
  if (options.withGitServer !== false) {
    const started = await startGitServer({
      sessions: manager.lookup,
      store,
      volumesRoot: config.volumesRoot,
      host: config.CODESPACE_GATEWAY,
      port: config.CODESPACE_GIT_PORT,
      ...(relay ? { relay } : {}),
    });
    gitApp = started.app;
    app.log.info(
      { host: started.host, port: started.port },
      "Git channel bound (analyse.md 4.1: the only surface reachable from a container)",
    );
  }

  if (options.withTimers !== false) {
    await manager.reconcile();
    manager.startTimers();
    relay?.start();
  }

  return {
    app,
    gitApp,
    db,
    engine,
    manager,
    store,
    relay,
    config,
    async close() {
      relay?.stop();
      await manager.stopTimers();
      if (gitApp) await gitApp.close();
      await app.close();
      if (!options.dbHandle) handle.close();
    },
  };
}

/** The bare portal, without database or engine: smoke test and start-up probe. */
export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });
  app.get("/healthz", async () => ({ ok: true }));
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const portal = await buildPortal();
  const shutdown = async (): Promise<void> => {
    await portal.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await portal.app.listen({ port: portal.config.PORT, host: portal.config.HOST });
}
