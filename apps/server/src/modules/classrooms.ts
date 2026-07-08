import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ClassroomCreate } from "@hgc/contracts";
import type { Cell } from "@hgc/domain";

import { audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import { enrollments, classrooms, organizations } from "../db/schema.js";
import { listInstalledOrgs, orgExistsOnGithub, resolveOrgInstallation } from "../github/app.js";
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
  // Lost race: the other writer just created it.
  const [row] = await app.db
    .select()
    .from(organizations)
    .where(eq(organizations.login, normalized))
    .limit(1);
  if (!row) throw new Error("Organization not found after upsert");
  return row;
}

export async function classroomsPlugin(
  app: FastifyInstance,
  opts: { config: AppConfig },
) {
  const { config } = opts;
  /** Teacher only (AU-23/24); 404 for anything that is not theirs. */
  const requireTeacher = async (req: FastifyRequest, reply: FastifyReply) => {
    const denied = await app.requireSession(req, reply);
    if (denied) return denied;
    if (req.user!.role !== "teacher" && req.user!.role !== "admin") {
      return reply.code(403).send({ error: "forbidden" });
    }
    return undefined;
  };

  /** Loads the classroom if and only if it belongs to the current teacher. */
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

  // Organizations offered at creation: those where the App is installed.
  app.get("/app/api/orgs", { preHandler: requireTeacher }, async (req) => {
    try {
      return await listInstalledOrgs(config);
    } catch (err) {
      req.log.warn({ err }, "listing installations failed");
      return [];
    }
  });

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
      .where(and(eq(classrooms.teacherId, req.user!.id), isNull(classrooms.archivedAt)))
      .groupBy(classrooms.id, organizations.login)
      .orderBy(classrooms.createdAt);
  });

  app.post("/app/api/classrooms", { preHandler: requireTeacher }, async (req, reply) => {
    const body = ClassroomCreate.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "validation", issues: body.error.issues });
    }
    // The organization must exist on GitHub (free-form input validated);
    // inconclusive lookup (rate limit) = let it through.
    const exists = await orgExistsOnGithub(body.data.orgLogin.trim());
    if (exists === false) {
      return reply.code(400).send({
        error: "org_not_found",
        message: `Organization “${body.data.orgLogin.trim()}” does not exist on GitHub`,
      });
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
    // Lazy resolution of the installation (GH-04): as long as the App is not
    // detected on the org, we retry every time the detail view is opened.
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
        req.log.warn({ err, org: org.login }, "installation resolution failed");
      }
    }
    const roster = await rosterView(app.db, room.id);
    return { ...room, org, roster, appSlug: config.GITHUB_APP_SLUG || null };
  });

  app.post(
    "/app/api/classrooms/:id/archive",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const room = await ownedClassroom(req, reply);
      if (!room) return reply;
      await app.db
        .update(classrooms)
        .set({ archivedAt: new Date() })
        .where(eq(classrooms.id, room.id));
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "classroom.archive",
        subjectType: "classroom",
        subjectId: room.id,
        payload: { name: room.name },
      });
      return reply.code(204).send();
    },
  );

  // --- Roster editing, entry by entry ---

  const EnrollmentParam = z.object({ id: z.uuid(), eid: z.uuid() });
  const EnrollmentPatch = z
    .object({
      nom: z.string().min(1).max(200).optional(),
      prenom: z.string().min(1).max(200).optional(),
      email: z.email().optional(),
    })
    .refine((b) => b.nom || b.prenom || b.email, { message: "Nothing to update" });

  /** Loads the entry if the classroom belongs to the current teacher. */
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
            // Changing the email invalidates the attachment: the entry is
            // again claimable by the holder of the new email (AU-18).
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
      // Two forms: raw CSV (text/csv) or tabular {rows} lines (JSON),
      // typically extracted from an Excel file client-side.
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
        // Atomic import (AU-14): nothing was written.
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
      // Students already registered on the platform are attached
      // immediately, without waiting for their next login.
      await claimForExistingUsers(app.db, room.id);
      return reply.code(200).send({ rows: parse.rows.length, ...summary });
    },
  );
}
