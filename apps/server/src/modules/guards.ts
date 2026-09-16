/**
 * Route guards and access loaders shared by the API modules.
 *
 * Guards are preHandler factories (bound to the Fastify instance once per
 * plugin). Access loaders implement the single authorization motif of the
 * teacher API: load the entity if and only if the current user has access to
 * its classroom, otherwise reply 404 and return null (indistinguishable from
 * a missing entity, AU-23/24).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  assignments,
  classroomStaff,
  classrooms,
  enrollments,
  organizations,
  studentRepos,
} from "../db/schema.js";

const IdParam = z.object({ id: z.uuid() });
const AssignmentParam = z.object({ id: z.uuid(), aid: z.uuid() });
const RepoParam = z.object({ id: z.uuid(), aid: z.uuid(), rid: z.uuid() });

/**
 * THE access predicate (GH-9), on a query that has `classrooms` in scope:
 * the owner (creator) of the classroom, or any member of its staff. Teachers
 * and assistants are the same thing here — the `role` column is a label, not
 * a permission level (YAGNI, see db/schema.ts).
 *
 * Every loader below, the classroom listing and the SSE topics go through
 * it: one predicate, one definition of "who may work in this classroom".
 */
export function staffAccess(userId: string): SQL {
  return or(
    eq(classrooms.teacherId, userId),
    sql`EXISTS (SELECT 1 FROM ${classroomStaff} WHERE ${classroomStaff.classroomId} = ${classrooms.id} AND ${classroomStaff.userId} = ${userId})`,
  )!;
}

/**
 * Owner-only operations (staff management, archive, delete): everything else
 * in a classroom is open to the whole staff. An admin acting on a classroom
 * they can already reach counts as the owner.
 */
export function isOwner(req: FastifyRequest, room: { teacherId: string }): boolean {
  return room.teacherId === req.user!.id || req.user!.role === "admin";
}

/** Teacher only (AU-23/24); admins pass too. */
export function teacherGuard(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const denied = await app.requireSession(req, reply);
    if (denied) return denied;
    if (req.user!.role !== "teacher" && req.user!.role !== "admin") {
      return reply.code(403).send({ error: "forbidden" });
    }
    return undefined;
  };
}

/** Super admin only (H2 revision, 2026-07-07). */
export function adminGuard(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const denied = await app.requireSession(req, reply);
    if (denied) return denied;
    if (req.user!.role !== "admin") return reply.code(403).send({ error: "forbidden" });
    return undefined;
  };
}

async function notFound(reply: FastifyReply): Promise<null> {
  await reply.code(404).send({ error: "not_found" });
  return null;
}

/** Loads the classroom if and only if the current user is on its staff. */
export async function accessibleClassroom(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const params = IdParam.safeParse(req.params);
  if (!params.success) return notFound(reply);
  const [room] = await app.db
    .select()
    .from(classrooms)
    .where(and(eq(classrooms.id, params.data.id), staffAccess(req.user!.id)))
    .limit(1);
  if (!room) return notFound(reply);
  return room;
}

/** Classroom + organization, if and only if the current user is on its staff. */
export async function accessibleClassroomWithOrg(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const params = IdParam.safeParse(req.params);
  if (!params.success) return notFound(reply);
  const [row] = await app.db
    .select({ room: classrooms, org: organizations })
    .from(classrooms)
    .innerJoin(organizations, eq(classrooms.orgId, organizations.id))
    .where(and(eq(classrooms.id, params.data.id), staffAccess(req.user!.id)))
    .limit(1);
  if (!row) return notFound(reply);
  return row;
}

/** Loads the assignment if the current user is on its classroom's staff. */
export async function accessibleAssignment(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const params = AssignmentParam.safeParse(req.params);
  if (!params.success) return notFound(reply);
  const [row] = await app.db
    .select({
      assignment: assignments,
      classroomName: classrooms.name,
      org: organizations,
    })
    .from(assignments)
    .innerJoin(classrooms, eq(assignments.classroomId, classrooms.id))
    .innerJoin(organizations, eq(classrooms.orgId, organizations.id))
    .where(
      and(
        eq(assignments.id, params.data.aid),
        eq(assignments.classroomId, params.data.id),
        staffAccess(req.user!.id),
      ),
    )
    .limit(1);
  if (!row) return notFound(reply);
  return row;
}

/** Accessible assignment + a provisioned student repository of it. */
export async function accessibleStudentRepo(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const scope = await accessibleAssignment(app, req, reply);
  if (!scope) return null;
  const params = RepoParam.safeParse(req.params);
  if (!params.success) return notFound(reply);
  const [repo] = await app.db
    .select()
    .from(studentRepos)
    .where(
      and(eq(studentRepos.id, params.data.rid), eq(studentRepos.assignmentId, scope.assignment.id)),
    )
    .limit(1);
  if (!repo || repo.provisionStatus !== "ok" || !repo.fullName) return notFound(reply);
  return { ...scope, repo };
}

const EnrollmentParam = z.object({ id: z.uuid(), eid: z.uuid() });

/** Loads the roster entry if the current user is on the classroom's staff. */
export async function accessibleEnrollment(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const params = EnrollmentParam.safeParse(req.params);
  if (!params.success) return notFound(reply);
  const [row] = await app.db
    .select({ enrollment: enrollments })
    .from(enrollments)
    .innerJoin(classrooms, eq(enrollments.classroomId, classrooms.id))
    .where(
      and(
        eq(enrollments.id, params.data.eid),
        eq(enrollments.classroomId, params.data.id),
        staffAccess(req.user!.id),
      ),
    )
    .limit(1);
  if (!row) return notFound(reply);
  return row.enrollment;
}
