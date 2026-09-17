/**
 * Greffon Fastify du volet examen : servir le `.seb` et vérifier le démarrage.
 *
 * Deux routes, aucune dépendance à `server.ts`. Tout ce qui vient de
 * l'extérieur — les devoirs, le vérificateur, la création de session — passe
 * par les options, pour que le greffon se teste seul.
 *
 * Le cookie est lu et posé à la main plutôt qu'avec `@fastify/cookie` : ce
 * greffon doit pouvoir s'enregistrer dans une instance qui a déjà, ou pas
 * encore, enregistré le greffon de cookies, sans provoquer de collision de
 * décorateur. La valeur émise par `issueExamCookie` est en base64url, donc
 * sans caractère à échapper.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import {
  EXAM_COOKIE,
  EXAM_COOKIE_DEFAULT_MAX_AGE_MS,
  issueExamCookie,
  verifyExamCookie,
  type ExamCookieVerdict,
} from "./examSession.js";
import { SEB_CONTENT_TYPE, renderSebFile } from "./sebFile.js";
import type { SebRefusal, SebVerifier } from "./verify.js";

/** Ce que le portail sait d'un devoir en mode examen. */
export interface SebAssignment {
  readonly id: string;
  /** Config Key de la configuration servie, cf. sebFile.ts. */
  readonly configKey: string;
  /** Un BEK par couple (plateforme, version). Liste, pas scalaire. */
  readonly beks: readonly string[];
  /** URL absolue de la route de démarrage, celle inscrite dans le `.seb`. */
  readonly startUrl: string;
  readonly quitUrl: string;
  readonly examKeySalt: string;
  readonly extraAllowedHosts?: readonly string[];
}

/** Source des devoirs. Une `Map` en test, la base en V1. */
export interface AssignmentLookup {
  find(assignmentId: string): Promise<SebAssignment | undefined> | SebAssignment | undefined;
}

/** Fabrique une source à partir d'une `Map`, pour les tests et les graines. */
export function mapLookup(assignments: ReadonlyMap<string, SebAssignment>): AssignmentLookup {
  return { find: (id) => assignments.get(id) };
}

export interface StartContext {
  readonly assignment: SebAssignment;
  readonly clientAddress: string;
  readonly request: FastifyRequest;
}

export interface StartOutcome {
  /** Identifiant de session, inscrit dans le cookie. */
  readonly sessionId: string;
  /** Où rediriger, typiquement `/s/<sessionId>/`. */
  readonly redirectTo: string;
}

export interface SebRoutesOptions {
  readonly lookup: AssignmentLookup;
  readonly verifier: SebVerifier;
  /** Secret HMAC du cookie d'examen. */
  readonly cookieSecret: string;
  /** `Secure` sur le cookie : faux seulement en développement en clair. */
  readonly cookieSecure?: boolean;
  readonly cookieMaxAgeMs?: number;
  /**
   * Appelé après une vérification réussie : crée ou reprend la session et
   * renvoie où aller. Injecté pour que ce greffon n'ait pas à connaître
   * `sessions/` ni `engine/`.
   */
  onStart(ctx: StartContext): Promise<StartOutcome> | StartOutcome;
}

