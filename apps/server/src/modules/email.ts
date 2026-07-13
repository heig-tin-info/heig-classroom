/**
 * Email-related HTTP surface: the one-click unsubscribe endpoint. Reached
 * from an email client, so no session — authenticity comes from the HMAC
 * signature embedded in every message (mailer.ts).
 */
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import { users } from "../db/schema.js";
import { isEmailKind } from "@hgc/contracts";

import { verifyUnsubSignature } from "../mailer.js";

const UnsubQuery = z.object({ u: z.uuid(), k: z.string(), s: z.string() });

export async function emailPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;

  app.get("/app/email/unsub", async (req, reply) => {
    const q = UnsubQuery.safeParse(req.query);
    if (
      !q.success ||
      !isEmailKind(q.data.k) ||
      !verifyUnsubSignature(config, q.data.u, q.data.k, q.data.s)
    ) {
      return reply.code(400).type("text/html").send("<p>Invalid unsubscribe link.</p>");
    }
    const { u, k } = q.data;
    // jsonb merge: only this kind flips, other preferences are untouched.
    await app.db
      .update(users)
      .set({
        emailPrefs: sql`coalesce(${users.emailPrefs}, '{}'::jsonb) || ${JSON.stringify({ [k]: false })}::jsonb`,
      })
      .where(eq(users.id, u));
    await audit(app.db, {
      actorUserId: u,
      actorType: "user",
      action: "email.unsubscribe",
      subjectType: "user",
      subjectId: u,
      payload: { kind: k },
    });
    return reply
      .type("text/html")
      .send(
        `<!doctype html><meta charset="utf-8"><title>HEIG Classroom</title>
<div style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;text-align:center">
<h2>HEIG Classroom</h2>
<p>You will no longer receive “${k}” emails.<br>Vous ne recevrez plus les e-mails « ${k} ».</p>
<p><a href="${config.PUBLIC_URL}">Settings / Réglages</a></p></div>`,
      );
  });
}
