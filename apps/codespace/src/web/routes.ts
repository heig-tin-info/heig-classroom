/**
 * The portal's HTML routes and the session start.
 *
 * Every route carries its authorization guard explicitly: `requireUser` for the
 * student, `requireTeacher` for the dashboard. No global hook protects
 * "everything but" — a list of exceptions goes wrong silently.
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
 * Attributes of the codespace session cookie. `Path=/s/<id>`: the browser only
 * sends this cookie to that session, so two sessions open in the same browser
 * do not step on each other.
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
        // Invariant 5: an exam session is born from `/exam/<assignment>/start`,
        // verified, and from nowhere else.
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
        // The workspace could not be prepared: no container was started, and
        // the student must know it (see `seedStaging`).
        if (!(err instanceof WorkspaceBootstrapError)) throw err;
        req.log.warn(
          { assignmentId: assignment.id, login: user.login, cause: err.shortCause },
          "start refused: the workspace could not be prepared",
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
        "session start",
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
      await manager.close(req.params.sessionId, `closed by ${req.user?.login ?? "?"}`);
      return reply.redirect("/teacher/sessions", 303);
    },
  );
}

export const webRoutes = fp(webRoutesImpl, { fastify: "5.x", name: "web-routes" });