const REFUSAL_MESSAGES: Record<SebRefusal, string> = {
  "url-unreconstructible": "Le portail n'a pas pu reconstruire l'URL de la requête.",
  "missing-config-key-header": "La requête ne vient pas de Safe Exam Browser.",
  "missing-request-hash-header": "La requête ne vient pas de Safe Exam Browser.",
  "config-key-mismatch": "La configuration de Safe Exam Browser n'est pas celle de ce devoir.",
  "browser-exam-key-mismatch":
    "La version de Safe Exam Browser utilisée n'est pas une de celles acceptées pour ce devoir.",
  "no-browser-exam-key-configured":
    "Ce devoir n'a aucune clé d'examen enregistrée ; prévenez l'enseignant.",
  "missing-dev-header": "La requête ne vient pas de Safe Exam Browser.",
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Page 403 « session hors SEB ». Volontairement peu bavarde côté étudiant. */
export function outsideSebPage(detail: string): string {
  return `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><title>Session hors Safe Exam Browser</title></head>
<body>
<h1>Session hors Safe Exam Browser</h1>
<p>Cette épreuve ne peut être ouverte que depuis Safe Exam Browser, lancé par le
lien fourni par l'enseignant.</p>
<p>${escapeHtml(detail)}</p>
<p>Si vous pensez que c'est une erreur, appelez le surveillant : ne recommencez
pas depuis un autre navigateur.</p>
</body>
</html>
`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function serialiseCookie(
  name: string,
  value: string,
  options: { maxAgeMs: number; secure: boolean },
): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    // `Lax` : SEB arrive sur /start par une navigation de premier niveau.
    "SameSite=Lax",
    `Max-Age=${Math.floor(options.maxAgeMs / 1000)}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

async function sebRoutesPlugin(app: FastifyInstance, options: SebRoutesOptions): Promise<void> {
  const maxAgeMs = options.cookieMaxAgeMs ?? EXAM_COOKIE_DEFAULT_MAX_AGE_MS;
  const secure = options.cookieSecure ?? true;

  app.get<{ Params: { assignmentId: string } }>(
    "/exam/:assignmentId.seb",
    async (request, reply) => {
      const assignment = await options.lookup.find(request.params.assignmentId);
      if (assignment === undefined) {
        return reply.code(404).type("text/plain; charset=utf-8").send("Devoir inconnu\n");
      }
      const file = renderSebFile({
        startUrl: assignment.startUrl,
        quitUrl: assignment.quitUrl,
        examKeySalt: assignment.examKeySalt,
        ...(assignment.extraAllowedHosts !== undefined
          ? { extraAllowedHosts: assignment.extraAllowedHosts }
          : {}),
      });
      return reply
        .code(200)
        .header("content-type", SEB_CONTENT_TYPE)
        .header("content-disposition", 'attachment; filename="config.seb"')
        .header("cache-control", "private, max-age=1, no-transform")
        .send(file.xml);
    },
  );

  app.get<{ Params: { assignmentId: string } }>(
    "/exam/:assignmentId/start",
    async (request, reply) => {
      const assignment = await options.lookup.find(request.params.assignmentId);
      if (assignment === undefined) {
        return reply.code(404).type("text/plain; charset=utf-8").send("Devoir inconnu\n");
      }

      const verdict = options.verifier.verifyStart(
        { url: request.url, headers: request.headers },
        { configKey: assignment.configKey, beks: assignment.beks },
      );

      if (!verdict.ok) {
        // Journalisation de la raison, jamais d'un BEK ni d'un en-tête SEB :
        // les en-têtes reçus sont des hachés du secret partagé, et la liste
        // des BEK acceptés ne doit apparaître nulle part dans les journaux.
        request.log.warn(
          {
            seb: {
              assignmentId: assignment.id,
              reason: verdict.reason,
              mode: options.verifier.mode,
              clientAddress: request.ip,
              url: verdict.url,
            },
          },
          "démarrage d'examen refusé",
        );
        return reply
          .code(403)
          .type("text/html; charset=utf-8")
          .send(outsideSebPage(REFUSAL_MESSAGES[verdict.reason]));
      }

      const outcome = await options.onStart({
        assignment,
        clientAddress: request.ip,
        request,
      });

      const cookie = issueExamCookie(
        {
          assignmentId: assignment.id,
          sessionId: outcome.sessionId,
          clientAddress: request.ip,
          issuedAt: Date.now(),
        },
        { secret: options.cookieSecret, maxAgeMs: maxAgeMs },
      );

      request.log.info(
        {
          seb: {
            assignmentId: assignment.id,
            sessionId: outcome.sessionId,
            mode: options.verifier.mode,
            clientAddress: request.ip,
          },
        },
        "démarrage d'examen accepté",
      );

      return reply
        .header("set-cookie", serialiseCookie(EXAM_COOKIE, cookie, { maxAgeMs, secure }))
        .redirect(outcome.redirectTo, 303);
    },
  );
}

export const sebRoutes = fp(sebRoutesPlugin, {
  fastify: "5.x",
  name: "seb-routes",
});

/**
 * Vérification que le proxy `/s/<session>/*` appellera. Elle ne regarde
 * **aucun** en-tête SEB (invariant 5) : uniquement le cookie et l'adresse.
 * Exportée ici pour que `proxy/` n'ait pas à réapprendre le format du cookie.
 */
export function checkExamRequest(
  request: FastifyRequest,
  check: { secret: string; assignmentId?: string; maxAgeMs?: number },
): ExamCookieVerdict {
  return verifyExamCookie(readCookie(request.headers.cookie, EXAM_COOKIE), {
    secret: check.secret,
    clientAddress: request.ip,
    ...(check.assignmentId !== undefined ? { assignmentId: check.assignmentId } : {}),
    ...(check.maxAgeMs !== undefined ? { maxAgeMs: check.maxAgeMs } : {}),
  });
}

/** Réponse 403 unique du proxy, pour que le message ne varie pas selon la route. */
export function replyOutsideSeb(reply: FastifyReply, verdict: ExamCookieVerdict): FastifyReply {
  const detail =
    verdict.ok === false && verdict.reason === "address-mismatch"
      ? "Cette session a été ouverte depuis un autre poste."
      : "Aucune session d'examen valide sur ce navigateur.";
  return reply.code(403).type("text/html; charset=utf-8").send(outsideSebPage(detail));
}

export { readCookie as readExamCookieFrom };
