/**
 * Fastify plugin of the exam side: serving the `.seb` file and verifying the
 * start.
 *
 * Two routes, no dependency on `server.ts`. Everything that comes from the
 * outside — the assignments, the verifier, the session creation — goes through
 * the options, so that the plugin can be tested on its own.
 *
 * The cookie is read and set by hand rather than with `@fastify/cookie`: this
 * plugin has to be registrable in an instance that has already registered the
 * cookie plugin, or has not registered it yet, without causing a decorator
 * collision. The value `issueExamCookie` emits is base64url, therefore free of
 * characters that would need escaping.
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

/** What the portal knows about an assignment in exam mode. */
export interface SebAssignment {
  readonly id: string;
  /** Config Key of the configuration that is served, see sebFile.ts. */
  readonly configKey: string;
  /** One BEK per (platform, version) pair. A list, not a scalar. */
  readonly beks: readonly string[];
  /** Absolute URL of the start route, the one written into the `.seb` file. */
  readonly startUrl: string;
  readonly quitUrl: string;
  readonly examKeySalt: string;
  readonly extraAllowedHosts?: readonly string[];
}

/** Source of the assignments. A `Map` in tests, the database in V1. */
export interface AssignmentLookup {
  find(assignmentId: string): Promise<SebAssignment | undefined> | SebAssignment | undefined;
}

/** Builds a source from a `Map`, for tests and seeds. */
export function mapLookup(assignments: ReadonlyMap<string, SebAssignment>): AssignmentLookup {
  return { find: (id) => assignments.get(id) };
}

export interface StartContext {
  readonly assignment: SebAssignment;
  readonly clientAddress: string;
  readonly request: FastifyRequest;
}

export interface StartOutcome {
  /** Session identifier, written into the cookie. */
  readonly sessionId: string;
  /** Where to redirect to, typically `/s/<sessionId>/`. */
  readonly redirectTo: string;
}

export interface SebRoutesOptions {
  readonly lookup: AssignmentLookup;
  readonly verifier: SebVerifier;
  /** HMAC secret of the exam cookie. */
  readonly cookieSecret: string;
  /** `Secure` on the cookie: false only in cleartext development. */
  readonly cookieSecure?: boolean;
  readonly cookieMaxAgeMs?: number;
  /**
   * Called after a successful verification: creates or resumes the session and
   * returns where to go. Injected so that this plugin does not have to know
   * about `sessions/` nor `engine/`.
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

/** The 403 "session outside SEB" page. Deliberately terse on the student side. */
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

/**
 * Refusal to start an exam for a cause that has nothing to do with SEB: the
 * statement could not be placed in the workspace. The student is not
 * redirected to an empty room — the invigilator is called.
 */
export function workspacePage(detail: string): string {
  return `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><title>Épreuve indisponible</title></head>
<body>
<h1>Épreuve indisponible</h1>
<p>${escapeHtml(detail)}</p>
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
    // `Lax`: SEB reaches /start through a top-level navigation.
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
        // The reason is logged, never a BEK nor a SEB header: the headers
        // received are hashes of the shared secret, and the list of accepted
        // BEKs must not appear anywhere in the logs.
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
          "exam start refused",
        );
        return reply
          .code(403)
          .type("text/html; charset=utf-8")
          .send(outsideSebPage(REFUSAL_MESSAGES[verdict.reason]));
      }

      let outcome: StartOutcome;
      try {
        outcome = await options.onStart({
          assignment,
          clientAddress: request.ip,
          request,
        });
      } catch (err) {
        // An `onStart` may refuse for a reason that has nothing to do with
        // SEB: the workspace could not be prepared (`sessions/manager.ts`,
        // `WorkspaceBootstrapError`). The exam side does not know that module
        // — the short cause is read structurally, not by type, which keeps the
        // boundary intact.
        const cause = (err as { shortCause?: unknown } | null)?.shortCause;
        if (typeof cause !== "string") throw err;
        request.log.warn(
          { seb: { assignmentId: assignment.id, clientAddress: request.ip }, cause },
          "exam start refused: workspace could not be prepared",
        );
        return reply
          .code(503)
          .type("text/html; charset=utf-8")
          .send(
            workspacePage(
              `Espace de travail impossible à préparer : ${cause} ; signalez-le au surveillant.`,
            ),
          );
      }

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
        "exam start accepted",
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
 * The check the `/s/<session>/*` proxy will call. It looks at **no** SEB header
 * (invariant 5): only at the cookie and the address. Exported here so that
 * `proxy/` does not have to learn the cookie format again.
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

/** The proxy's single 403 response, so that the message does not vary with the route. */
export function replyOutsideSeb(reply: FastifyReply, verdict: ExamCookieVerdict): FastifyReply {
  const detail =
    verdict.ok === false && verdict.reason === "address-mismatch"
      ? "Cette session a été ouverte depuis un autre poste."
      : "Aucune session d'examen valide sur ce navigateur.";
  return reply.code(403).type("text/html; charset=utf-8").send(outsideSebPage(detail));
}

export { readCookie as readExamCookieFrom };
