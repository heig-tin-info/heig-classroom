/**
 * GitHub account linking (AU-08..12): a web application OAuth flow distinct
 * from the edu-ID login, minimal `read:user` scope. The OAuth token is
 * DISCARDED after reading the identity; only github_user_id (immutable key),
 * github_login (display) and github_linked_at are stored (NFR-02, C-06).
 */
import { randomBytes } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { audit } from "../audit.js";
import { publish } from "../events.js";
import type { AppConfig } from "../config.js";
import { enrollments, users } from "../db/schema.js";

const STATE_COOKIE = "hgc_ghlink";

interface GithubUser {
  id: number;
  login: string;
}

async function fetchGithubIdentity(
  config: AppConfig,
  code: string,
): Promise<GithubUser> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.GITHUB_OAUTH_CLIENT_ID,
      client_secret: config.GITHUB_OAUTH_CLIENT_SECRET,
      code,
    }),
  });
  const tokenBody = (await tokenRes.json()) as { access_token?: string };
  if (!tokenRes.ok || !tokenBody.access_token) {
    throw new Error("GitHub OAuth code exchange rejected");
  }
  try {
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${tokenBody.access_token}`,
        accept: "application/vnd.github+json",
        "user-agent": "hgc-server",
      },
    });
    if (!userRes.ok) throw new Error(`GET /user: ${userRes.status}`);
    const u = (await userRes.json()) as GithubUser;
    return { id: u.id, login: u.login };
  } finally {
    // AU-09: the token is neither persisted nor reused. Revoking the grant
    // is possible later; here it simply goes out of scope.
  }
}

export async function githubLinkPlugin(
  app: FastifyInstance,
  opts: { config: AppConfig },
) {
  const { config } = opts;
  const secure = config.NODE_ENV === "production";
  const redirectUri = new URL("/app/auth/github/callback", config.PUBLIC_URL).href;

  app.get(
    "/app/auth/github/link",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (_req, reply) => {
      if (!config.GITHUB_OAUTH_CLIENT_ID) {
        return reply
          .code(503)
          .send({ error: "github_oauth_unconfigured", message: "OAuth App not configured" });
      }
      const state = randomBytes(16).toString("base64url");
      reply.setCookie(STATE_COOKIE, state, {
        path: "/app/auth/github",
        httpOnly: true,
        sameSite: "lax",
        secure,
        signed: true,
        maxAge: 600,
      });
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", config.GITHUB_OAUTH_CLIENT_ID);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", "read:user");
      url.searchParams.set("state", state);
      return reply.redirect(url.href, 303);
    },
  );

  app.get(
    "/app/auth/github/callback",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const q = req.query as { code?: string; state?: string };
      const raw = req.cookies[STATE_COOKIE];
      const unsigned = raw ? req.unsignCookie(raw) : { valid: false as const, value: null };
      reply.clearCookie(STATE_COOKIE, { path: "/app/auth/github" });
      if (!q.code || !q.state || !unsigned.valid || unsigned.value !== q.state) {
        return reply.code(400).send({ error: "github_state", message: "Invalid state" });
      }

      let gh: GithubUser;
      try {
        gh = await fetchGithubIdentity(config, q.code);
      } catch (err) {
        req.log.warn({ err }, "GitHub linking rejected");
        return reply.redirect("/?github=error", 303);
      }

      try {
        await app.db
          .update(users)
          .set({
            githubUserId: gh.id,
            githubLogin: gh.login,
            githubLinkedAt: new Date(),
          })
          .where(eq(users.id, req.user!.id));
      } catch {
        // AU-10: github_user_id is UNIQUE, already linked to another local account.
        return reply.redirect("/?github=conflict", 303);
      }
      const rooms = await app.db
        .select({ id: enrollments.classroomId })
        .from(enrollments)
        .where(eq(enrollments.userId, req.user!.id));
      publish("github", [
        `user:${req.user!.id}`,
        ...rooms.map((r) => `classroom:${r.id}`),
      ]);
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "github.link",
        subjectType: "user",
        subjectId: req.user!.id,
        payload: { githubUserId: gh.id, githubLogin: gh.login },
      });
      return reply.redirect("/?github=linked", 303);
    },
  );

  app.post(
    "/app/auth/github/unlink",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      await app.db
        .update(users)
        .set({ githubUserId: null, githubLogin: null, githubLinkedAt: null })
        .where(eq(users.id, req.user!.id));
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "github.unlink",
        subjectType: "user",
        subjectId: req.user!.id,
      });
      return reply.code(204).send();
    },
  );
}
