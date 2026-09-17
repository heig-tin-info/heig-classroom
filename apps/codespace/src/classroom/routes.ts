/**
 * Frontière HTTP avec heig-classroom (`packages/contracts/src/codespace.ts`).
 *
 * Trois routes, et rien d'autre ne les connaît :
 *
 *   PUT  /api/assignments/:id            classroom pousse un devoir (jeton de service)
 *   GET  /api/assignments/:id/sessions   tableau enseignant de classroom (jeton de service)
 *   GET  /launch?token=…                 l'étudiant arrive, jeton de lancement
 *
 * Le greffon **n'est pas enregistré** quand `CODESPACE_LAUNCH_SECRET` est
 * vide : les trois routes répondent alors 404 et le portail reste utilisable
 * en autonome avec sa propre connexion OIDC (invariant 4 inchangé).
 *
 * Deux invariants se jouent ici et nulle part ailleurs :
 *
 *  - **Invariant 5.** En mode examen, `/launch` est une navigation de premier
 *    niveau venue de Safe Exam Browser : c'est ici, une seule fois, que le
 *    `SebVerifier` regarde les en-têtes SEB. Le proxy n'en verra jamais un.
 *  - **Usage unique.** Le `jti` du jeton est consommé par un `INSERT` dont la
 *    clé primaire est la garantie ; un rejeu ne peut pas courir à côté d'un
 *    premier appel, SQLite refuse la seconde ligne.
 *
 * Rien de ce qui est journalisé ne porte le jeton, sa signature ni un BEK.
 */
import { randomUUID } from "node:crypto";

import { verifyHs256 } from "@hgc/domain";
import type { CodespaceSessionSummary } from "@hgc/contracts";
import { eq, lt } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import type { AppConfig } from "../auth/config.js";
import type { Db } from "../db/client.js";
import {
  assignments,
  launchTokensUsed,
  users,
  type AssignmentRow,
  type AssignmentSebConfig,
  type UserRow,
} from "../db/schema.js";
import type { RepoRef } from "../git/index.js";
import { SESSION_COOKIE, cookieValue } from "../proxy/index.js";
import {
  EXAM_COOKIE,
  examCookieAttributes,
  issueExamCookie,
  newExamKeySalt,
  outsideSebPage,
  renderSebFile,
  sebLink,
  type SebVerifier,
} from "../seb/index.js";
import type { SessionManager } from "../sessions/manager.js";
import {
  assignmentSessionRows,
  countLiveSessionsForTeacher,
  findAssignment,
  findLiveSession,
  isOpen,
  splitRepoRef,
} from "../sessions/store.js";
import { errorPage } from "../web/pages.js";
import { sessionCookieOptions } from "../web/routes.js";

import {
  AssignmentSyncSchema,
  LaunchClaimsSchema,
  isSafeId,
  type AssignmentSyncBody,
  type LaunchClaims,
} from "./schemas.js";

/** Audiences et émetteurs du contrat : jamais une constante de circonstance. */
export const LAUNCH_AUDIENCE = "heig-codespace";
export const SERVICE_AUDIENCE = "heig-codespace-api";
export const CLASSROOM_ISSUER = "heig-classroom";

/** Préfixe du sujet OIDC d'un compte venu de classroom (voir `upsertLaunchUser`). */
export const CLASSROOM_SUB_PREFIX = "classroom:";

export interface ClassroomRoutesOptions {
  config: AppConfig;
  db: Db;
  manager: SessionManager;
  /** Le même vérificateur que la route `/exam/:id/start` : réel ou simulé. */
  verifier: SebVerifier;
  /**
   * URL de clonage d'un dépôt de la forge. Absente quand `FORGE_KIND=none` :
   * un devoir en mode examen n'a alors pas de modèle à cloner et son premier
   * démarrage échoue, ce qui est le comportement voulu (invariant 6).
   */
  repoUrl?: (repo: RepoRef) => string;
}

// --- utilitaires ------------------------------------------------------------

function html(reply: FastifyReply, code: number, page: string): FastifyReply {
  return reply.code(code).type("text/html; charset=utf-8").send(page);
}

