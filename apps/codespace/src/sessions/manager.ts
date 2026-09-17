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
import type { AssignmentRepoRef, AssignmentRow, SessionRow, UserRow } from "../db/schema.js";
import { sessions } from "../db/schema.js";
import {
  ForgeUnconfiguredError,
  ensureStagingRepo,
  redactSecrets,
  refSnapshot,
  stagingPaths,
  type RepoRef,
  type SessionLookup,
  type StagingResult,
  type StagingSession,
  type StagingSource,
} from "../git/index.js";

import { completionScript, ensureWorkspace, type EnsureWorkspaceResult } from "./workspace.js";
import { snapshot } from "./shadow.js";
import {
  findAnySession,
  findAssignment,
  findSession,
  listLiveSessions,
  targetRepoOfSession,
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

/**
 * Ce que l'appelant apporte en plus du couple (étudiant, devoir). Tout est
 * facultatif : le bouton Démarrer du portail autonome n'en pose aucun, le
 * jeton de lancement de classroom les pose tous.
 */
export interface StartOptions {
  /** La session est née d'une vérification SEB (invariant 5). */
  sebVerified?: boolean;
  /** Enseignant porteur du quota, recopié du devoir. */
  teacherId?: string | null;
  /** `jti` du jeton de lancement, pour la trace. */
  launchJti?: string | null;
  /** Dépôt de l'étudiant apporté par le jeton ; remplace la convention du devoir. */
  targetRepo?: AssignmentRepoRef | null;
}

export interface SessionManager {
  start(user: UserRow, assignment: AssignmentRow, opts?: StartOptions): Promise<StartResult>;
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
  /**
   * Pour `git/relay.ts` : où relayer les pushes d'un événement. La session
   * décide (elle porte le dépôt du jeton) ; le devoir n'est qu'un repli.
   */
  repoOfEvent(row: { sessionId?: string; student: string; assignment: string }): RepoRef | undefined;
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
  /**
   * En-tête `Authorization` de la forge pour le dépôt donné. Un dépôt
   * d'étudiant provisionné par classroom est **privé** : sans elle, le `git
   * fetch` d'amorçage est refusé et l'espace de travail s'ouvre vide. Lève
   * `ForgeUnconfiguredError` quand la forge n'a pas d'identifiants : on tente
   * alors le fetch en anonyme, ce qui suffit pour un dépôt public, et la cause
   * est conservée pour la page d'erreur si le fetch échoue.
   */
  forgeAuthorization?: (repo: RepoRef) => Promise<string>;
}

/**
 * L'espace de travail de la session n'a pas pu être préparé. **La session ne
 * démarre pas** : aucun conteneur n'est lancé et l'étudiant reçoit une page
 * qui nomme la cause. Ouvrir un éditeur sur un répertoire vide, comme le
 * portail le faisait jusqu'au 2026-09-17, est le pire des comportements — rien
 * ne signale que le dépôt manque et l'étudiant travaille à côté de son rendu.
 *
 * `shortCause` est la phrase montrée à l'étudiant ; `message` porte le détail
 * (déjà expurgé de tout jeton) pour le journal `warn`.
 */
export class WorkspaceBootstrapError extends Error {
  constructor(
    readonly shortCause: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceBootstrapError";
  }
}

/**
 * Branche par défaut du dépôt de l'étudiant, telle que classroom l'annonce
 * dans le jeton de lancement. Elle décide de deux choses : le `HEAD` du dépôt
 * de transit, donc ce que `git clone` sortirait, et la branche locale de
 * `work/` avec son suivi.
 *
 * Ce n'est **pas** `main` par convention. Mesuré en production : le dépôt
 * `heig-test-classroom2/labo-02-quadratic-yves-chevallier` est sur `master`,
 * et il porte aussi une branche `grading` écrite par la CI de classroom.
 * Sans cette valeur, `pickHead` ne trouvait pas `main` et retombait sur la
 * première branche venue — `grading`, c'est-à-dire le rapport de correction
 * plutôt que le travail.
 */
export function defaultBranchOf(
  session: Pick<SessionRow, "targetRepo">,
  assignment: Pick<AssignmentRow, "mode" | "sourceRepo">,
): string {
  // Invariant 6 : en mode examen la source est le modèle de l'enseignant, donc
  // sa branche à lui, pas celle du dépôt de l'étudiant.
  if (assignment.mode === "exam") return assignment.sourceRepo?.defaultBranch ?? "main";
  return session.targetRepo?.defaultBranch ?? assignment.sourceRepo?.defaultBranch ?? "main";
}

/** `https://github.com/org/depot.git` → `{ owner: "org", name: "depot" }`. */
export function repoRefFromUrl(url: string): RepoRef | undefined {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url);
  const owner = m?.[1];
  const name = m?.[2];
  return owner && name ? { owner, name } : undefined;
}

