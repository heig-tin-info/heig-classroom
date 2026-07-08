import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";

import { classrooms, enrollments } from "../db/schema.js";
import { subscribe } from "../events.js";

/**
 * SSE stream (ADR-005): unidirectional, session cookies reused,
 * `:ping` heartbeat every 25 s, no replay; on (re)connection the client
 * re-issues its requests. Filtering is done via topics computed at
 * connection time based on the role; events carry no data.
 */
export async function eventsPlugin(app: FastifyInstance) {
  app.get(
    "/app/events",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const me = req.user!;
      const topics = new Set<string>([`user:${me.id}`]);
      if (me.role === "teacher" || me.role === "admin") {
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
        // Caddy/nginx: do not buffer this stream (docs/03, flush_interval -1).
        "x-accel-buffering": "no",
      });
      res.write(":connected\n\n");

      const unsubscribe = subscribe((e) => {
        if (e.topics.some((t) => topics.has(t))) {
          res.write(`data: ${JSON.stringify({ type: e.type, notice: e.notice ?? null })}\n\n`);
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
