/**
 * Greffon d'authentification : les trois routes OIDC, la résolution de
 * l'utilisateur à chaque requête, et les deux gardes d'autorisation.
 *
 * Les gardes sont **explicites par route** (`preHandler: app.requireStudent`),
 * jamais un crochet global qui protégerait « tout sauf » : une liste
 * d'exceptions se trompe en silence, une garde posée route par route se lit.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import type { Db } from "../db/client.js";
import { users, type UserRow } from "../db/schema.js";

import type { AppConfig } from "./config.js";
import { OidcProvider, type OidcClaims, type Role } from "./oidc.js";
import { AUTH_COOKIE, issueAuthCookie, verifyAuthCookie } from "./session.js";

const LOGIN_STASH_COOKIE = "cs_login";

declare module "fastify" {
  interface FastifyRequest {
    user: UserRow | null;
  }
  interface FastifyInstance {
    requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>;
    requireTeacher: (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>;
  }
}

export interface AuthPluginOptions {
  config: AppConfig;
  db: Db;
}

/**
 * Création ou mise à jour à chaque connexion ; le rôle est recalculé depuis
 * les revendications, jamais lu en base.
 *
 * La ligne est retrouvée par son sujet OIDC, puis, à défaut, par son `login` :
 * `db/seed.ts` préinscrit des comptes avec un `oidc_sub` en `pending:<login>`
 * et la première connexion les adopte. Sans cela, l'index unique sur `login`
 * ferait échouer la connexion du premier étudiant préinscrit.
 */
export async function upsertUser(db: Db, claims: OidcClaims): Promise<UserRow> {
  const now = new Date();
  const existing =
    db.select().from(users).where(eq(users.oidcSub, claims.sub)).get() ??
    db.select().from(users).where(eq(users.login, claims.login)).get();
  if (existing) {
    const [row] = db
      .update(users)
      .set({
        oidcSub: claims.sub,
        login: claims.login,
        email: claims.email,
        displayName: claims.displayName,
        role: claims.role,
        lastLoginAt: now,
      })
      .where(eq(users.id, existing.id))
      .returning()
      .all();
    if (!row) throw new Error("Mise à jour de l'utilisateur sans ligne");
    return row;
  }
  const [row] = db
    .insert(users)
    .values({
      id: randomUUID(),
      oidcSub: claims.sub,
      login: claims.login,
      email: claims.email,
      displayName: claims.displayName,
      role: claims.role,
      createdAt: now,
      lastLoginAt: now,
    })
    .returning()
    .all();
  if (!row) throw new Error("Création de l'utilisateur sans ligne");
  return row;
}

function wantsHtml(req: FastifyRequest): boolean {
  const accept = req.headers.accept ?? "";
  return accept.includes("text/html");
}

async function authPluginImpl(app: FastifyInstance, opts: AuthPluginOptions): Promise<void> {
  const { config, db } = opts;
  const provider = new OidcProvider(config, app.log);
  const secure = config.NODE_ENV === "production";
  const ttlMs = config.SESSION_TTL_HOURS * 3_600_000;

  app.decorateRequest("user", null);
  app.addHook("preHandler", async (req) => {
    const verdict = verifyAuthCookie(req.cookies[AUTH_COOKIE], config.COOKIE_SECRET);
    if (!verdict.ok) return;
    const row = db.select().from(users).where(eq(users.id, verdict.claims.userId)).get();
    req.user = row ?? null;
  });

  app.decorate("requireUser", async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.user) return undefined;
    if (wantsHtml(req)) return reply.redirect("/auth/login", 303);
    return reply.code(401).send({ error: "unauthenticated" });
  });

  app.decorate("requireTeacher", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      if (wantsHtml(req)) return reply.redirect("/auth/login", 303);
      return reply.code(401).send({ error: "unauthenticated" });
    }
    if (req.user.role !== ("teacher" satisfies Role)) {
      return reply.code(403).type("text/html; charset=utf-8").send(
        "<!doctype html><html lang=fr><meta charset=utf-8><title>Accès refusé</title>" +
          "<h1>Accès refusé</h1><p>Cette page est réservée aux enseignants.</p>",
      );
    }
    return undefined;
  });

  app.get("/auth/login", async (_req, reply) => {
    const { url, codeVerifier, state, nonce } = await provider.beginLogin();
    reply.setCookie(LOGIN_STASH_COOKIE, JSON.stringify({ codeVerifier, state, nonce }), {
      path: "/auth",
      httpOnly: true,
      sameSite: "lax",
      secure,
      signed: true,
      maxAge: 600,
    });
    return reply.redirect(url, 303);
  });

  app.get("/auth/callback", async (req, reply) => {
    const raw = req.cookies[LOGIN_STASH_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : { valid: false as const, value: null };
    if (!unsigned.valid || !unsigned.value) {
      return reply.code(400).send({ error: "login_state" });
    }
    reply.clearCookie(LOGIN_STASH_COOKIE, { path: "/auth" });
    const stash = JSON.parse(unsigned.value) as {
      codeVerifier: string;
      state: string;
      nonce: string;
    };
    const callbackUrl = new URL(req.raw.url ?? "", config.PUBLIC_URL);
    let claims: OidcClaims;
    try {
      claims = await provider.completeLogin(callbackUrl, stash);
    } catch (err) {
      req.log.warn({ err }, "échange OIDC refusé");
      return reply.code(401).send({ error: "oidc" });
    }
    const user = await upsertUser(db, claims);
    const expiresAt = Date.now() + ttlMs;
    reply.setCookie(
      AUTH_COOKIE,
      issueAuthCookie(
        { userId: user.id, login: user.login, role: user.role, expiresAt },
        config.COOKIE_SECRET,
      ),
      {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure,
        expires: new Date(expiresAt),
      },
    );
    req.log.info({ login: user.login, role: user.role }, "connexion OIDC acceptée");
    return reply.redirect("/", 303);
  });

  // Le « sélecteur d'utilisateur en dev » de jalon-0 : un lien de
  // déconnexion, Keycloak fait le reste.
  app.get("/auth/logout", async (_req, reply) => {
    reply.clearCookie(AUTH_COOKIE, { path: "/" });
    return reply.redirect("/", 303);
  });
}

export const authPlugin = fp(authPluginImpl, { fastify: "5.x", name: "auth" });
