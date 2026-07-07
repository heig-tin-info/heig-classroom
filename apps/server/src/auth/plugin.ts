import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { eq } from "drizzle-orm";

import { audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import { teacherGrants, users } from "../db/schema.js";
import { claimEnrollments } from "../modules/roster.js";
import { OidcProvider, type OidcClaims } from "./oidc.js";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  createSession,
  deleteSession,
  findSessionUser,
} from "./session.js";

const LOGIN_STASH_COOKIE = "hgc_login";

type SessionUser = typeof users.$inferSelect;

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

/**
 * Upsert de l'utilisateur au login (clé : oidc_sub). Rôle recalculé à chaque
 * login : admin (SUPER_ADMIN_EMAIL), teacher (grant en base), sinon student.
 */
async function upsertUser(
  app: FastifyInstance,
  config: AppConfig,
  claims: OidcClaims,
): Promise<SessionUser> {
  let role: "student" | "teacher" | "admin" = "student";
  if (config.SUPER_ADMIN_EMAIL && claims.email === config.SUPER_ADMIN_EMAIL) {
    role = "admin";
  } else {
    const [grant] = await app.db
      .select({ id: teacherGrants.id })
      .from(teacherGrants)
      .where(eq(teacherGrants.email, claims.email))
      .limit(1);
    if (grant) role = "teacher";
  }
  const now = new Date();
  const [row] = await app.db
    .insert(users)
    .values({
      id: randomUUID(),
      oidcSub: claims.sub,
      email: claims.email,
      emailVerified: claims.emailVerified,
      givenName: claims.givenName,
      familyName: claims.familyName,
      swissEduId: claims.swissEduId,
      role,
      lastLoginAt: now, // AU-27
    })
    .onConflictDoUpdate({
      target: users.oidcSub,
      set: {
        email: claims.email,
        emailVerified: claims.emailVerified,
        givenName: claims.givenName,
        familyName: claims.familyName,
        swissEduId: claims.swissEduId,
        role,
        lastLoginAt: now,
      },
    })
    .returning();
  if (!row) throw new Error("Upsert utilisateur sans retour");
  return row;
}

async function authPluginImpl(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const provider = new OidcProvider(config);
  const secure = config.NODE_ENV === "production";

  // --- Résolution de session sur chaque requête ---
  app.decorateRequest("user", null);
  app.addHook("preHandler", async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    req.user = await findSessionUser(app.db, token);
  });

  // --- Garde-fous réutilisables ---
  app.decorate(
    "requireSession",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
      // Anti-CSRF double-submit (docs/03 « Contrat API ») sur toute mutation.
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        const cookie = req.cookies[CSRF_COOKIE];
        const header = req.headers[CSRF_HEADER];
        if (!cookie || cookie !== header) {
          return reply.code(403).send({ error: "csrf" });
        }
      }
      return undefined;
    },
  );

  // --- Routes ---
  app.get("/app/auth/login", async (_req, reply) => {
    const { url, codeVerifier, state, nonce } = await provider.beginLogin();
    reply.setCookie(LOGIN_STASH_COOKIE, JSON.stringify({ codeVerifier, state, nonce }), {
      path: "/app/auth",
      httpOnly: true,
      sameSite: "lax",
      secure,
      signed: true,
      maxAge: 600,
    });
    return reply.redirect(url, 303);
  });

  app.get("/app/auth/callback", async (req, reply) => {
    const raw = req.cookies[LOGIN_STASH_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : { valid: false as const, value: null };
    if (!unsigned.valid || !unsigned.value) {
      return reply.code(400).send({ error: "login_state", message: "Missing or invalid login state" });
    }
    const stash = JSON.parse(unsigned.value) as {
      codeVerifier: string;
      state: string;
      nonce: string;
    };
    reply.clearCookie(LOGIN_STASH_COOKIE, { path: "/app/auth" });

    const callbackUrl = new URL(req.raw.url ?? "", config.PUBLIC_URL);
    let claims: OidcClaims;
    try {
      claims = await provider.completeLogin(callbackUrl, stash);
    } catch (err) {
      req.log.warn({ err }, "échec de l'échange OIDC");
      return reply.code(401).send({ error: "oidc", message: "Authentication refused" });
    }

    const user = await upsertUser(app, config, claims);
    // Claim automatique du roster sur e-mail vérifié (AU-18, H3).
    if (claims.emailVerified) {
      await claimEnrollments(app.db, { id: user.id, email: user.email });
    }
    const session = await createSession(app.db, user.id, config.SESSION_TTL_HOURS);
    await audit(app.db, {
      actorUserId: user.id,
      actorType: "user",
      action: "auth.login",
      subjectType: "user",
      subjectId: user.id,
    });

    const cookieBase = { path: "/", sameSite: "lax", secure } as const;
    reply.setCookie(SESSION_COOKIE, session.token, {
      ...cookieBase,
      httpOnly: true,
      expires: session.expiresAt,
    });
    // Lisible par le front pour l'en-tête X-CSRF-Token (double-submit).
    reply.setCookie(CSRF_COOKIE, session.csrf, {
      ...cookieBase,
      httpOnly: false,
      expires: session.expiresAt,
    });
    return reply.redirect("/", 303);
  });

  app.post(
    "/app/auth/logout",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const token = req.cookies[SESSION_COOKIE];
      if (token) await deleteSession(app.db, token);
      await audit(app.db, {
        actorUserId: req.user?.id ?? null,
        actorType: "user",
        action: "auth.logout",
        subjectType: "user",
        subjectId: req.user?.id ?? "unknown",
      });
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      reply.clearCookie(CSRF_COOKIE, { path: "/" });
      return reply.code(204).send();
    },
  );

  app.get(
    "/app/api/me",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req) => {
      const u = req.user!;
      return {
        id: u.id,
        email: u.email,
        givenName: u.givenName,
        familyName: u.familyName,
        role: u.role,
        githubLogin: u.githubLogin,
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      };
    },
  );
}

declare module "fastify" {
  interface FastifyInstance {
    requireSession: (
      req: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<FastifyReply | undefined>;
  }
}

/** fastify-plugin : les décorateurs (request.user, requireSession) doivent être
 *  visibles des autres plugins — sans fp, ils restent encapsulés ici. */
export const authPlugin = fp(authPluginImpl, { name: "auth" });
