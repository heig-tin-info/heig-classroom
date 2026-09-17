import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { eq } from "drizzle-orm";

import { audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import { avatars, users } from "../db/schema.js";
import { isDateFormat, isEmailKind, type DateFormat } from "@hgc/contracts";

import { codespaceGrantFor, codespaceHost } from "../codespace.js";
import { resolvedPrefs } from "../mailer.js";
import { claimEnrollments } from "../modules/roster.js";
import { claimStaffSeats } from "../modules/staff.js";
import { roleForIdentity } from "../roles.js";
import { addressesOf, affiliationsOf, recordIdpClaims, syncUserEmails } from "./claims.js";
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
 * User upsert at login (key: oidc_sub). The role is recomputed on every
 * login through the single rule of roles.ts (grant or classroom staff).
 */
async function upsertUser(
  app: FastifyInstance,
  config: AppConfig,
  claims: OidcClaims,
): Promise<SessionUser> {
  // GH-11: the role is computed on every address the IdP revealed, and on
  // the affiliations it asserts — a grant issued on an institutional address
  // must reach someone signing in under a private one.
  const role = await roleForIdentity(app.db, config, {
    emails: addressesOf(claims.raw).map((a) => a.email),
    affiliations: affiliationsOf(claims.raw),
  });
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
      pictureUrl: claims.picture,
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
        pictureUrl: claims.picture,
        role,
        lastLoginAt: now,
      },
    })
    .returning();
  if (!row) throw new Error("User upsert returned no row");
  return row;
}

