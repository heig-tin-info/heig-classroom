/**
 * Cycle de vie d'une session : création ou reprise, battement, ramasse-miettes,
 * réconciliation avec Podman, instantanés du dépôt fantôme.
 *
 * Invariants tenus ici :
 *  - une seule session vivante par couple (étudiant, devoir) — analyse.md D5 ;
 *  - le dépôt de transit d'un devoir en mode examen est amorcé depuis le
 *    modèle de l'enseignant, jamais depuis le dépôt de l'étudiant —
 *    invariant 6, appliqué en choisissant la `StagingSource` ;
 *  - le conteneur d'ancrage n'est jamais vu : le moteur ne rend que les
 *    conteneurs portant le label de session.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { eq } from "drizzle-orm";

import type { Engine } from "../engine/index.js";
import type { Db } from "../db/client.js";
import type { AssignmentRow, SessionRow, UserRow } from "../db/schema.js";
import { sessions } from "../db/schema.js";
import {
  ensureStagingRepo,
  stagingPaths,
  type RepoRef,
  type SessionLookup,
  type StagingSession,
  type StagingSource,
} from "../git/index.js";

import { ensureWorkspace } from "./workspace.js";
import { snapshot } from "./shadow.js";
import {
  findAnySession,
  findAssignment,
  findSession,
  listLiveSessions,
  targetRepoFor,
  updateSession,
} from "./store.js";

export interface ManagerOptions {
  db: Db;
  engine: Engine;
  volumesRoot: string;
  /** Grâce après le dernier battement avant destruction du conteneur. */
  graceMs: number;
  gcIntervalMs: number;
  shadowIntervalMs: number;
  healthTimeoutMs: number;
  /** Hôte du remote `origin` écrit dans l'espace de travail : `portal.internal`. */
  gitRemoteHost: string;
  gitRemotePort: number;
  log: {
    info: (o: object, m: string) => void;
    warn: (o: object, m: string) => void;
    error: (o: object, m: string) => void;
  };
}

export interface StartResult {
  session: SessionRow;
  /** Vrai si un conteneur a été lancé (session neuve ou reprise). */
  launched: boolean;
  /** Millisecondes entre le `podman run` et le `/healthz` du conteneur. */
  healthyInMs: number | null;
  /** Le jeton du cookie, rendu une fois : il n'a pas à ressortir ensuite. */
  cookieToken: string;
}

export interface SessionManager {
  start(
    user: UserRow,
    assignment: AssignmentRow,
    opts?: { sebVerified?: boolean },
  ): Promise<StartResult>;
  /** Relance le conteneur s'il a disparu ; sinon ne fait rien. */
  ensureRunning(sessionId: string): Promise<SessionRow>;
  close(sessionId: string, reason: string): Promise<void>;
  touch(sessionId: string, at?: Date): void;
  /** Vérifie le jeton de cookie d'une session, en temps constant. */
  checkCookie(session: SessionRow, token: string | undefined): boolean;
  reconcile(): Promise<{ resumed: number; stopped: number; orphans: number }>;
  collect(now?: Date): Promise<{ closed: number }>;
  snapshotAll(): Promise<{ committed: number; skipped: number }>;
  startTimers(): void;
  stopTimers(): Promise<void>;
  /** Pour `git/httpBackend.ts` : l'adresse du conteneur authentifie la session. */
  readonly lookup: SessionLookup;
  /** Pour `git/relay.ts` : où relayer les pushes d'un événement. */
  repoOfEvent(row: { student: string; assignment: string }): RepoRef | undefined;
}

/** Nom de conteneur déterministe : la réconciliation le retrouve seule. */
export function containerNameFor(sessionId: string): string {
  return `cs-${sessionId}`;
}

/**
 * Invariant 6. Le mode du devoir décide seul de la source, et le mode examen
 * n'a qu'une branche possible.
 */
export function stagingSourceFor(
  assignment: AssignmentRow,
  targetRepoUrl: string | undefined,
): StagingSource {
  if (assignment.mode === "exam") {
    if (!assignment.templateRepo) {
      throw new Error(
        `devoir ${assignment.id} en mode examen sans dépôt modèle : refus d'amorcer autrement`,
      );
    }
    return { mode: "exam", templateFrom: assignment.templateRepo };
  }
  const from = targetRepoUrl ?? assignment.templateRepo;
  return from ? { mode: "lab", mirrorFrom: from } : { mode: "empty" };
}

