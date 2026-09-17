/**
 * `/s/<session>/*` → code-server du conteneur.
 *
 * **Invariant 5 de CLAUDE.md** : ce proxy ne lit jamais d'en-tête SEB. Il
 * connaît le cookie de session du portail, et, en mode examen, le cookie
 * `exam_session` que `seb/routes.ts` a posé une fois, à la vérification. La
 * raison est dans analyse.md § 4.5 : rien ne garantit que SEB ajoute ses
 * en-têtes aux mises à niveau websocket ni aux requêtes de service worker.
 *
 * Les mises à niveau websocket passent par le routeur Fastify
 * (`@fastify/http-proxy` les redirige vers `fastify.routing`), donc le
 * `preHandler` ci-dessous s'applique aussi à elles : une session sans cookie
 * ne peut pas ouvrir de socket.
 *
 * L'amont est dynamique (une adresse par conteneur) : `replyOptions.getUpstream`
 * est synchrone, donc le `preHandler` — qui, lui, peut attendre la base et
 * Podman — dépose l'adresse dans un cache que `getUpstream` relit.
 */
import httpProxy from "@fastify/http-proxy";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import type { Db } from "../db/client.js";
import type { SessionRow } from "../db/schema.js";
import { checkExamRequest, replyOutsideSeb } from "../seb/index.js";
import type { SessionManager } from "../sessions/manager.js";
import { findAssignment, findSession } from "../sessions/store.js";

/** Nom du cookie de session de codespace ; porté avec `Path=/s/<id>`. */
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

/** Valeur du cookie : `<sessionId>.<jeton>`, pour qu'il ne serve qu'à sa session. */
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

/** Une requête sur `/s/<id>/` exactement : le rechargement de page de l'étudiant. */
export function isEntryRequest(url: string, sessionId: string): boolean {
  const path = url.split("?", 1)[0] ?? "";
  return path === `/s/${sessionId}` || path === `/s/${sessionId}/`;
}

async function proxyPluginImpl(app: FastifyInstance, opts: ProxyOptions): Promise<void> {
  const { db, manager } = opts;
  /** sid → `http://<ip>:8080`. Rempli par le `preHandler`, lu par `getUpstream`. */
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
        "accès au proxy refusé : cookie de session absent ou invalide",
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

    // Mode examen : le cookie SEB, et lui seul (invariant 5). Une adresse
    // client différente de celle de la vérification initiale est refusée
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
          "accès au proxy refusé en mode examen",
        );
        return replyOutsideSeb(reply, verdict);
      }
      if (verdict.claims.sessionId !== sessionId) {
        request.log.warn({ sessionId }, "cookie d'examen d'une autre session");
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

    // Le rechargement de page est le moment où l'on vérifie que le conteneur
    // est encore là — et où on le relance sur le même volume s'il est mort
    // (`podman kill`, redémarrage de l'hôte). Les requêtes de ressources et
    // les trames websocket ne paient pas ce coût : elles se contentent du
    // cache, et une session morte se manifeste par un rechargement.
    if (isEntryRequest(request.url, sessionId) || !upstreams.has(sessionId)) {
      try {
        session = await manager.ensureRunning(sessionId);
      } catch (err) {
        request.log.error({ sessionId, err }, "relance de session impossible");
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
    // Battement : c'est le proxy qui tient `lastSeen`, donc l'onglet ouvert
    // suffit à garder la session en vie et sa fermeture démarre la grâce.
    manager.touch(sessionId);
    return undefined;
  }

  await app.register(httpProxy, {
    prefix: "/s/:sid",
    rewritePrefix: "/",
    upstream: "",
    websocket: true,
    preHandler: guard,
    // La réécriture interne d'en-tête `Location` de @fastify/http-proxy est
    // fausse pour un préfixe paramétré : elle remplace le préfixe réécrit
    // (ici la chaîne vide) par le préfixe *littéral* de la route, et
    // `"./?folder=/work".replace("", "/s/:sid")` produit
    // `"/s/:sid./?folder=/work"` — un `:sid` non substitué. On la coupe et on
    // réécrit soi-même, en ne touchant qu'aux chemins absolus : code-server
    // sert tout en relatif (`serverBasePath: "."`), donc le cas normal n'a
    // même pas besoin d'être réécrit.
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
