import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ClassroomCreate } from "@hgc/contracts";
import type { Cell } from "@hgc/domain";

import { audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import { enrollments, classrooms, organizations } from "../db/schema.js";
import { resolveOrgInstallation } from "../github/app.js";
import { claimForExistingUsers, importRoster, rosterView } from "./roster.js";

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

export async function classroomsPlugin(
  app: FastifyInstance,
  opts: { config: AppConfig },
) {
  const { config } = opts;
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
    let [org] = await app.db
      .select({ login: organizations.login, installationId: organizations.installationId })
      .from(organizations)
      .where(eq(organizations.id, room.orgId))
      .limit(1);
    // Résolution paresseuse de l'installation (GH-04) : tant que l'App n'est
    // pas détectée sur l'org, on retente à chaque consultation du détail.
    if (org && org.installationId === null) {
      try {
        const found = await resolveOrgInstallation(config, org.login);
        if (found) {
          await app.db
            .update(organizations)
            .set({
              installationId: found.installationId,
              githubOrgId: found.githubOrgId,
              status: "active",
            })
            .where(eq(organizations.id, room.orgId));
          org = { ...org, installationId: found.installationId };
          await audit(app.db, {
            actorType: "system",
            action: "org.installation_resolved",
            subjectType: "organization",
            subjectId: room.orgId,
            payload: found,
          });
        }
      } catch (err) {
        req.log.warn({ err, org: org.login }, "résolution d'installation impossible");
      }
    }
    const roster = await rosterView(app.db, room.id);
    return { ...room, org, roster };
  });

  // --- Édition du roster, entrée par entrée ---

  const EnrollmentParam = z.object({ id: z.uuid(), eid: z.uuid() });
  const EnrollmentPatch = z
    .object({
      nom: z.string().min(1).max(200).optional(),
      prenom: z.string().min(1).max(200).optional(),
      email: z.email().optional(),
    })
    .refine((b) => b.nom || b.prenom || b.email, { message: "Nothing to update" });

  /** Charge l'entrée si la classroom appartient au teacher courant. */
  async function ownedEnrollment(req: FastifyRequest, reply: FastifyReply) {
    const params = EnrollmentParam.safeParse(req.params);
    if (!params.success) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    const [row] = await app.db
      .select({ enrollment: enrollments, teacherId: classrooms.teacherId })
      .from(enrollments)
      .innerJoin(classrooms, eq(enrollments.classroomId, classrooms.id))
      .where(
        and(eq(enrollments.id, params.data.eid), eq(enrollments.classroomId, params.data.id)),
      )
      .limit(1);
    if (!row || row.teacherId !== req.user!.id) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    return row.enrollment;
  }

  app.patch(
    "/app/api/classrooms/:id/roster/:eid",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const entry = await ownedEnrollment(req, reply);
      if (!entry) return reply;
      const body = EnrollmentPatch.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: "validation", issues: body.error.issues });
      }
      const email = body.data.email?.trim().toLowerCase();
      const emailChanged = email !== undefined && email !== entry.email;
      try {
        const [updated] = await app.db
          .update(enrollments)
          .set({
            ...(body.data.nom ? { nom: body.data.nom } : {}),
            ...(body.data.prenom ? { prenom: body.data.prenom } : {}),
            ...(email ? { email } : {}),
            // Changer l'e-mail invalide le rattachement : l'entrée redevient
            // à réclamer par le détenteur du nouvel e-mail (AU-18).
            ...(emailChanged
              ? { status: "pending" as const, userId: null, claimedAt: null, conflictFlag: false }
              : {}),
          })
          .where(eq(enrollments.id, entry.id))
          .returning();
        await audit(app.db, {
          actorUserId: req.user!.id,
          actorType: "user",
          action: "roster.update",
          subjectType: "enrollment",
          subjectId: entry.id,
          payload: { ...body.data, emailChanged },
        });
        return updated;
      } catch {
        // UNIQUE(classroom_id, email)
        return reply
          .code(409)
          .send({ error: "duplicate_email", message: "This e-mail is already in the roster" });
      }
    },
  );

  app.post(
    "/app/api/classrooms/:id/roster/:eid/unclaim",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const entry = await ownedEnrollment(req, reply);
      if (!entry) return reply;
      const [updated] = await app.db
        .update(enrollments)
        .set({ status: "pending", userId: null, claimedAt: null, conflictFlag: false })
        .where(eq(enrollments.id, entry.id))
        .returning();
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "roster.unclaim",
        subjectType: "enrollment",
        subjectId: entry.id,
        payload: { previousUserId: entry.userId },
      });
      return updated;
    },
  );

  app.delete(
    "/app/api/classrooms/:id/roster/:eid",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const entry = await ownedEnrollment(req, reply);
      if (!entry) return reply;
      await app.db.delete(enrollments).where(eq(enrollments.id, entry.id));
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "roster.remove",
        subjectType: "enrollment",
        subjectId: entry.id,
        payload: { nom: entry.nom, prenom: entry.prenom, email: entry.email },
      });
      return reply.code(204).send();
    },
  );

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
            message: "Expected body: text/csv, or JSON { rows: Cell[][] }",
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
      // Les étudiants déjà inscrits sur la plateforme sont rattachés
      // immédiatement, sans attendre leur prochain login.
      await claimForExistingUsers(app.db, room.id);
      return reply.code(200).send({ rows: parse.rows.length, ...summary });
    },
  );
}
