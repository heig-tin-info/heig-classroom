import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { audit } from "../audit.js";
import { avatars } from "../db/schema.js";

const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 1_000_000; // recadré 256×256 côté client : ~30-80 Ko en pratique

/**
 * Avatar téléversé (recadré côté client, aperçu circulaire). Prioritaire sur
 * le claim OIDC `picture` ; supprimable pour y revenir.
 */
export async function avatarPlugin(app: FastifyInstance) {
  app.put(
    "/app/api/me/avatar",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const contentType = req.headers["content-type"] ?? "";
      if (!ACCEPTED.has(contentType)) {
        return reply
          .code(415)
          .send({ error: "unsupported_type", message: "Expected JPEG, PNG or WebP" });
      }
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: "empty_body", message: "Image body expected" });
      }
      if (body.length > MAX_BYTES) {
        return reply.code(413).send({ error: "too_large", message: "Image exceeds 1 MB" });
      }
      await app.db
        .insert(avatars)
        .values({ userId: req.user!.id, data: body, contentType, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: avatars.userId,
          set: { data: body, contentType, updatedAt: new Date() },
        });
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "avatar.update",
        subjectType: "user",
        subjectId: req.user!.id,
        payload: { bytes: body.length, contentType },
      });
      return reply.code(204).send();
    },
  );

  app.delete(
    "/app/api/me/avatar",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      await app.db.delete(avatars).where(eq(avatars.userId, req.user!.id));
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "avatar.delete",
        subjectType: "user",
        subjectId: req.user!.id,
      });
      return reply.code(204).send();
    },
  );

  const UserParam = z.object({ uid: z.uuid() });

  app.get(
    "/app/api/users/:uid/avatar",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const params = UserParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const [row] = await app.db
        .select()
        .from(avatars)
        .where(eq(avatars.userId, params.data.uid))
        .limit(1);
      if (!row) return reply.code(404).send({ error: "not_found" });
      return reply
        .type(row.contentType)
        .header("cache-control", "private, max-age=86400")
        .send(row.data);
    },
  );
}