export interface ManagerDeps extends ManagerOptions {
  /** URL de clonage du dépôt cible d'un étudiant, pour le miroir en mode TP. */
  forgeUrlOf?: (repo: RepoRef) => string;
}

export function createSessionManager(opts: ManagerDeps): SessionManager {
  const { db, engine, log } = opts;
  let gcTimer: NodeJS.Timeout | null = null;
  let shadowTimer: NodeJS.Timeout | null = null;
  /** Une session à la fois : deux `start` concurrents ne lancent qu'un conteneur. */
  const inFlight = new Map<string, Promise<SessionRow>>();

  function assignmentOf(session: SessionRow): AssignmentRow {
    const row = findAssignment(db, session.assignmentId);
    if (!row) throw new Error(`devoir ${session.assignmentId} introuvable`);
    return row;
  }

  async function seedStaging(session: SessionRow, assignment: AssignmentRow): Promise<void> {
    const repo = targetRepoFor(assignment, session.student);
    const targetUrl = repo && opts.forgeUrlOf ? opts.forgeUrlOf(repo) : undefined;
    const source = stagingSourceFor(assignment, targetUrl);
    try {
      await ensureStagingRepo({
        volumesRoot: opts.volumesRoot,
        student: session.student,
        assignment: assignment.id,
        source,
        uploadPack: assignment.uploadPack,
      });
    } catch (err) {
      // Un miroir injoignable (forge éteinte) ne doit pas empêcher la session :
      // le dépôt de transit existe alors, simplement vide ou tel qu'il était.
      if (source.mode === "exam") throw err;
      log.warn(
        { sessionId: session.id, err: String((err as Error).message ?? err) },
        "amorçage du dépôt de transit incomplet, la session continue",
      );
      await ensureStagingRepo({
        volumesRoot: opts.volumesRoot,
        student: session.student,
        assignment: assignment.id,
        source: { mode: "empty" },
        uploadPack: assignment.uploadPack,
      });
    }
  }

  /** Lance le conteneur et attend son `/healthz`. */
  async function launch(
    session: SessionRow,
    assignment: AssignmentRow,
  ): Promise<{ session: SessionRow; healthyInMs: number }> {
    const paths = stagingPaths(opts.volumesRoot, session.student, assignment.id);
    // **Avant** le `podman run` : après lui, `:U` a donné `work/` à la plage
    // d'UID du conteneur et le portail n'y écrit plus (voir workspace.ts).
    await ensureWorkspace({
      paths,
      sessionId: session.id,
      gitRemoteHost: opts.gitRemoteHost,
      gitRemotePort: opts.gitRemotePort,
      log: opts.log,
    });
    const name = containerNameFor(session.id);
    const info = await engine.run({
      sessionId: session.id,
      name,
      workDir: paths.workDir,
      ...(assignment.image ? { image: assignment.image } : {}),
    });
    if (!info.ip) {
      await engine.rm(name);
      updateSession(db, session.id, { state: "failed" });
      throw new Error(`conteneur ${name} sans adresse sur le réseau codespace`);
    }
    const healthyInMs = await engine.waitHealthy(info.ip, opts.healthTimeoutMs);
    const updated = updateSession(db, session.id, {
      containerId: info.id,
      containerName: info.name,
      containerIp: info.ip,
      state: "running",
      lastSeen: new Date(),
    });
    return { session: updated, healthyInMs };
  }

  async function startInner(
    user: UserRow,
    assignment: AssignmentRow,
    sebVerified: boolean,
  ): Promise<StartResult> {
    // Une ligne par couple (étudiant, devoir), quel que soit son état : c'est
    // ce qui rend l'identifiant de session **stable pour la vie du volume**,
    // donc le remote `origin` écrit dans `work/` valable après une fermeture
    // et une réouverture. Le portail ne pourrait pas le réécrire : après le
    // premier `:U`, `work/.git/config` ne lui appartient plus.
    const existing = findAnySession(db, user.login, assignment.id);
    const paths = stagingPaths(opts.volumesRoot, user.login, assignment.id);

    if (existing) {
      // D5 : toute nouvelle ouverture revient sur la session vivante.
      const alive =
        existing.state === "running" &&
        existing.containerName !== null &&
        (await engine.inspect(existing.containerName))?.state === "running";
      if (alive) {
        const touched = updateSession(db, existing.id, { lastSeen: new Date() });
        return {
          session: touched,
          launched: false,
          healthyInMs: null,
          cookieToken: existing.cookieToken,
        };
      }
      const revived = updateSession(db, existing.id, {
        state: "starting",
        sebVerified: sebVerified || existing.sebVerified,
        lastSeen: new Date(),
      });
      await seedStaging(revived, assignment);
      const { session, healthyInMs } = await launch(revived, assignment);
      log.info({ sessionId: session.id, student: user.login }, "session reprise sur son volume");
      return { session, launched: true, healthyInMs, cookieToken: revived.cookieToken };
    }

    const id = randomUUID();
    const cookieToken = randomBytes(32).toString("base64url");
    const now = new Date();
    const [created] = db
      .insert(sessions)
      .values({
        id,
        userId: user.id,
        student: user.login,
        assignmentId: assignment.id,
        volumeDir: paths.dir,
        state: "starting",
        createdAt: now,
        lastSeen: now,
        cookieToken,
        sebVerified,
      })
      .returning()
      .all();
    if (!created) throw new Error("création de session sans ligne");
    try {
      await seedStaging(created, assignment);
      const { session, healthyInMs } = await launch(created, assignment);
      log.info({ sessionId: session.id, student: user.login }, "session créée");
      return { session, launched: true, healthyInMs, cookieToken };
    } catch (err) {
      updateSession(db, id, { state: "failed" });
      throw err;
    }
  }

  const manager: SessionManager = {
    async start(user, assignment, startOpts = {}) {
      const key = `${user.login} ${assignment.id}`;
      const pending = inFlight.get(key);
      if (pending) {
        const session = await pending;
        return {
          session,
          launched: false,
          healthyInMs: null,
          cookieToken: session.cookieToken,
        };
      }
      let resolve!: (s: SessionRow) => void;
      let reject!: (e: unknown) => void;
      const shared = new Promise<SessionRow>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // Sans ce `catch`, un échec de démarrage sans second appelant devient
      // un rejet non traité et tue le processus.
      shared.catch(() => undefined);
      inFlight.set(key, shared);
      try {
        const result = await startInner(user, assignment, startOpts.sebVerified ?? false);
        resolve(result.session);
        return result;
      } catch (err) {
        reject(err);
        throw err;
      } finally {
        inFlight.delete(key);
      }
    },

    async ensureRunning(sessionId) {
      const session = findSession(db, sessionId);
      if (!session) throw new Error(`session ${sessionId} inconnue`);
      if (session.state === "closed" || session.state === "failed") {
        throw new Error(`session ${sessionId} fermée`);
      }
      const name = session.containerName ?? containerNameFor(session.id);
      const info = await engine.inspect(name);
      if (info?.state === "running" && info.ip) {
        if (info.ip !== session.containerIp || session.state !== "running") {
          return updateSession(db, session.id, {
            state: "running",
            containerIp: info.ip,
            containerId: info.id,
            containerName: info.name,
          });
        }
        return session;
      }
      // Conteneur mort, session vivante : on relance sur le même volume.
      log.warn({ sessionId }, "conteneur absent pour une session vivante, relance");
      const assignment = assignmentOf(session);
      await seedStaging(session, assignment);
      const { session: relaunched } = await launch(session, assignment);
      return relaunched;
    },

    async close(sessionId, reason) {
      const session = findSession(db, sessionId);
      if (!session) return;
      // Dernier instantané avant de perdre le conteneur : sans lui, une
      // session fermée juste après une frappe n'aurait rien dans shadow.git.
      await snapshot(session.volumeDir).catch((err: unknown) => {
        log.warn(
          { sessionId, err: String((err as Error).message ?? err) },
          "instantané de fermeture impossible",
        );
        return null;
      });
      const name = session.containerName ?? containerNameFor(session.id);
      await engine.stop(name);
      await engine.rm(name);
      updateSession(db, sessionId, {
        state: "closed",
        containerIp: null,
        containerId: null,
      });
      log.info({ sessionId, reason }, "session fermée, volume conservé");
    },

    touch(sessionId, at = new Date()) {
      db.update(sessions).set({ lastSeen: at }).where(eq(sessions.id, sessionId)).run();
    },

    checkCookie(session, token) {
      if (!token) return false;
      const a = Buffer.from(session.cookieToken, "utf8");
      const b = Buffer.from(token, "utf8");
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    },

    async reconcile() {
      const containers = await engine.listSessions();
      const bySession = new Map(containers.map((c) => [c.sessionId ?? "", c]));
      const live = listLiveSessions(db);
      let resumed = 0;
      let stopped = 0;
      let orphans = 0;

      for (const session of live) {
        const container = bySession.get(session.id);
        if (container && container.state === "running" && container.ip) {
          updateSession(db, session.id, {
            state: "running",
            containerId: container.id,
            containerName: container.name,
            containerIp: container.ip,
          });
          resumed += 1;
          continue;
        }
        if (container) await engine.rm(container.name || container.id);
        // Volume conservé : la session est reprise au prochain accès.
        updateSession(db, session.id, { state: "stopped", containerIp: null, containerId: null });
        stopped += 1;
      }

      const liveIds = new Set(live.map((s) => s.id));
      for (const container of containers) {
        if (container.sessionId && liveIds.has(container.sessionId)) continue;
        await engine.rm(container.name || container.id);
        orphans += 1;
      }
      log.info({ resumed, stopped, orphans }, "réconciliation Podman ↔ base");
      return { resumed, stopped, orphans };
    },

    async collect(now = new Date()) {
      const deadline = now.getTime() - opts.graceMs;
      let closed = 0;
      for (const session of listLiveSessions(db)) {
        if (session.lastSeen.getTime() > deadline) continue;
        await manager.close(session.id, "grâce écoulée");
        closed += 1;
      }
      return { closed };
    },

    async snapshotAll() {
      let committed = 0;
      let skipped = 0;
      for (const session of listLiveSessions(db)) {
        try {
          const result = await snapshot(session.volumeDir);
          if (result.sha) committed += 1;
          else skipped += 1;
          if (result.unreadable.length > 0) {
            log.warn(
              { sessionId: session.id, unreadable: result.unreadable },
              "instantané partiel : chemins illisibles par le portail (voir sessions/shadow.ts)",
            );
          }
        } catch (err) {
          skipped += 1;
          log.warn(
            { sessionId: session.id, err: String((err as Error).message ?? err) },
            "instantané impossible",
          );
        }
      }
      return { committed, skipped };
    },

    startTimers() {
      if (!gcTimer) {
        gcTimer = setInterval(() => {
          void manager
            .collect()
            .catch((err: unknown) => log.error({ err }, "ramasse-miettes en échec"));
        }, opts.gcIntervalMs);
        gcTimer.unref();
      }
      if (!shadowTimer) {
        shadowTimer = setInterval(() => {
          void manager
            .snapshotAll()
            .catch((err: unknown) => log.error({ err }, "instantanés en échec"));
        }, opts.shadowIntervalMs);
        shadowTimer.unref();
      }
    },

    async stopTimers() {
      if (gcTimer) clearInterval(gcTimer);
      if (shadowTimer) clearInterval(shadowTimer);
      gcTimer = null;
      shadowTimer = null;
    },

    lookup: {
      async bySessionId(sessionId: string): Promise<StagingSession | undefined> {
        const session = findSession(db, sessionId);
        if (!session || session.containerIp === null) return undefined;
        if (session.state !== "running" && session.state !== "starting") return undefined;
        const assignment = findAssignment(db, session.assignmentId);
        if (!assignment) return undefined;
        const repo = targetRepoFor(assignment, session.student);
        return {
          sessionId: session.id,
          student: session.student,
          assignment: session.assignmentId,
          containerIp: session.containerIp,
          uploadPack: assignment.uploadPack,
          ...(repo ? { targetRepo: repo } : {}),
        };
      },
    },

    repoOfEvent(row) {
      const assignment = findAssignment(db, row.assignment);
      if (!assignment) return undefined;
      return targetRepoFor(assignment, row.student);
    },
  };

  return manager;
}