/** Ce que l'étudiant lit sur la page de refus. Court, et sans jargon de git. */
export function shortCauseOf(err: unknown, repo: RepoRef | undefined): string {
  const where = repo ? `${repo.owner}/${repo.name}` : "le dépôt source";
  if (err instanceof ForgeUnconfiguredError) {
    return `le portail n'a pas les accès à ${where}`;
  }
  const text = String((err as Error | undefined)?.message ?? err);
  if (/not found|n'existe pas|does not exist|\b404\b/i.test(text)) {
    return `dépôt ${where} introuvable`;
  }
  if (/authentication|denied|forbidden|unauthorized|\b401\b|\b403\b/i.test(text)) {
    return `accès refusé au dépôt ${where}`;
  }
  return `récupération de ${where} impossible`;
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

  /**
   * Amorce le dépôt de transit. **Échec bruyant** : plus de repli silencieux
   * sur un dépôt vide. Un miroir injoignable, un dépôt inexistant ou une forge
   * sans identifiants font refuser la session, avec une cause nommée.
   *
   * Deux nuances, toutes deux documentées dans `docs/deploy.md` § 5 :
   *
   *  - un **dépôt cible sans aucune branche** en mode travaux pratiques est
   *    légitime (classroom vient de le créer) : le `fetch` réussit, rapporte
   *    zéro référence, l'espace de travail s'ouvre vide et le journal le dit en
   *    `info`. En mode examen c'est au contraire une erreur : l'étudiant
   *    n'aurait pas l'énoncé ;
   *  - le miroir du mode travaux pratiques n'est récupéré **qu'au premier
   *    amorçage**, tant que le dépôt de transit n'a aucune référence. Le
   *    reprendre à chaque ouverture ramènerait les références de la forge par
   *    dessus celles que l'étudiant a poussées mais que le relais n'a pas
   *    encore transmises. En mode examen il l'est toujours : c'est ainsi qu'un
   *    correctif d'énoncé se propage (invariant 6).
   */
  async function seedStaging(
    session: SessionRow,
    assignment: AssignmentRow,
  ): Promise<StagingResult> {
    const paths = stagingPaths(opts.volumesRoot, session.student, assignment.id);
    const repo = targetRepoOfSession(session, assignment);
    const targetUrl = repo && opts.forgeUrlOf ? opts.forgeUrlOf(repo) : undefined;
    const wanted = stagingSourceFor(assignment, targetUrl);

    const already = await refSnapshot(paths.gitDir).catch(() => new Map<string, string>());
    const source: StagingSource =
      wanted.mode === "lab" && already.size > 0 ? { mode: "empty" } : wanted;
    const from =
      source.mode === "lab" ? source.mirrorFrom : source.mode === "exam" ? source.templateFrom : null;
    const sourceRepo = from ? repoRefFromUrl(from) : undefined;

    // La forge peut n'avoir aucun identifiant : on tente alors le fetch en
    // anonyme (un dépôt public marche), et on garde la cause sous le coude.
    let authorization: string | undefined;
    let authError: unknown;
    if (sourceRepo && opts.forgeAuthorization) {
      try {
        authorization = await opts.forgeAuthorization(sourceRepo);
      } catch (err) {
        authError = err;
      }
    }

    try {
      const result = await ensureStagingRepo({
        volumesRoot: opts.volumesRoot,
        student: session.student,
        assignment: assignment.id,
        source,
        uploadPack: assignment.uploadPack,
        defaultBranch: defaultBranchOf(session, assignment),
        ...(authorization ? { authorization } : {}),
      });
      if (result.refs === 0 && wanted.mode === "exam") {
        throw new WorkspaceBootstrapError(
          "le modèle de l'enseignant ne contient aucune branche",
          `modèle ${from ?? "?"} sans référence : l'épreuve n'a pas d'énoncé à distribuer`,
        );
      }
      if (result.refs === 0 && wanted.mode === "lab") {
        log.info(
          { sessionId: session.id, repo: sourceRepo ?? null },
          "dépôt cible sans aucune branche : espace de travail vide, c'est normal en travaux pratiques",
        );
      }
      return result;
    } catch (err) {
      if (err instanceof WorkspaceBootstrapError) {
        log.warn({ sessionId: session.id, err: err.message }, "amorçage du dépôt de transit refusé");
        throw err;
      }
      const detail = redactSecrets(String((err as Error).message ?? err));
      const cause = shortCauseOf(authError ?? err, sourceRepo ?? repo);
      log.warn(
        {
          sessionId: session.id,
          student: session.student,
          assignment: assignment.id,
          repo: sourceRepo ?? repo ?? null,
          mode: wanted.mode,
          forge: authError ? redactSecrets(String((authError as Error).message ?? authError)) : null,
          err: detail,
        },
        "amorçage du dépôt de transit impossible : la session ne démarre pas",
      );
      throw new WorkspaceBootstrapError(cause, detail);
    }
  }

  /**
   * Achève l'espace de travail **depuis le conteneur**, quand `:U` en a donné
   * la propriété à la plage d'UID de celui-ci et que le portail n'y écrit plus
   * (reprise d'une session dont le premier amorçage avait échoué).
   *
   * Aucun secret n'y entre : le `fetch` va sur `portal.internal:9418`, que
   * l'adresse IP source authentifie (invariant 1).
   *
   * Un échec est journalisé en `warn` mais **ne ferme pas la session** : si
   * l'étudiant a déjà écrit un fichier que le dépôt apporte, `checkout` refuse
   * — mieux vaut un espace de travail incomplet qu'un étudiant privé de ce
   * qu'il a écrit.
   */
  async function finishWorkspace(
    session: SessionRow,
    workspace: EnsureWorkspaceResult,
  ): Promise<void> {
    if (!workspace.needsContainer || !workspace.branch) return;
    const name = session.containerName ?? containerNameFor(session.id);
    try {
      const out = await engine.exec(name, ["sh", "-lc", completionScript(workspace.branch)]);
      log.info(
        { sessionId: session.id, branch: workspace.branch, head: out.trim().split("\n").pop() },
        "espace de travail complété dans le conteneur (reprise)",
      );
    } catch (err) {
      log.warn(
        {
          sessionId: session.id,
          branch: workspace.branch,
          err: redactSecrets(String((err as Error).message ?? err)),
        },
        "achèvement de l'espace de travail dans le conteneur impossible",
      );
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
    const workspace = await ensureWorkspace({
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
    // Reprise d'un volume dont `work/` appartient déjà au conteneur : c'est le
    // seul moment où l'achèvement est possible, le conteneur venant de naître.
    await finishWorkspace(updated, workspace);
    return { session: updated, healthyInMs };
  }

  /** Champs que le jeton de lancement apporte, posés à la création comme à la reprise. */
  function launchPatch(startOpts: StartOptions): Partial<SessionRow> {
    const patch: Partial<SessionRow> = {};
    if (startOpts.teacherId !== undefined) patch.teacherId = startOpts.teacherId;
    if (startOpts.launchJti !== undefined) patch.launchJti = startOpts.launchJti;
    if (startOpts.targetRepo !== undefined) patch.targetRepo = startOpts.targetRepo;
    return patch;
  }

  async function startInner(
    user: UserRow,
    assignment: AssignmentRow,
    startOpts: StartOptions,
  ): Promise<StartResult> {
    const sebVerified = startOpts.sebVerified ?? false;
    const patch = launchPatch(startOpts);
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
        // Le conteneur tourne déjà : on ne le relance pas (invariant 10). Mais
        // un dépôt de transit **sans aucune référence** est le symptôme d'un
        // amorçage manqué, et c'est exactement l'état laissé par le premier
        // essai réel du 2026-09-17. On le refait, et on complète l'espace de
        // travail dans le conteneur vivant. Rien ne peut être écrasé : par
        // construction, il n'y avait rien.
        const refs = await refSnapshot(paths.gitDir).catch(() => new Map<string, string>());
        if (refs.size === 0) {
          await seedStaging(existing, assignment);
          const workspace = await ensureWorkspace({
            paths,
            sessionId: existing.id,
            gitRemoteHost: opts.gitRemoteHost,
            gitRemotePort: opts.gitRemotePort,
            log: opts.log,
          });
          await finishWorkspace(existing, workspace);
        }
        const touched = updateSession(db, existing.id, { ...patch, lastSeen: new Date() });
        return {
          session: touched,
          launched: false,
          healthyInMs: null,
          cookieToken: existing.cookieToken,
        };
      }
      const revived = updateSession(db, existing.id, {
        ...patch,
        state: "starting",
        sebVerified: sebVerified || existing.sebVerified,
        lastSeen: new Date(),
      });
      try {
        await seedStaging(revived, assignment);
        const { session, healthyInMs } = await launch(revived, assignment);
        log.info({ sessionId: session.id, student: user.login }, "session reprise sur son volume");
        return { session, launched: true, healthyInMs, cookieToken: revived.cookieToken };
      } catch (err) {
        // La session reste reprenable : son volume est intact et rien n'a été
        // lancé. `stopped` la garde vivante au sens de D5, contrairement à
        // `failed` qui la sortirait du couple (étudiant, devoir).
        updateSession(db, existing.id, { state: "stopped", containerIp: null, containerId: null });
        throw err;
      }
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
        teacherId: startOpts.teacherId ?? assignment.teacherId,
        launchJti: startOpts.launchJti ?? null,
        targetRepo: startOpts.targetRepo ?? null,
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
        const result = await startInner(user, assignment, startOpts);
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
        const repo = targetRepoOfSession(session, assignment);
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
      // Le dépôt du jeton de lancement, quand la session en porte un ; la
      // convention du devoir sinon. La session est consultée par son
      // identifiant, pas par le couple, parce qu'elle survit à sa fermeture :
      // le relais doit rester juste après la destruction du conteneur.
      const session = row.sessionId ? findSession(db, row.sessionId) : undefined;
      if (session) return targetRepoOfSession(session, assignment);
      if (!assignment) return undefined;
      return targetRepoOfSession({ targetRepo: null, student: row.student }, assignment);
    },
  };

  return manager;
}
