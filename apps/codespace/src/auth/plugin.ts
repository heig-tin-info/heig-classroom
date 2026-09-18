/**
 * Authentication plugin: the three OIDC routes, the resolution of the user on
 * every request, and the two authorization guards.
 *
 * The guards are **explicit per route** (`preHandler: app.requireStudent`),
 * never a global hook that would protect "everything but": a list of exceptions
 * goes wrong silently, a guard placed route by route can be read.
 *
 * ## Empty `OIDC_ISSUER`: standalone login disabled
 *
 * A deployment may not have an IdP yet — this is the case of the portal as long
 * as Switch edu-ID is not declared, the students arriving through classroom's
 * launch token (`/launch`, `classroom/routes.ts`). An empty `OIDC_ISSUER` says
 * exactly that: **no** login route is registered, `/auth/login` and
 * `/auth/callback` answer 404, and the pages that require a user answer 503
 * with a message that names the cause.
 *
 * This is not an identity shortcut (invariant 4): there is still only one way
 * to become `request.user` through this path, the real OIDC login. Empty, it is
 * not replaced: it is absent.
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
 * Created or updated at every login; the role is recomputed from the claims,
 * never read from the database.
 *
 * The row is found by its OIDC subject, then, failing that, by its `login`:
 * `db/seed.ts` pre-registers accounts with an `oidc_sub` of `pending:<login>`
 * and the first login adopts them. Without this, the unique index on `login`
 * would make the login of the first pre-registered student fail.
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
    if (!row) throw new Error("User update returned no row");
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
  if (!row) throw new Error("User creation returned no row");
  return row;
}

function wantsHtml(req: FastifyRequest): boolean {
  const accept = req.headers.accept ?? "";
  return accept.includes("text/html");
}

/** Page served when the portal has no declared IdP. */
function noIdpPage(): string {
  return (
    "<!doctype html><html lang=fr><meta charset=utf-8><title>Connexion indisponible</title>" +
    "<h1>Connexion indisponible</h1>" +
    "<p>Ce portail n'a pas de fournisseur d'identité déclaré. Les environnements " +
    "s'ouvrent depuis heig-classroom, par le bouton <em>Démarrer</em> du devoir.</p>"
  );
}

async function authPluginImpl(app: FastifyInstance, opts: AuthPluginOptions): Promise<void> {
  const { config, db } = opts;
  const oidcEnabled = config.OIDC_ISSUER !== "";
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

  /** Without an IdP, redirecting to `/auth/login` would lead to a 404: we say so. */
  const unauthenticated = (req: FastifyRequest, reply: FastifyReply): FastifyReply => {
    if (!oidcEnabled) {
      if (wantsHtml(req)) {
        return reply.code(503).type("text/html; charset=utf-8").send(noIdpPage());
      }
      return reply.code(503).send({ error: "oidc_disabled" });
    }
    if (wantsHtml(req)) return reply.redirect("/auth/login", 303);
    return reply.code(401).send({ error: "unauthenticated" });
  };

  app.decorate("requireUser", async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.user) return undefined;
    return unauthenticated(req, reply);
  });

  app.decorate("requireTeacher", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      return unauthenticated(req, reply);
    }
    if (req.user.role !== ("teacher" satisfies Role)) {
      return reply.code(403).type("text/html; charset=utf-8").send(
        "<!doctype html><html lang=fr><meta charset=utf-8><title>Accès refusé</title>" +
          "<h1>Accès refusé</h1><p>Cette page est réservée aux enseignants.</p>",
      );
    }
    return undefined;
  });

  if (!oidcEnabled) {
    // No login route is registered: 404, rather than a page that would fail
    // further on at `new URL("")`. `/launch` stays whole.
    app.log.warn(
      {},
      "OIDC_ISSUER missing: standalone login disabled (/auth/* answer 404). " +
        "Sessions are opened through classroom's launch token.",
    );
    return;
  }

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
      req.log.warn({ err }, "OIDC exchange refused");
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
    req.log.info({ login: user.login, role: user.role }, "OIDC login accepted");
    return reply.redirect("/", 303);
  });

  // The "dev user selector" of jalon-0: a logout link, Keycloak does the
  // rest.
  app.get("/auth/logout", async (_req, reply) => {
    reply.clearCookie(AUTH_COOKIE, { path: "/" });
    return reply.redirect("/", 303);
  });
}

export const authPlugin = fp(authPluginImpl, { fastify: "5.x", name: "auth" });
