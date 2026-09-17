import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { audit } from "../audit.js";
import { codespaceConfigured } from "../codespace.js";
import type { AppConfig } from "../config.js";
import { classrooms, scheduledTasks, teacherGrants, users } from "../db/schema.js";
import { syncUserRole } from "../roles.js";
import { TASK_DEFS, taskDef } from "../tasks.js";
import { adminGuard } from "./guards.js";
import { TASK_QUEUE } from "../jobs.js";

/**
 * Administration (revision of H2, 2026-07-07): the super admin (email in
 * the environment) manages teachers in the database. Granting is done by
 * email; identity and last login are filled in at the first edu-ID login.
 * Grant and revoke take effect immediately on an existing account (the role
 * is also recomputed at every login).
 */
export async function adminPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;

  const requireAdmin = adminGuard(app);

  app.get("/app/api/admin/teachers", { preHandler: requireAdmin }, async () => {
    const rows = await app.db
      .select({
        id: teacherGrants.id,
        email: teacherGrants.email,
        grantedAt: teacherGrants.createdAt,
        codespaceEnabled: teacherGrants.codespaceEnabled,
        codespaceMaxActiveSessions: teacherGrants.codespaceMaxActiveSessions,
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
    // ADR-013: without a portal the column does not exist at all — the rows
    // carry `codespace: null` and the admin screen drops the whole column.
    const online = codespaceConfigured(config);
    return rows.map(({ codespaceEnabled, codespaceMaxActiveSessions, ...r }) => ({
      ...r,
      codespace: online
        ? { enabled: codespaceEnabled, maxActiveSessions: codespaceMaxActiveSessions }
        : null,
    }));
  });

  /** Online workspace settings of a teacher (ADR-013), both writes share it. */
  const CodespaceGrant = z.object({
    enabled: z.boolean().optional(),
    maxActiveSessions: z.number().int().min(0).max(100).optional(),
  });

  const GrantBody = z.object({ email: z.email(), codespace: CodespaceGrant.optional() });

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
    const online = codespaceConfigured(config);
    const [created] = await app.db
      .insert(teacherGrants)
      .values({
        id: randomUUID(),
        email,
        createdBy: req.user!.id,
        ...(online && body.data.codespace?.enabled !== undefined
          ? { codespaceEnabled: body.data.codespace.enabled }
          : {}),
        ...(online && body.data.codespace?.maxActiveSessions !== undefined
          ? { codespaceMaxActiveSessions: body.data.codespace.maxActiveSessions }
          : {}),
      })
      .onConflictDoNothing({ target: teacherGrants.email })
      .returning();
    if (!created) {
      return reply
        .code(409)
        .send({ error: "already_teacher", message: "This e-mail is already a teacher" });
    }
    // Immediate effect if the account already exists (otherwise: at first login).
    await syncUserRole(app.db, config, email);
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

  /**
   * Online workspace of one teacher (ADR-013): the switch and the quota. The
   * grant row itself is untouched — revoking the teacher role is the DELETE
   * below.
   */
  app.patch("/app/api/admin/teachers/:gid", { preHandler: requireAdmin }, async (req, reply) => {
    if (!codespaceConfigured(config)) return reply.code(404).send({ error: "not_found" });
    const params = GrantParam.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const body = z
      .object({ codespace: CodespaceGrant })
      .safeParse(req.body);
    if (!body.success || Object.keys(body.data.codespace).length === 0) {
      return reply.code(400).send({ error: "validation", message: "Nothing to update" });
    }
    const patch = {
      ...(body.data.codespace.enabled !== undefined
        ? { codespaceEnabled: body.data.codespace.enabled }
        : {}),
      ...(body.data.codespace.maxActiveSessions !== undefined
        ? { codespaceMaxActiveSessions: body.data.codespace.maxActiveSessions }
        : {}),
    };
    const [updated] = await app.db
      .update(teacherGrants)
      .set(patch)
      .where(eq(teacherGrants.id, params.data.gid))
      .returning();
    if (!updated) return reply.code(404).send({ error: "not_found" });
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "teacher.codespace_grant",
      subjectType: "teacher_grant",
      subjectId: updated.id,
      payload: { email: updated.email, ...patch },
    });
    return {
      id: updated.id,
      email: updated.email,
      codespace: {
        enabled: updated.codespaceEnabled,
        maxActiveSessions: updated.codespaceMaxActiveSessions,
      },
    };
  });

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
      // Immediate demotion; their classrooms stay in the database, untouched.
      // Recomputed, not forced: staff of someone else's classroom (GH-9)
      // keeps the teacher role.
      await syncUserRole(app.db, config, grant.email);
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

  // --- Scheduled tasks (ADR-011): configurable intervals and activation ---

  app.get("/app/api/admin/tasks", { preHandler: requireAdmin }, async () => {
    const rows = await app.db.select().from(scheduledTasks);
    return TASK_DEFS.map((def) => {
      const row = rows.find((r) => r.key === def.key);
      return {
        key: def.key,
        description: def.description,
        webhookWoken: def.webhookWoken,
        enabled: row?.enabled ?? true,
        intervalMinutes: row?.intervalMinutes ?? def.defaultIntervalMinutes,
        defaultIntervalMinutes: def.defaultIntervalMinutes,
        lastRunAt: row?.lastRunAt ?? null,
        lastStatus: row?.lastStatus ?? null,
        lastError: row?.lastError ?? null,
        lastDurationMs: row?.lastDurationMs ?? null,
      };
    });
  });

  const TaskPatch = z
    .object({
      enabled: z.boolean().optional(),
      intervalMinutes: z.number().int().min(5).max(7 * 24 * 60).optional(),
    })
    .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" });

  app.patch("/app/api/admin/tasks/:key", { preHandler: requireAdmin }, async (req, reply) => {
    const def = taskDef((req.params as { key: string }).key);
    if (!def) return reply.code(404).send({ error: "not_found" });
    const body = TaskPatch.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({
        error: "validation",
        message: "Interval must be between 5 minutes and 7 days",
      });
    }
    const [updated] = await app.db
      .insert(scheduledTasks)
      .values({
        key: def.key,
        intervalMinutes: body.data.intervalMinutes ?? def.defaultIntervalMinutes,
        enabled: body.data.enabled ?? true,
      })
      .onConflictDoUpdate({ target: scheduledTasks.key, set: body.data })
      .returning();
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action: "task.configure",
      subjectType: "scheduled_task",
      subjectId: def.key,
      payload: body.data,
    });
    return updated;
  });

  app.post(
    "/app/api/admin/tasks/:key/run",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const def = taskDef((req.params as { key: string }).key);
      if (!def) return reply.code(404).send({ error: "not_found" });
      if (!app.boss) {
        return reply
          .code(503)
          .send({ error: "jobs_down", message: "The job queue is not running" });
      }
      await app.db
        .insert(scheduledTasks)
        .values({ key: def.key, intervalMinutes: def.defaultIntervalMinutes })
        .onConflictDoNothing();
      await app.db
        .update(scheduledTasks)
        .set({ lastRunAt: sql`now()`, lastStatus: "running" })
        .where(eq(scheduledTasks.key, def.key));
      await app.boss.send(TASK_QUEUE, { key: def.key }, { singletonKey: def.key });
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "task.run_now",
        subjectType: "scheduled_task",
        subjectId: def.key,
      });
      return reply.code(202).send({ ok: true });
    },
  );
}
