import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";

import { classrooms, enrollments } from "../db/schema.js";
import { subscribe } from "../events.js";

/**
 * Flux SSE (ADR-005) : unidirectionnel, cookies de session réutilisés,
 * heartbeat `:ping` 25 s, pas de replay — à la (re)connexion le client
 * refait ses requêtes. Le filtrage se fait par topics calculés à la
 * connexion selon le rôle ; les événements ne portent aucune donnée.
 */
export async function eventsPlugin(app: FastifyInstance) {
  app.get(
    "/app/events",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const me = req.user!;
      const topics = new Set<string>([`user:${me.id}`]);
      if (me.role === "teacher") {
        topics.add(`teacher:${me.id}`);
        const rooms = await app.db
          .select({ id: classrooms.id })
          .from(classrooms)
          .where(eq(classrooms.teacherId, me.id));
        for (const r of rooms) topics.add(`classroom:${r.id}`);
      } else {
        const rooms = await app.db
          .select({ id: enrollments.classroomId })
          .from(enrollments)
          .where(and(eq(enrollments.userId, me.id), eq(enrollments.status, "claimed")));
        for (const r of rooms) topics.add(`classroom:${r.id}`);
      }

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        // Caddy/nginx : ne pas bufferiser ce flux (docs/03, flush_interval -1).
        "x-accel-buffering": "no",
      });
      res.write(":connected\n\n");

      const unsubscribe = subscribe((e) => {
        if (e.topics.some((t) => topics.has(t))) {
          res.write(`data: ${JSON.stringify({ type: e.type })}\n\n`);
        }
      });
      const ping = setInterval(() => res.write(":ping\n\n"), 25_000);

      req.raw.on("close", () => {
        clearInterval(ping);
        unsubscribe();
      });
    },
  );
}
