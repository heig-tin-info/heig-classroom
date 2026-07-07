import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import { classrooms, teacherGrants, users } from "../db/schema.js";

/**
 * Administration (révision de H2, 2026-07-07) : le super admin (e-mail en
 * environnement) gère les teachers en base. Le grant se fait par e-mail ;
 * identité et dernière connexion se remplissent au premier login edu-ID.
 * Grant et revoke ont un effet immédiat sur le compte existant (le rôle est
 * aussi recalculé à chaque login).
 */
export async function adminPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;

  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    const denied = await app.requireSession(req, reply);
    if (denied) return denied;
    if (req.user!.role !== "admin") return reply.code(403).send({ error: "forbidden" });
    return undefined;
  };

  app.get("/app/api/admin/teachers", { preHandler: requireAdmin }, async () => {
    return app.db
      .select({
        id: teacherGrants.id,
        email: teacherGrants.email,
        grantedAt: teacherGrants.createdAt,
        givenName: users.givenName,
        familyName: users.familyName,
        lastLoginAt: users.lastLoginAt,
        signedUp: sql<boolean>`${users.id} IS NOT NULL`,
        classrooms: sql<number>`coalesce((SELECT count(*) FROM ${classrooms} c WHERE c.teacher_id = ${users.id}), 0)::int`,
        assignments: sql<number>`coalesce((SELECT count(*) FROM assignments a JOIN ${classrooms} c ON c.id = a.classroom_id WHERE c.teacher_id = ${users.id}), 0)::int`,
      })
      .from(teacherGrants)
      .leftJoin(users, sql`lower(${users.email}) = ${teacherGrants.email}`)
      .orderBy(teacherGrants.createdAt);
  });

  const GrantBody = z.object({ email: z.email() });

  app.post("/app/api/admin/teachers", { preHandler: requireAdmin }, async (req, reply) => {
    const body = GrantBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "validation", message: "A valid e-mail is required" });
    }
    const email = body.data.email.trim().toLowerCase();
    if (email === config.SUPER_ADMIN_EMAIL) {
      return reply
        .code(409)
        .send({ error: "is_admin", message: "This e-mail is the administrator" });
    }
    const [created] = await app.db
      .insert(teacherGrants)
      .values({ id: randomUUID(), email, createdBy: req.user!.id })
      .onConflictDoNothing({ target: teacherGrants.email })
      .returning();
    if (!created) {
      return reply
        .code(409)
        .send({ error: "already_teacher", message: "This e-mail is already a teacher" });
    }
    // Effet immédiat si le compte existe déjà (sinon : au premier login).
    await app.db
      .update(users)
      .set({ role: "teacher" })
      .where(sql`lower(${users.email}) = ${email} AND ${users.role} = 'student'`);
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "teacher.grant",
      subjectType: "teacher_grant",
      subjectId: created.id,
      payload: { email },
    });
    return reply.code(201).send(created);
  });

  const GrantParam = z.object({ gid: z.uuid() });

  app.delete(
    "/app/api/admin/teachers/:gid",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const params = GrantParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const [grant] = await app.db
        .select()
        .from(teacherGrants)
        .where(eq(teacherGrants.id, params.data.gid))
        .limit(1);
      if (!grant) return reply.code(404).send({ error: "not_found" });
      await app.db.delete(teacherGrants).where(eq(teacherGrants.id, grant.id));
      // Rétrogradation immédiate ; ses classrooms restent en base, intactes.
      await app.db
        .update(users)
        .set({ role: "student" })
        .where(sql`lower(${users.email}) = ${grant.email} AND ${users.role} = 'teacher'`);
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "teacher.revoke",
        subjectType: "teacher_grant",
        subjectId: grant.id,
        payload: { email: grant.email },
      });
      return reply.code(204).send();
    },
  );
}
