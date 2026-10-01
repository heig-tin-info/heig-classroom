import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { classroomNotificationPrefs, classrooms, enrollments } from "../db/schema.js";
import { type Audience, noticeFor, reaches, subscribe } from "../events.js";
import { staffAccess } from "./guards.js";

/**
 * Topics of one SSE connection (issue #46). The relationship to each
 * classroom decides, not the global role:
 * - `classroom-staff:<id>` for every non-archived classroom the user is staff
 *   of (same predicate as the guards: owner or `classroom_staff` row, GH-9);
 * - `classroom:<id>` for every claimed enrollment in a classroom the user is
 *   NOT staff of. A teacher's self-enrolled seat (`enrollments.staff`) in
 *   their own classroom adds nothing: they are staff there, and their own
 *   repository reaches them on `user:<me>` anyway.
 *
 * `studentActivity` lists the staff classrooms whose student toasts the user
 * wants: the stored preference, else on for the owner and off for co-staff.
 */
export async function connectionAudience(
  db: Db,
  me: { id: string; role: string },
): Promise<Audience> {
  const topics = new Set<string>([`user:${me.id}`]);
  const studentActivity = new Set<string>();
  if (me.role === "teacher" || me.role === "admin") topics.add(`teacher:${me.id}`);

  const staffRooms = await db
    .select({
      id: classrooms.id,
      teacherId: classrooms.teacherId,
      pref: classroomNotificationPrefs.studentActivity,
    })
    .from(classrooms)
    .leftJoin(
      classroomNotificationPrefs,
      and(
        eq(classroomNotificationPrefs.classroomId, classrooms.id),
        eq(classroomNotificationPrefs.userId, me.id),
      ),
    )
    .where(and(staffAccess(me.id), isNull(classrooms.archivedAt)));
  const staffOf = new Set<string>();
  for (const r of staffRooms) {
    staffOf.add(r.id);
    topics.add(`classroom-staff:${r.id}`);
    if (r.pref ?? (r.teacherId === me.id)) studentActivity.add(r.id);
  }

  const seats = await db
    .select({ id: enrollments.classroomId })
    .from(enrollments)
    .where(and(eq(enrollments.userId, me.id), eq(enrollments.status, "claimed")));
  for (const s of seats) if (!staffOf.has(s.id)) topics.add(`classroom:${s.id}`);

  return { topics, studentActivity };
}

/**
 * SSE stream (ADR-005): unidirectional, session cookies reused,
 * `:ping` heartbeat every 25 s, no replay; on (re)connection the client
 * re-issues its requests. Filtering is done via topics computed at
 * connection time (connectionAudience); events carry no data. A `topics`
 * hint ends the stream so that the client reconnects with its topics
 * recomputed (issue #46: removed staff, roster changes).
 */
export async function eventsPlugin(app: FastifyInstance) {
  app.get(
    "/app/events",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const audience = await connectionAudience(app.db, req.user!);

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        // Caddy/nginx: do not buffer this stream (docs/03, flush_interval -1).
        "x-accel-buffering": "no",
      });
      // Reconnect quickly when the server ends the stream (`topics` hint).
      res.write("retry: 1000\n:connected\n\n");

      let closed = false;
      const ping = setInterval(() => res.write(":ping\n\n"), 25_000);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        unsubscribe();
      };
      const unsubscribe = subscribe((e) => {
        if (closed || !reaches(e, audience)) return;
        const notice = noticeFor(e, audience);
        res.write(`data: ${JSON.stringify({ type: e.type, notice })}\n\n`);
        if (e.type === "topics") {
          close();
          res.end();
        }
      });

      req.raw.on("close", close);
    },
  );
}
