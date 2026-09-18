/**
 * `/s/<session>/*` → the container's code-server.
 *
 * **Invariant 5 of CLAUDE.md**: this proxy never reads an SEB header. It knows
 * the portal's session cookie and, in exam mode, the `exam_session` cookie that
 * `seb/routes.ts` set once, at verification time. The reason is in analyse.md
 * § 4.5: nothing guarantees that SEB adds its headers to websocket upgrades or
 * to service worker requests.
 *
 * Websocket upgrades go through the Fastify router (`@fastify/http-proxy`
 * redirects them to `fastify.routing`), so the `preHandler` below applies to
 * them too: a session without a cookie cannot open a socket.
 *
 * The upstream is dynamic (one address per container): `replyOptions.getUpstream`
 * is synchronous, so the `preHandler` — which, for its part, may await the
 * database and Podman — deposits the address in a cache that `getUpstream`
 * reads back.
 */
import httpProxy from "@fastify/http-proxy";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import type { Db } from "../db/client.js";
import type { SessionRow } from "../db/schema.js";
import { checkExamRequest, replyOutsideSeb } from "../seb/index.js";
import type { SessionManager } from "../sessions/manager.js";
import { findAssignment, findSession } from "../sessions/store.js";

/** Name of the codespace session cookie; carried with `Path=/s/<id>`. */
export const SESSION_COOKIE = "cs_session";

export interface ProxyOptions {
  db: Db;
  manager: SessionManager;
  examCookieSecret: string;
  examCookieMaxAgeMs: number;
}

declare module "fastify" {
  interface FastifyRequest {
    codespaceUpstream: string | null;
  }
}

/** Cookie value: `<sessionId>.<token>`, so that it only serves its own session. */
export function cookieValue(sessionId: string, token: string): string {
  return `${sessionId}.${token}`;
}

export function parseCookieValue(
  raw: string | undefined,
): { sessionId: string; token: string } | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  return { sessionId: raw.slice(0, dot), token: raw.slice(dot + 1) };
}

function deny(reply: FastifyReply, code: number, title: string, detail: string): FastifyReply {
  return reply
    .code(code)
    .type("text/html; charset=utf-8")
    .send(
      `<!doctype html><html lang="fr"><meta charset="utf-8"><title>${title}</title>` +
        `<h1>${title}</h1><p>${detail}</p><p><a href="/">Retour au portail</a></p>`,
    );
}

/** A request on exactly `/s/<id>/`: the student's page reload. */
export function isEntryRequest(url: string, sessionId: string): boolean {
  const path = url.split("?", 1)[0] ?? "";
  return path === `/s/${sessionId}` || path === `/s/${sessionId}/`;
}

async function proxyPluginImpl(app: FastifyInstance, opts: ProxyOptions): Promise<void> {
  const { db, manager } = opts;
  /** sid → `http://<ip>:8080`. Filled by the `preHandler`, read by `getUpstream`. */
  const upstreams = new Map<string, string>();

  app.decorateRequest("codespaceUpstream", null);

  async function guard(request: FastifyRequest, reply: FastifyReply) {
    const sessionId = (request.params as { sid?: string }).sid ?? "";
    let session: SessionRow | undefined = findSession(db, sessionId);
    if (!session) {
      return deny(reply, 404, "Session inconnue", "Cette session n'existe pas ou plus.");
    }

    const parsed = parseCookieValue(request.cookies[SESSION_COOKIE]);
    if (!parsed || parsed.sessionId !== sessionId || !manager.checkCookie(session, parsed.token)) {
      request.log.warn(
        { sessionId, clientAddress: request.ip },
        "proxy access refused: session cookie missing or invalid",
      );
      return deny(
        reply,
        403,
        "Session non autorisée",
        "Ouvrez la session depuis le portail : ce navigateur n'a pas de cookie pour elle.",
      );
    }

    const assignment = findAssignment(db, session.assignmentId);
    if (!assignment) {
      return deny(reply, 404, "Devoir inconnu", "Le devoir de cette session a disparu.");
    }

    // Exam mode: the SEB cookie, and it alone (invariant 5). A client address
    // different from the one of the initial verification is refused
    // (analyse.md D5).
    if (assignment.mode === "exam") {
      const verdict = checkExamRequest(request, {
        secret: opts.examCookieSecret,
        assignmentId: assignment.id,
        maxAgeMs: opts.examCookieMaxAgeMs,
      });
      if (!verdict.ok) {
        request.log.warn(
          { sessionId, reason: verdict.reason, clientAddress: request.ip },
          "proxy access refused in exam mode",
        );
        return replyOutsideSeb(reply, verdict);
      }
      if (verdict.claims.sessionId !== sessionId) {
        request.log.warn({ sessionId }, "exam cookie from another session");
        return replyOutsideSeb(reply, { ok: false, reason: "address-mismatch" });
      }
    }

    if (session.state === "closed" || session.state === "failed") {
      return deny(
        reply,
        410,
        "Session fermée",
        "Cette session a été fermée. Redémarrez-la depuis le portail ; votre travail est conservé.",
      );
    }

    // The page reload is the moment when we check that the container is still
    // there — and where we restart it on the same volume if it is dead
    // (`podman kill`, host reboot). Resource requests and websocket frames do
    // not pay that cost: they make do with the cache, and a dead session shows
    // up on a reload.
    if (isEntryRequest(request.url, sessionId) || !upstreams.has(sessionId)) {
      try {
        session = await manager.ensureRunning(sessionId);
      } catch (err) {
        request.log.error({ sessionId, err }, "session restart impossible");
        return deny(
          reply,
          502,
          "Session indisponible",
          "Le conteneur n'a pas pu être relancé. Votre volume est intact ; réessayez.",
        );
      }
    }
    if (!session.containerIp) {
      return deny(reply, 502, "Session indisponible", "Le conteneur n'a pas d'adresse.");
    }
    upstreams.set(sessionId, `http://${session.containerIp}:8080`);
    // Heartbeat: it is the proxy that keeps `lastSeen`, so an open tab is
    // enough to keep the session alive, and closing it starts the grace
    // period.
    manager.touch(sessionId);
    return undefined;
  }

  await app.register(httpProxy, {
    prefix: "/s/:sid",
    rewritePrefix: "/",
    upstream: "",
    websocket: true,
    preHandler: guard,
    // The internal `Location` header rewriting of @fastify/http-proxy is wrong
    // for a parameterized prefix: it replaces the rewritten prefix (here the
    // empty string) by the *literal* prefix of the route, and
    // `"./?folder=/work".replace("", "/s/:sid")` produces
    // `"/s/:sid./?folder=/work"` — an unsubstituted `:sid`. We turn it off and
    // rewrite it ourselves, touching only absolute paths: code-server serves
    // everything relative (`serverBasePath: "."`), so the normal case does not
    // even need to be rewritten.
    internalRewriteLocationHeader: false,
    replyOptions: {
      getUpstream(request) {
        const sessionId = (request.params as { sid?: string }).sid ?? "";
        return upstreams.get(sessionId) ?? "http://127.0.0.1:1";
      },
      rewriteHeaders(headers, request) {
        const location = headers["location"];
        const sessionId = (request?.params as { sid?: string } | undefined)?.sid;
        if (typeof location === "string" && sessionId && location.startsWith("/") && !location.startsWith("//")) {
          return { ...headers, location: `/s/${sessionId}${location}` };
        }
        return headers;
      },
    },
  });
}

export const proxyPlugin = fp(proxyPluginImpl, { fastify: "5.x", name: "codespace-proxy" });