async function authPluginImpl(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const provider = new OidcProvider(config, app.log);
  const secure = config.NODE_ENV === "production";

  // --- Session resolution on every request ---
  app.decorateRequest("user", null);
  app.addHook("preHandler", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    // A database failure here propagates on purpose: a lookup that cannot run
    // is an outage, not an anonymous visitor. Falling back to "anonymous"
    // would sign every teacher out mid-flow, turn our 5xx into 401 (the error
    // rate would look clean while the site is down) and invite a re-login
    // storm on the very database that is already struggling. The global error
    // handler answers a generic 500 and logs the cause.
    const found = await findSessionUser(app.db, token, {
      renewTtlHours: config.SESSION_TTL_HOURS,
    });
    if (!found) return;
    req.user = found.user;
    // Mirror the sliding renewal on the cookies, else the browser drops them
    // while the server-side session is still alive.
    if (found.renewedTo) {
      const base = { path: "/", sameSite: "lax", secure } as const;
      reply.setCookie(SESSION_COOKIE, token, {
        ...base,
        httpOnly: true,
        expires: found.renewedTo,
      });
      const csrf = req.cookies[CSRF_COOKIE];
      if (csrf) {
        reply.setCookie(CSRF_COOKIE, csrf, { ...base, httpOnly: false, expires: found.renewedTo });
      }
    }
  });

  // --- Reusable guards ---
  app.decorate(
    "requireSession",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
      // Double-submit anti-CSRF (docs/03 « Contrat API ») on every mutation.
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
  /**
   * Where to land after the login round trip. Only a same-origin, absolute
   * PATH is accepted ("/app/codespace/start/…"): anything else — a full URL,
   * a protocol-relative "//evil.example" — falls back to the home page, so
   * the parameter can never become an open redirect.
   */
  function safeReturnTo(raw: unknown): string {
    if (typeof raw !== "string") return "/";
    if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
    return raw;
  }

  app.get("/app/auth/login", async (req, reply) => {
    const { url, codeVerifier, state, nonce } = await provider.beginLogin();
    const returnTo = safeReturnTo((req.query as { returnTo?: unknown }).returnTo);
    reply.setCookie(LOGIN_STASH_COOKIE, JSON.stringify({ codeVerifier, state, nonce, returnTo }), {
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
      returnTo?: string;
    };
    reply.clearCookie(LOGIN_STASH_COOKIE, { path: "/app/auth" });

    const callbackUrl = new URL(req.raw.url ?? "", config.PUBLIC_URL);
    let claims: OidcClaims;
    try {
      claims = await provider.completeLogin(callbackUrl, stash);
    } catch (err) {
      req.log.warn({ err }, "OIDC exchange failed");
      return reply.code(401).send({ error: "oidc", message: "Authentication refused" });
    }

    const user = await upsertUser(app, config, claims);
    // Snapshot of what the IdP released (GH-11): diagnostic material, and
    // never a reason to refuse a session.
    try {
      await recordIdpClaims(app.db, user.id, claims.raw);
    } catch (err) {
      req.log.warn({ err }, "Could not record the IdP claims");
    }
    // The address set, on the other hand, IS load-bearing: the roster and
    // staff matching below read it, so a failure here must surface.
    await syncUserEmails(app.db, user.id, claims.raw, claims.emailVerified);
    // Automatic roster claim on verified email (AU-18, H3); staff seats
    // invited by e-mail (GH-9) are attached under the same condition.
    if (claims.emailVerified) {
      await claimEnrollments(app.db, { id: user.id });
      await claimStaffSeats(app.db, { id: user.id });
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
    // Readable by the frontend for the X-CSRF-Token header (double-submit).
    reply.setCookie(CSRF_COOKIE, session.csrf, {
      ...cookieBase,
      httpOnly: false,
      expires: session.expiresAt,
    });
    // Deep link the user asked for before signing in (the student Start
    // button of ADR-013 goes through here), re-validated after the cookie
    // round trip.
    return reply.redirect(safeReturnTo(stash.returnTo), 303);
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
      // Uploaded avatar takes priority over the IdP claim; ?v= busts the cache.
      const [uploaded] = await app.db
        .select({ updatedAt: avatars.updatedAt })
        .from(avatars)
        .where(eq(avatars.userId, u.id))
        .limit(1);
      const avatarUrl = uploaded
        ? `/app/api/users/${u.id}/avatar?v=${uploaded.updatedAt.getTime()}`
        : u.pictureUrl;
      return {
        id: u.id,
        email: u.email,
        givenName: u.givenName,
        familyName: u.familyName,
        role: u.role,
        githubLogin: u.githubLogin,
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        avatarUrl,
        hasUploadedAvatar: Boolean(uploaded),
        locale: u.locale,
        dateFormat: u.dateFormat,
        emailPrefs: resolvedPrefs(u.emailPrefs),
        // ADR-013: the single place the front learns whether the online
        // workspace exists at all (null) and whether this account may pick
        // it. Every write path re-checks server-side.
        codespace: await codespaceGrantFor(app.db, config, u),
        codespaceHost: codespaceHost(config),
      };
    },
  );

  // Account preferences persisted server-side: interface language and
  // per-kind email opt-outs, so they follow the user across devices.
  app.patch(
    "/app/api/me",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const body = req.body as { locale?: unknown; dateFormat?: unknown; emailPrefs?: unknown };
      const patch: Partial<{
        locale: "en" | "fr" | null;
        dateFormat: DateFormat | null;
        emailPrefs: Record<string, boolean>;
      }> = {};
      if ("locale" in (body ?? {})) {
        const locale = body.locale;
        if (locale !== "en" && locale !== "fr" && locale !== null) {
          return reply.code(400).send({ error: "validation", message: "Unsupported locale" });
        }
        patch.locale = locale;
      }
      if ("dateFormat" in (body ?? {})) {
        const dateFormat = body.dateFormat;
        if (dateFormat !== null && !isDateFormat(dateFormat)) {
          return reply.code(400).send({ error: "validation", message: "Unsupported date format" });
        }
        patch.dateFormat = dateFormat;
      }
      if ("emailPrefs" in (body ?? {})) {
        const prefs = body.emailPrefs;
        if (
          typeof prefs !== "object" ||
          prefs === null ||
          Object.entries(prefs).some(([k, v]) => !isEmailKind(k) || typeof v !== "boolean")
        ) {
          return reply.code(400).send({ error: "validation", message: "Bad email preferences" });
        }
        // Merge over the stored map: partial toggles never reset the others.
        patch.emailPrefs = {
          ...(req.user!.emailPrefs ?? {}),
          ...(prefs as Record<string, boolean>),
        };
      }
      if (Object.keys(patch).length === 0) {
        return reply.code(400).send({ error: "validation", message: "Nothing to update" });
      }
      await app.db.update(users).set(patch).where(eq(users.id, req.user!.id));
      return {
        locale: patch.locale ?? req.user!.locale,
        dateFormat: patch.dateFormat ?? req.user!.dateFormat,
        emailPrefs: resolvedPrefs(patch.emailPrefs ?? req.user!.emailPrefs),
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

/** fastify-plugin: the decorators (request.user, requireSession) must be
 *  visible to the other plugins; without fp they would stay encapsulated here. */
export const authPlugin = fp(authPluginImpl, { name: "auth" });
