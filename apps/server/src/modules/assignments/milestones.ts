/**
 * Assignment milestones: intermediate review checkpoints. Authoring accepts
 * either an absolute date or a J±n offset in days relative to the deadline
 * (stored alongside the resolved date; lifecycle.ts re-resolves offsets when
 * the deadline moves). The barème stays out of the platform: `name` is the
 * tag matched by criteria.yml `milestone:` entries.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { audit } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { assignmentMilestones } from "../../db/schema.js";
import { publish } from "../../events.js";
import { ownedAssignment, teacherGuard } from "../guards.js";

export const DAY_MS = 86_400_000;

/** Resolved dispatch date of a J±n offset: n days around the deadline. */
export function resolveOffset(deadlineAt: Date, offsetDays: number): Date {
  return new Date(deadlineAt.getTime() + offsetDays * DAY_MS);
}

const MilestoneCreate = z
  .object({
    // criteria.yml tag and `score grade --milestone` argument: keep it
    // shell- and YAML-friendly.
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,49}$/, "lowercase letters, digits, - and _ (max 50)"),
    dueAt: z.coerce.date().optional(),
    // Strictly before the deadline: a milestone firing after the freeze
    // would race the authoritative grade-final review.
    offsetDays: z.number().int().min(-365).max(-1).optional(),
  })
  .refine((b) => (b.dueAt !== undefined) !== (b.offsetDays !== undefined), {
    message: "Provide either dueAt or offsetDays",
  });

function view(m: typeof assignmentMilestones.$inferSelect) {
  return {
    id: m.id,
    name: m.name,
    dueAt: m.dueAt.toISOString(),
    offsetDays: m.offsetDays,
    dispatchedAt: m.dispatchedAt?.toISOString() ?? null,
  };
}

export async function assignmentMilestoneRoutes(
  app: FastifyInstance,
  _opts: { config: AppConfig },
) {
  const requireTeacher = teacherGuard(app);

  app.get(
    "/app/api/classrooms/:id/assignments/:aid/milestones",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedAssignment(app, req, reply);
      if (!owned) return reply;
      const rows = await app.db
        .select()
        .from(assignmentMilestones)
        .where(eq(assignmentMilestones.assignmentId, owned.assignment.id))
        .orderBy(asc(assignmentMilestones.dueAt));
      return rows.map(view);
    },
  );

  app.post(
    "/app/api/classrooms/:id/assignments/:aid/milestones",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedAssignment(app, req, reply);
      if (!owned) return reply;
      const body = MilestoneCreate.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: "validation", issues: body.error.issues });
      }
      const dueAt =
        body.data.offsetDays !== undefined
          ? resolveOffset(owned.assignment.deadlineAt, body.data.offsetDays)
          : body.data.dueAt!;
      // A past date on a LIVE assignment would fire at the next tick:
      // surprising, refuse it. On a draft it is harmless — the ticker never
      // dispatches drafts and offsets are re-resolved at publication.
      if (owned.assignment.state !== "draft" && dueAt.getTime() <= Date.now()) {
        return reply
          .code(400)
          .send({ error: "due_past", message: "The milestone date is in the past" });
      }
      if (dueAt.getTime() >= owned.assignment.deadlineAt.getTime()) {
        return reply.code(400).send({
          error: "due_after_deadline",
          message: "A milestone must be before the deadline",
        });
      }
      const [row] = await app.db
        .insert(assignmentMilestones)
        .values({
          id: randomUUID(),
          assignmentId: owned.assignment.id,
          name: body.data.name,
          dueAt,
          offsetDays: body.data.offsetDays ?? null,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) {
        return reply.code(409).send({
          error: "duplicate_name",
          message: `A milestone “${body.data.name}” already exists on this assignment`,
        });
      }
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "milestone.create",
        subjectType: "assignment",
        subjectId: owned.assignment.id,
        payload: { name: row.name, dueAt: row.dueAt, offsetDays: row.offsetDays },
      });
      publish("assignments", [`classroom:${owned.assignment.classroomId}`]);
      return reply.code(201).send(view(row));
    },
  );

  app.delete(
    "/app/api/classrooms/:id/assignments/:aid/milestones/:mid",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const owned = await ownedAssignment(app, req, reply);
      if (!owned) return reply;
      const params = z.object({ mid: z.uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const [gone] = await app.db
        .delete(assignmentMilestones)
        .where(
          and(
            eq(assignmentMilestones.id, params.data.mid),
            eq(assignmentMilestones.assignmentId, owned.assignment.id),
          ),
        )
        .returning();
      if (!gone) return reply.code(404).send({ error: "not_found" });
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "milestone.delete",
        subjectType: "assignment",
        subjectId: owned.assignment.id,
        payload: { name: gone.name, dispatched: gone.dispatchedAt !== null },
      });
      publish("assignments", [`classroom:${owned.assignment.classroomId}`]);
      return reply.code(204).send();
    },
  );
}