/** `startURL` du `.seb` : la page de classroom, pas celle du portail. */
export function classroomStartUrl(classroomUrl: string, assignmentId: string): string {
  return new URL(`/app/codespace/start/${encodeURIComponent(assignmentId)}`, classroomUrl).href;
}

/**
 * Hôtes que le filtre d'URL de SEB doit laisser passer **en plus** de celui de
 * la `startURL` (classroom, ajouté par `buildSebConfig`) : le portail, qui
 * sert l'éditeur, et ceux de `SEB_EXTRA_ALLOWED_HOSTS` — le fournisseur
 * d'identité au premier chef, sans quoi la page de connexion est bloquée
 * (docs/pistes.md, « Correction au cadrage relevée par le test SEB »).
 */
export function sebAllowedHosts(config: AppConfig): string[] {
  const portalOrigin = config.SEB_PUBLIC_ORIGIN || config.PUBLIC_URL;
  const hosts = [new URL(portalOrigin).host, ...config.SEB_EXTRA_ALLOWED_HOSTS];
  return [...new Set(hosts.filter((h) => h !== ""))];
}

/**
 * Utilisateur venu de classroom.
 *
 * `oidcSub` est le sujet du jeton **préfixé** : un sujet de classroom et un
 * sujet Keycloak vivent dans le même espace de noms, et rien ne garantit
 * qu'ils ne se croisent pas. `login`, lui, est le sujet nu — c'est
 * l'identifiant institutionnel au sens de la table, celui qui nomme le
 * répertoire de volume, d'où le `SAFE_ID` vérifié en amont par le schéma.
 *
 * Coexistence avec les comptes OIDC autonomes : ce sont deux lignes
 * distinctes tant que le sujet de classroom ne vaut pas le
 * `preferred_username` du realm. Voir docs/integration-classroom.md.
 */
export function upsertLaunchUser(db: Db, claims: LaunchClaims): UserRow {
  const now = new Date();
  const oidcSub = `${CLASSROOM_SUB_PREFIX}${claims.sub}`;
  const existing =
    db.select().from(users).where(eq(users.oidcSub, oidcSub)).get() ??
    db.select().from(users).where(eq(users.login, claims.sub)).get();
  const fields = {
    oidcSub,
    login: claims.sub,
    email: claims.email,
    displayName: claims.displayName,
    githubLogin: claims.githubLogin,
    lastLoginAt: now,
  };
  if (existing) {
    // Le rôle n'est **pas** touché : il vient du realm à la connexion OIDC
    // (docs/v1.md D-V1-3) et un jeton de lancement ne doit pas pouvoir le
    // changer. Un compte créé par ce chemin est étudiant.
    const [row] = db.update(users).set(fields).where(eq(users.id, existing.id)).returning().all();
    if (!row) throw new Error("mise à jour de l'utilisateur sans ligne");
    return row;
  }
  const [row] = db
    .insert(users)
    .values({ id: randomUUID(), role: "student", createdAt: now, ...fields })
    .returning()
    .all();
  if (!row) throw new Error("création de l'utilisateur sans ligne");
  return row;
}

/**
 * Consomme un `jti`. Rend faux s'il avait déjà été consommé : la clé primaire
 * de `launch_tokens_used` est la garantie, pas une lecture suivie d'une
 * écriture. Les lignes expirées sont purgées au passage — au-delà de `exp`,
 * `verifyHs256` refuse déjà le jeton, la ligne n'empêche plus rien.
 */
export function consumeJti(db: Db, jti: string, expSeconds: number, now = new Date()): boolean {
  db.delete(launchTokensUsed).where(lt(launchTokensUsed.exp, now)).run();
  try {
    db.insert(launchTokensUsed)
      .values({ jti, exp: new Date(expSeconds * 1000), usedAt: now })
      .run();
    return true;
  } catch {
    return false;
  }
}

// --- le greffon -------------------------------------------------------------

