/**
 * Les routes HTML du portail et le démarrage de session.
 *
 * Chaque route porte sa garde d'autorisation explicitement : `requireUser`
 * pour l'étudiant, `requireTeacher` pour le tableau. Aucun crochet global ne
 * protège « tout sauf » — une liste d'exceptions se trompe en silence.
 */
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

import type { AppConfig } from "../auth/config.js";
import type { Db } from "../db/client.js";
import { SESSION_COOKIE, cookieValue } from "../proxy/index.js";
import { WorkspaceBootstrapError, type SessionManager } from "../sessions/manager.js";
import {
  findAssignment,
  findLiveSession,
  isOpen,
  listOpenAssignments,
  teacherSessionRows,
} from "../sessions/store.js";

import {
  errorPage,
  homePage,
  teacherSessionsPage,
  workspaceErrorPage,
  type HomeAssignment,
} from "./pages.js";

export interface WebRoutesOptions {
  config: AppConfig;
  db: Db;
  manager: SessionManager;
}

/**
 * Attributs du cookie de session de codespace. `Path=/s/<id>` : le navigateur
 * n'envoie ce cookie qu'à cette session, donc deux sessions ouvertes dans le
 * même navigateur ne se marchent pas dessus.
 */
export function sessionCookieOptions(sessionId: string, secure: boolean) {
  return {
    path: `/s/${sessionId}`,
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
  };
}

async function webRoutesImpl(app: FastifyInstance, opts: WebRoutesOptions): Promise<void> {
  const { config, db, manager } = opts;
  const secure = config.NODE_ENV === "production";

  app.get("/", { preHandler: (req, reply) => app.requireUser(req, reply) }, async (req, reply) => {
    const user = req.user!;
    const items: HomeAssignment[] = listOpenAssignments(db).map((assignment) => ({
      assignment,
      session: findLiveSession(db, user.login, assignment.id) ?? null,
    }));
    return reply
      .type("text/html; charset=utf-8")
      .send(
        homePage({ login: user.login, displayName: user.displayName, role: user.role }, items),
      );
  });

  app.post<{ Params: { assignmentId: string } }>(
    "/assignments/:assignmentId/start",
    { preHandler: (req, reply) => app.requireUser(req, reply) },
    async (req, reply) => {
      const user = req.user!;
      const assignment = findAssignment(db, req.params.assignmentId);
      if (!assignment) {
        return reply
          .code(404)
          .type("text/html; charset=utf-8")
          .send(errorPage("Devoir inconnu", "Ce devoir n'existe pas."));
      }
      if (!isOpen(assignment)) {
        return reply
          .code(403)
          .type("text/html; charset=utf-8")
          .send(errorPage("Devoir fermé", "La fenêtre d'ouverture de ce devoir est close."));
      }
      if (assignment.mode === "exam") {
        // Invariant 5 : une session d'examen naît de `/exam/<devoir>/start`,
        // vérifié, et de nulle part ailleurs.
        return reply
          .code(403)
          .type("text/html; charset=utf-8")
          .send(
            errorPage(
              "Épreuve",
              "Une épreuve s'ouvre depuis Safe Exam Browser, par le lien fourni par l'enseignant.",
            ),
          );
      }
      const started = Date.now();
      let result: Awaited<ReturnType<SessionManager["start"]>>;
      try {
        result = await manager.start(user, assignment);
      } catch (err) {
        // L'espace de travail n'a pas pu être préparé : aucun conteneur n'a
        // été lancé, et l'étudiant doit le savoir (voir `seedStaging`).
        if (!(err instanceof WorkspaceBootstrapError)) throw err;
        req.log.warn(
          { assignmentId: assignment.id, login: user.login, cause: err.shortCause },
          "démarrage refusé : espace de travail impossible à préparer",
        );
        return reply
          .code(503)
          .type("text/html; charset=utf-8")
          .send(workspaceErrorPage(err.shortCause));
      }
      req.log.info(
        {
          sessionId: result.session.id,
          launched: result.launched,
          healthyInMs: result.healthyInMs,
          totalMs: Date.now() - started,
        },
        "démarrage de session",
      );
      reply.setCookie(
        SESSION_COOKIE,
        cookieValue(result.session.id, result.cookieToken),
        sessionCookieOptions(result.session.id, secure),
      );
      return reply.redirect(`/s/${result.session.id}/`, 303);
    },
  );

  app.get(
    "/teacher/sessions",
    { preHandler: (req, reply) => app.requireTeacher(req, reply) },
    async (_req, reply) =>
      reply.type("text/html; charset=utf-8").send(teacherSessionsPage(teacherSessionRows(db))),
  );

  app.post<{ Params: { sessionId: string } }>(
    "/teacher/sessions/:sessionId/close",
    { preHandler: (req, reply) => app.requireTeacher(req, reply) },
    async (req, reply) => {
      await manager.close(req.params.sessionId, `fermeture par ${req.user?.login ?? "?"}`);
      return reply.redirect("/teacher/sessions", 303);
    },
  );
}

export const webRoutes = fp(webRoutesImpl, { fastify: "5.x", name: "web-routes" });
