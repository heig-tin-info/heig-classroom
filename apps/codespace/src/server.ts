/**
 * Racine de composition du portail (V1 de docs/jalon-0.md).
 *
 * Deux surfaces d'écoute, et c'est intentionnel (analyse.md § 4.1) :
 *
 *  - le **portail** sur `HOST:PORT` (127.0.0.1 en développement) : pages,
 *    OIDC, proxy vers code-server, routes SEB ;
 *  - le **canal Git** sur `CODESPACE_GATEWAY:9418`, l'adresse du pont `cs0`
 *    et rien d'autre, parce que c'est la seule surface qu'un conteneur doit
 *    pouvoir joindre. La règle nftables `input` en est la seconde moitié.
 *
 * Aucune injection de dépendances, aucun décorateur : les modules reçoivent
 * ce dont ils ont besoin en paramètre, ici.
 */
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import { loadConfig, type AppConfig } from "./auth/config.js";
import { authPlugin } from "./auth/plugin.js";
import { openDb, type Db, type DbHandle } from "./db/client.js";
import { createEngine, type Engine } from "./engine/index.js";
import {
  createForgejoForge,
  createGithubForge,
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

/** Forge de destination du relais. `none` = tout reste dans le dépôt de transit. */
export function createForge(config: AppConfig): Forge | null {
  if (config.FORGE_KIND === "none") return null;
  if (config.FORGE_KIND === "github") {
    const appId = process.env["GITHUB_APP_ID"] ?? "";
    const privateKey = process.env["GITHUB_APP_PRIVATE_KEY"] ?? "";
    const installationId = Number(process.env["GITHUB_APP_INSTALLATION_ID"] ?? "0");
    if (!appId || !privateKey || !installationId) return null;
    return createGithubForge({ appId, privateKey, installationId });
  }
  if (!config.FORGE_TOKEN) return null;
  return createForgejoForge({ baseUrl: config.FORGE_URL, token: config.FORGE_TOKEN });
}

export interface BuildOptions {
  config?: AppConfig;
  /** Base déjà ouverte (tests) ; sinon `DATABASE_PATH`. */
  dbHandle?: DbHandle;
  /** Moteur déjà construit (tests) ; sinon un vrai client Podman. */
  engine?: Engine;
  /** Lier le serveur Git à la passerelle. Vrai par défaut. */
  withGitServer?: boolean;
  /** Réconcilier et démarrer les temporisateurs. Vrai par défaut. */
  withTimers?: boolean;
}

export async function buildPortal(options: BuildOptions = {}): Promise<Portal> {
  const config = options.config ?? loadConfig();
  const handle = options.dbHandle ?? openDb(config.databasePath);
  const db = handle.db;

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // Développement seulement : rend `request.ip` contrôlable par
    // `X-Forwarded-For`, ce dont `scripts/e2e.ts` a besoin pour simuler un
    // second poste. `loadConfig` l'interdit en production.
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

  const forge = createForge(config);
  const manager = createSessionManager({
    db,
    engine,
    volumesRoot: config.volumesRoot,
    graceMs: config.SESSION_GRACE_MS,
    gcIntervalMs: config.SESSION_GC_INTERVAL_MS,
    shadowIntervalMs: config.SHADOW_INTERVAL_MS,
    healthTimeoutMs: config.SESSION_HEALTH_TIMEOUT_MS,
    // `portal.internal` est le nom que `--add-host` donne à la passerelle
    // dans le conteneur ; le remote écrit dans l'espace de travail l'utilise.
    gitRemoteHost: "portal.internal",
    gitRemotePort: config.CODESPACE_GIT_PORT,
    log: app.log,
    ...(forge ? { forgeUrlOf: (repo) => forge.pushUrl(repo) } : {}),
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

  // --- volet examen --------------------------------------------------------
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
      // Seul un devoir en mode examen a un `.seb` et une route de démarrage.
      if (!row || row.mode !== "exam" || !row.sebConfig) return undefined;
      const seb = row.sebConfig;
      return {
        id: row.id,
        configKey: row.configKey ?? "",
        beks: row.beks,
        startUrl: new URL(sebStartPath(row.id), publicOrigin).href,
        quitUrl: seb.quitUrl ?? new URL("/", publicOrigin).href,
        examKeySalt: seb.examKeySalt,
        ...(seb.extraAllowedHosts ? { extraAllowedHosts: seb.extraAllowedHosts } : {}),
      };
    },
  };

  /**
   * `seb/routes.ts` pose le cookie `exam_session` lui-même ; le cookie de
   * session de codespace, lui, appartient à cette racine de composition.
   * `onStart` le dépose ici et le crochet `onSend` ci-dessous l'écrit — la
   * signature `StartOutcome` ne porte que l'identifiant et la redirection, et
   * ce n'est pas au volet examen de connaître le format du cookie du proxy.
   */
  const pendingSessionCookie = new WeakMap<FastifyRequest, { id: string; value: string }>();

  // Garde explicite de la route `/exam/:id/start`, qui appartient à `seb/` :
  // la vérification SEB prouve le poste, pas la personne. Le crochet est
  // enregistré après `authPlugin`, donc `request.user` est déjà résolu.
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
    // Le bouton Démarrer et la route d'examen créent la session de la même
    // façon ; seule la provenance diffère, et elle a déjà été vérifiée.
    async onStart(ctx) {
      const assignment = findAssignment(db, ctx.assignment.id);
      if (!assignment) throw new Error(`devoir ${ctx.assignment.id} introuvable`);
      if (!isOpen(assignment)) throw new Error(`devoir ${assignment.id} hors fenêtre`);
      const user = ctx.request.user;
      if (!user) throw new Error("démarrage d'examen sans session de portail");
      const result = await manager.start(user, assignment, { sebVerified: true });
      pendingSessionCookie.set(ctx.request, {
        id: result.session.id,
        value: cookieValue(result.session.id, result.cookieToken),
      });
      ctx.request.log.info(
        { sessionId: result.session.id, healthyInMs: result.healthyInMs },
        "session d'examen démarrée",
      );
      return { sessionId: result.session.id, redirectTo: `/s/${result.session.id}/` };
    },
  });

  await app.register(webRoutes, { config, db, manager });
  await app.register(proxyPlugin, {
    db,
    manager,
    examCookieSecret: config.EXAM_COOKIE_SECRET,
    examCookieMaxAgeMs: config.EXAM_COOKIE_MAX_AGE_MS,
  });

  app.get("/healthz", async () => ({ ok: true }));

  // --- canal Git -----------------------------------------------------------
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
      "canal Git lié (analyse.md 4.1 : seule surface joignable depuis un conteneur)",
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

/** Le portail nu, sans base ni moteur : test de fumée et sonde de démarrage. */
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