async function classroomRoutesImpl(
  app: FastifyInstance,
  opts: ClassroomRoutesOptions,
): Promise<void> {
  const { config, db, manager } = opts;
  const secret = config.CODESPACE_LAUNCH_SECRET;
  const secure = config.NODE_ENV === "production";
  const portalOrigin = config.SEB_PUBLIC_ORIGIN || config.PUBLIC_URL;

  /** Jeton de service : `Authorization: Bearer <jwt>`, aud `heig-codespace-api`. */
  async function serviceToken(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (token === "") {
      await reply.code(401).send({ error: "unauthenticated" });
      return false;
    }
    const verdict = await verifyHs256(token, secret, {
      audience: SERVICE_AUDIENCE,
      issuer: CLASSROOM_ISSUER,
    });
    if (!verdict.ok) {
      request.log.warn({ reason: verdict.reason }, "jeton de service refusé");
      await reply.code(401).send({ error: "unauthenticated" });
      return false;
    }
    return true;
  }

  // --- PUT /api/assignments/:id --------------------------------------------
  app.put<{ Params: { assignmentId: string } }>(
    "/api/assignments/:assignmentId",
    async (request, reply) => {
      if (!(await serviceToken(request, reply))) return reply;

      const parsed = AssignmentSyncSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        });
      }
      const body: AssignmentSyncBody = parsed.data;
      if (body.id !== request.params.assignmentId) {
        return reply.code(400).send({ error: "id_mismatch" });
      }

      const mode = body.mode === "online_seb" ? ("exam" as const) : ("lab" as const);
      if (mode === "exam" && body.browserExamKeys.length === 0) {
        // Même refus que la graine : un devoir d'examen sans BEK accepterait
        // n'importe quel navigateur dès que le vérificateur passe en `real`.
        return reply.code(400).send({ error: "missing_browser_exam_keys" });
      }

      const previous = findAssignment(db, body.id);
      const sourceRef = splitRepoRef(body.sourceRepo.fullName);
      if (!sourceRef) return reply.code(400).send({ error: "invalid_source_repo" });

      let configKey: string | null = null;
      let sebConfig: AssignmentSebConfig | null = null;
      if (mode === "exam") {
        // Le sel n'est **jamais** régénéré : il entre dans le Browser Exam
        // Key que SEB calcule, donc le changer invaliderait les `.seb` déjà
        // distribués. C'est aussi ce qui rend ce PUT idempotent.
        const examKeySalt = previous?.sebConfig?.examKeySalt ?? newExamKeySalt();
        const startUrl = classroomStartUrl(config.CLASSROOM_URL, body.id);
        const quitUrl = new URL("/", config.CLASSROOM_URL).href;
        const extraAllowedHosts = sebAllowedHosts(config);
        const file = renderSebFile({ startUrl, quitUrl, examKeySalt, extraAllowedHosts });
        configKey = file.configKey;
        sebConfig = { examKeySalt, startUrl, quitUrl, extraAllowedHosts };
      }

      const row = {
        id: body.id,
        title: body.name,
        mode,
        image: body.image ?? config.CODESPACE_DEFAULT_IMAGE,
        uploadPack: true,
        // Invariant 6 : l'URL de clonage du modèle de l'enseignant, et rien
        // d'autre, amorce un dépôt de transit d'examen.
        templateRepo: opts.repoUrl ? opts.repoUrl(sourceRef) : null,
        // Le dépôt cible n'est plus un attribut du devoir : il arrive par le
        // jeton de lancement, étudiant par étudiant (`sessions.targetRepo`).
        targetRepo: null,
        targetRepoPattern: null,
        teacherId: body.teacher.id,
        teacherEmail: body.teacher.email,
        maxActiveSessions: body.quota.maxActiveSessions,
        classroomId: body.classroomId,
        classroomName: body.classroomName,
        sourceRepo: body.sourceRepo,
        opensAt: new Date(body.startAt),
        closesAt: body.deadlineAt ? new Date(body.deadlineAt) : null,
        configKey,
        beks: body.browserExamKeys,
        sebConfig,
        createdAt: previous?.createdAt ?? new Date(),
      };
      const { createdAt: _keep, ...updatable } = row;
      db.insert(assignments)
        .values(row)
        .onConflictDoUpdate({ target: assignments.id, set: updatable })
        .run();

      request.log.info(
        { assignmentId: body.id, mode, classroomId: body.classroomId },
        previous ? "devoir mis à jour depuis classroom" : "devoir synchronisé depuis classroom",
      );
      return reply.code(200).send({
        id: body.id,
        configKey,
        sebLink: mode === "exam" ? sebLink(portalOrigin, body.id) : null,
      });
    },
  );

  // --- GET /api/assignments/:id/sessions -----------------------------------
  app.get<{ Params: { assignmentId: string } }>(
    "/api/assignments/:assignmentId/sessions",
    async (request, reply) => {
      if (!(await serviceToken(request, reply))) return reply;
      const assignment = findAssignment(db, request.params.assignmentId);
      if (!assignment) return reply.code(404).send({ error: "unknown_assignment" });
      const summaries: CodespaceSessionSummary[] = assignmentSessionRows(
        db,
        assignment.id,
      ).map(({ session, user, lastPushAt }) => ({
        sessionId: session.id,
        // Identifiant **de classroom** quand le compte vient de là : c'est lui
        // que l'appelant sait rapprocher de ses propres utilisateurs.
        userId: user.oidcSub.startsWith(CLASSROOM_SUB_PREFIX)
          ? user.oidcSub.slice(CLASSROOM_SUB_PREFIX.length)
          : user.id,
        email: user.email,
        state: session.state,
        createdAt: session.createdAt.toISOString(),
        lastSeenAt: session.lastSeen.toISOString(),
        lastPushAt: lastPushAt ? lastPushAt.toISOString() : null,
      }));
      return reply.code(200).send(summaries);
    },
  );

  // --- GET /launch?token=… -------------------------------------------------
  app.get<{ Querystring: { token?: string } }>("/launch", async (request, reply) => {
    const refuse = (detail: string, reason: string, code = 403): FastifyReply => {
      request.log.warn({ launch: { reason, clientAddress: request.ip } }, "lancement refusé");
      return html(reply, code, errorPage("Lancement refusé", detail));
    };

    const token = request.query.token ?? "";
    if (token === "") return refuse("Aucun jeton de lancement.", "missing-token");

    const verdict = await verifyHs256<Record<string, unknown>>(token, secret, {
      audience: LAUNCH_AUDIENCE,
      issuer: CLASSROOM_ISSUER,
    });
    if (!verdict.ok) {
      return refuse(
        verdict.reason === "expired"
          ? "Ce lien de lancement a expiré. Retournez sur classroom et cliquez de nouveau sur Démarrer."
          : "Ce lien de lancement n'est pas valide. Retournez sur classroom et cliquez de nouveau sur Démarrer.",
        verdict.reason,
      );
    }
    const claimed = LaunchClaimsSchema.safeParse(verdict.claims);
    if (!claimed.success) return refuse("Ce lien de lancement est incomplet.", "bad-claims");
    const claims: LaunchClaims = claimed.data;

    // Usage unique, avant tout effet de bord : un rejeu s'arrête ici.
    if (!consumeJti(db, claims.jti, claims.exp)) {
      return refuse(
        "Ce lien de lancement a déjà servi. Retournez sur classroom et cliquez de nouveau sur Démarrer.",
        "jti-replayed",
      );
    }

    const assignment: AssignmentRow | undefined = findAssignment(db, claims.assignmentId);
    if (!assignment) {
      return refuse(
        "Devoir non synchronisé depuis classroom. Prévenez votre enseignant : le devoir doit être enregistré dans classroom avant d'être lancé.",
        "unknown-assignment",
      );
    }
    if (!isOpen(assignment)) {
      return refuse("La fenêtre d'ouverture de ce devoir est close.", "assignment-closed");
    }
    if (!claims.repo) {
      return refuse(
        "Votre dépôt n'est pas encore prêt pour ce devoir. Réessayez dans quelques instants.",
        "repo-missing",
      );
    }

    if (!isSafeId(assignment.id)) {
      return refuse(
        "Ce devoir porte un identifiant inutilisable par le portail.",
        "bad-assignment-id",
      );
    }
    const user = upsertLaunchUser(db, claims);

    // --- quota par enseignant ---------------------------------------------
    // La reprise d'une session déjà vivante sur ce devoir ne consomme rien :
    // elle n'ouvre pas de conteneur supplémentaire (analyse.md D5).
    const resuming = findLiveSession(db, user.login, assignment.id) !== undefined;
    if (!resuming && assignment.teacherId && assignment.maxActiveSessions !== null) {
      const active = countLiveSessionsForTeacher(db, assignment.teacherId);
      if (active >= assignment.maxActiveSessions) {
        request.log.warn(
          {
            launch: {
              reason: "quota-reached",
              teacherId: assignment.teacherId,
              active,
              max: assignment.maxActiveSessions,
              assignmentId: assignment.id,
            },
          },
          "lancement refusé : quota de sessions de l'enseignant atteint",
        );
        return html(
          reply,
          429,
          errorPage(
            "Quota atteint",
            "Toutes les places d'environnement de votre enseignant sont occupées. Réessayez plus tard.",
          ),
        );
      }
    }

    // --- mode examen : la vérification SEB, ici et une seule fois ----------
    // TODO(verify) SEB 3.x / 2.2.3 : la `startURL` est sur classroom et SEB
    // arrive ici après une redirection **vers un autre hôte**. Que les deux
    // en-têtes (`X-SafeExamBrowser-ConfigKeyHash`, `-RequestHash`) soient bien
    // ajoutés à cette requête-là, et hachés sur l'URL du portail avec sa
    // chaîne de requête, n'a pas été observé sur un binaire SEB : le mode
    // `simulated` ne le prouve pas. À confronter lors de la preuve B
    // (docs/preuve-b-manuelle.md). Si SEB ne les ajoutait pas après
    // redirection, la `startURL` devrait revenir sur le portail et c'est
    // classroom qui poserait le jeton par un formulaire.
    if (assignment.mode === "exam") {
      const seb = opts.verifier.verifyStart(
        { url: request.url, headers: request.headers },
        { configKey: assignment.configKey ?? "", beks: assignment.beks },
      );
      if (!seb.ok) {
        // Ni BEK ni en-tête dans le journal : ce sont des hachés du secret
        // partagé (seb/routes.ts).
        request.log.warn(
          {
            seb: {
              assignmentId: assignment.id,
              reason: seb.reason,
              mode: opts.verifier.mode,
              clientAddress: request.ip,
            },
          },
          "lancement d'examen refusé",
        );
        return html(
          reply,
          403,
          outsideSebPage("Cette épreuve ne s'ouvre que depuis Safe Exam Browser."),
        );
      }
    }

    const result = await manager.start(user, assignment, {
      sebVerified: assignment.mode === "exam",
      teacherId: assignment.teacherId,
      launchJti: claims.jti,
      targetRepo: claims.repo,
    });

    if (assignment.mode === "exam") {
      reply.setCookie(
        EXAM_COOKIE,
        issueExamCookie(
          {
            assignmentId: assignment.id,
            sessionId: result.session.id,
            clientAddress: request.ip,
            issuedAt: Date.now(),
          },
          { secret: config.EXAM_COOKIE_SECRET, maxAgeMs: config.EXAM_COOKIE_MAX_AGE_MS },
        ),
        examCookieAttributes({ secure, maxAgeMs: config.EXAM_COOKIE_MAX_AGE_MS }),
      );
    }

    reply.setCookie(
      SESSION_COOKIE,
      cookieValue(result.session.id, result.cookieToken),
      sessionCookieOptions(result.session.id, secure),
    );
    request.log.info(
      {
        launch: {
          // Le jeton n'apparaît jamais ; son `jti` suffit à relier les deux
          // journaux, et il n'est pas un secret.
          jti: claims.jti,
          assignmentId: assignment.id,
          sessionId: result.session.id,
          login: user.login,
          mode: assignment.mode,
          launched: result.launched,
          resumed: resuming,
        },
      },
      "session ouverte depuis un jeton de lancement classroom",
    );
    return reply.redirect(`/s/${result.session.id}/`, 303);
  });
}

export const classroomRoutes = fp(classroomRoutesImpl, {
  fastify: "5.x",
  name: "classroom-routes",
});
