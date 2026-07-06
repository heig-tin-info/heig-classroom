import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ClassroomCreate } from "@hgc/contracts";
import type { Cell } from "@hgc/domain";

import { audit } from "../audit.js";
import { classrooms, enrollments, organizations } from "../db/schema.js";
import { importRoster, rosterView } from "./roster.js";

const IdParam = z.object({ id: z.uuid() });

const RowsBody = z.object({
  rows: z
    .array(z.array(z.union([z.string(), z.number(), z.null()])))
    .min(1)
    .max(5000),
});

async function getOrCreateOrganization(app: FastifyInstance, login: string) {
  const normalized = login.trim();
  const [existing] = await app.db
    .select()
    .from(organizations)
    .where(sql`lower(${organizations.login}) = ${normalized.toLowerCase()}`)
    .limit(1);
  if (existing) return existing;
  const [created] = await app.db
    .insert(organizations)
    .values({ id: randomUUID(), login: normalized })
    .onConflictDoNothing({ target: organizations.login })
    .returning();
  if (created) return created;
  // Course perdue : l'autre écrivain vient de la créer.
  const [row] = await app.db
    .select()
    .from(organizations)
    .where(eq(organizations.login, normalized))
    .limit(1);
  if (!row) throw new Error("Organisation introuvable après upsert");
  return row;
}

export async function classroomsPlugin(app: FastifyInstance) {
  /** Teacher uniquement (AU-23/24) ; 404 pour tout ce qui n'est pas à lui. */
  const requireTeacher = async (req: FastifyRequest, reply: FastifyReply) => {
    const denied = await app.requireSession(req, reply);
    if (denied) return denied;
    if (req.user!.role !== "teacher") return reply.code(403).send({ error: "forbidden" });
    return undefined;
  };

  /** Charge la classroom si et seulement si elle appartient au teacher courant. */
  async function ownedClassroom(req: FastifyRequest, reply: FastifyReply) {
    const params = IdParam.safeParse(req.params);
    if (!params.success) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    const [room] = await app.db
      .select()
      .from(classrooms)
      .where(and(eq(classrooms.id, params.data.id), eq(classrooms.teacherId, req.user!.id)))
      .limit(1);
    if (!room) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    return room;
  }

  app.get("/app/api/classrooms", { preHandler: requireTeacher }, async (req) => {
    return app.db
      .select({
        id: classrooms.id,
        name: classrooms.name,
        orgLogin: organizations.login,
        createdAt: classrooms.createdAt,
        students: sql<number>`count(${enrollments.id})::int`,
        claimed: sql<number>`count(${enrollments.id}) filter (where ${enrollments.status} = 'claimed')::int`,
      })
      .from(classrooms)
      .innerJoin(organizations, eq(classrooms.orgId, organizations.id))
      .leftJoin(enrollments, eq(enrollments.classroomId, classrooms.id))
      .where(eq(classrooms.teacherId, req.user!.id))
      .groupBy(classrooms.id, organizations.login)
      .orderBy(classrooms.createdAt);
  });

  app.post("/app/api/classrooms", { preHandler: requireTeacher }, async (req, reply) => {
    const body = ClassroomCreate.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "validation", issues: body.error.issues });
    }
    const org = await getOrCreateOrganization(app, body.data.orgLogin);
    const [room] = await app.db
      .insert(classrooms)
      .values({
        id: randomUUID(),
        orgId: org.id,
        teacherId: req.user!.id,
        name: body.data.name,
      })
      .returning();
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "classroom.create",
      subjectType: "classroom",
      subjectId: room!.id,
      payload: { name: body.data.name, org: org.login },
    });
    return reply.code(201).send({ ...room, orgLogin: org.login });
  });

  app.get("/app/api/classrooms/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const room = await ownedClassroom(req, reply);
    if (!room) return reply;
    const [org] = await app.db
      .select({ login: organizations.login, installationId: organizations.installationId })
      .from(organizations)
      .where(eq(organizations.id, room.orgId))
      .limit(1);
    const roster = await rosterView(app.db, room.id);
    return { ...room, org, roster };
  });

  app.patch("/app/api/classrooms/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const room = await ownedClassroom(req, reply);
    if (!room) return reply;
    const body = z.object({ name: z.string().min(1).max(200) }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "validation", issues: body.error.issues });
    }
    const [updated] = await app.db
      .update(classrooms)
      .set({ name: body.data.name })
      .where(eq(classrooms.id, room.id))
      .returning();
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "classroom.rename",
      subjectType: "classroom",
      subjectId: room.id,
      payload: { from: room.name, to: body.data.name },
    });
    return updated;
  });

  app.delete("/app/api/classrooms/:id", { preHandler: requireTeacher }, async (req, reply) => {
    const room = await ownedClassroom(req, reply);
    if (!room) return reply;
    await app.db.delete(classrooms).where(eq(classrooms.id, room.id));
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "classroom.delete",
      subjectType: "classroom",
      subjectId: room.id,
      payload: { name: room.name },
    });
    return reply.code(204).send();
  });

  app.post(
    "/app/api/classrooms/:id/roster",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const room = await ownedClassroom(req, reply);
      if (!room) return reply;
      // Deux formes : CSV brut (text/csv) ou lignes tabulaires {rows} (JSON),
      // typiquement extraites d'un fichier Excel côté client.
      let source: { csv: string } | { rows: Cell[][] };
      if (typeof req.body === "string" && req.body.length > 0) {
        source = { csv: req.body };
      } else {
        const parsed = RowsBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: "validation",
            message: "Corps attendu : text/csv, ou JSON { rows: Cell[][] }",
          });
        }
        source = { rows: parsed.data.rows };
      }
      const { parse, summary } = await importRoster(app.db, room.id, source);
      if (!parse.ok) {
        // Import atomique (AU-14) : rien n'a été écrit.
        return reply.code(400).send({ error: "roster_invalid", errors: parse.errors });
      }
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "roster.import",
        subjectType: "classroom",
        subjectId: room.id,
        payload: { rows: parse.rows.length },
      });
      return reply.code(200).send({ rows: parse.rows.length, ...summary });
    },
  );
}
