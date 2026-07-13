/**
 * Route guards and ownership loaders shared by the API modules.
 *
 * Guards are preHandler factories (bound to the Fastify instance once per
 * plugin). Ownership loaders implement the single authorization motif of the
 * teacher API: load the entity if and only if it belongs to the current
 * teacher, otherwise reply 404 and return null (indistinguishable from a
 * missing entity, AU-23/24).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { assignments, classrooms, enrollments, organizations, studentRepos } from "../db/schema.js";

const IdParam = z.object({ id: z.uuid() });
const AssignmentParam = z.object({ id: z.uuid(), aid: z.uuid() });
const RepoParam = z.object({ id: z.uuid(), aid: z.uuid(), rid: z.uuid() });

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

/** Loads the classroom if and only if it belongs to the current teacher. */
export async function ownedClassroom(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const params = IdParam.safeParse(req.params);
  if (!params.success) return notFound(reply);
  const [room] = await app.db
    .select()
    .from(classrooms)
    .where(and(eq(classrooms.id, params.data.id), eq(classrooms.teacherId, req.user!.id)))
    .limit(1);
  if (!room) return notFound(reply);
  return room;
}

/** Classroom + organization, if and only if the teacher owns it. */
export async function ownedClassroomWithOrg(
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
    .where(and(eq(classrooms.id, params.data.id), eq(classrooms.teacherId, req.user!.id)))
    .limit(1);
  if (!row) return notFound(reply);
  return row;
}

/** Loads the assignment if its classroom belongs to the current teacher. */
export async function ownedAssignment(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const params = AssignmentParam.safeParse(req.params);
  if (!params.success) return notFound(reply);
  const [row] = await app.db
    .select({
      assignment: assignments,
      teacherId: classrooms.teacherId,
      classroomName: classrooms.name,
      org: organizations,
    })
    .from(assignments)
    .innerJoin(classrooms, eq(assignments.classroomId, classrooms.id))
    .innerJoin(organizations, eq(classrooms.orgId, organizations.id))
    .where(and(eq(assignments.id, params.data.aid), eq(assignments.classroomId, params.data.id)))
    .limit(1);
  if (!row || row.teacherId !== req.user!.id) return notFound(reply);
  return row;
}

/** Owned assignment + a provisioned student repository of it. */
export async function ownedStudentRepo(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const owned = await ownedAssignment(app, req, reply);
  if (!owned) return null;
  const params = RepoParam.safeParse(req.params);
  if (!params.success) return notFound(reply);
  const [repo] = await app.db
    .select()
    .from(studentRepos)
    .where(
      and(eq(studentRepos.id, params.data.rid), eq(studentRepos.assignmentId, owned.assignment.id)),
    )
    .limit(1);
  if (!repo || repo.provisionStatus !== "ok" || !repo.fullName) return notFound(reply);
  return { ...owned, repo };
}

const EnrollmentParam = z.object({ id: z.uuid(), eid: z.uuid() });

/** Loads the roster entry if the classroom belongs to the current teacher. */
export async function ownedEnrollment(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const params = EnrollmentParam.safeParse(req.params);
  if (!params.success) return notFound(reply);
  const [row] = await app.db
    .select({ enrollment: enrollments, teacherId: classrooms.teacherId })
    .from(enrollments)
    .innerJoin(classrooms, eq(enrollments.classroomId, classrooms.id))
    .where(and(eq(enrollments.id, params.data.eid), eq(enrollments.classroomId, params.data.id)))
    .limit(1);
  if (!row || row.teacherId !== req.user!.id) return notFound(reply);
  return row.enrollment;
}
