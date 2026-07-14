import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ClassroomCreate } from "@hgc/contracts";
import type { Cell } from "@hgc/domain";

import { audit } from "../audit.js";
import { publish } from "../events.js";
import type { AppConfig } from "../config.js";
import { assignments, classrooms, enrollments, organizations } from "../db/schema.js";
import {
  fetchOrgLlmSecret,
  fetchOrgPlan,
  githubApp,
  listInstalledOrgs,
  orgExistsOnGithub,
  resolveOrgInstallation,
} from "../github/app.js";
import { ownedClassroom, ownedEnrollment, teacherGuard } from "./guards.js";
import { claimForExistingUsers, importRoster, rosterView } from "./roster.js";

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
  const requireTeacher = teacherGuard(app);

  // GitHub App setup_url: after the owner clicks "Install" on GitHub, the
  // browser lands here with the installation id. Resolving it right away
  // (instead of waiting for the lazy GH-04 retry) turns the classroom badge
  // green the moment the teacher is back. No session needed: the payload is
  // verified against GitHub with the App JWT, and the update is idempotent.
  app.get("/setup/github/installed", async (req, reply) => {
    const q = req.query as { installation_id?: string; state?: string };
    // `state` carries the classroom to return to (set on the install link).
    const back =
      q.state && z.uuid().safeParse(q.state).success ? `/classrooms/${q.state}` : "/";
    const installationId = Number(q.installation_id);
    const ghApp = githubApp(config);
    if (!ghApp || !Number.isInteger(installationId) || installationId <= 0) {
      return reply.redirect(back, 303);
    }
    try {
      const { data } = await ghApp.octokit.request(
        "GET /app/installations/{installation_id}",
        { installation_id: installationId },
      );
      const account = data.account as { id?: number; login?: string; type?: string } | null;
      if (account?.login && account.type === "Organization") {
        const [org] = await app.db
          .select({ id: organizations.id })
          .from(organizations)
          .where(sql`lower(${organizations.login}) = ${account.login.toLowerCase()}`)
          .limit(1);
        if (org) {
          // Free orgs never deliver org secrets to private repos (the LLM
          // tier would fail silently): read the plan while we hold the
          // freshly installed installation, the classroom page warns on it.
          const plan = await fetchOrgPlan(config, installationId, account.login);
          await app.db
            .update(organizations)
            .set({
              installationId,
              githubOrgId: account.id ?? null,
              status: "active",
              ...(plan ? { plan } : {}),
            })
            .where(eq(organizations.id, org.id));
          await audit(app.db, {
            actorType: "system",
            action: "org.installation_resolved",
            subjectType: "organization",
            subjectId: org.id,
            payload: { installationId, via: "setup_url" },
          });
          const rooms = await app.db
            .select({ id: classrooms.id, teacherId: classrooms.teacherId })
            .from(classrooms)
            .where(eq(classrooms.orgId, org.id));
          publish(
            "orgs",
            rooms.flatMap((r) => [`classroom:${r.id}`, `teacher:${r.teacherId}`] as const),
          );
        }
      }
    } catch (err) {
      req.log.warn({ err, installationId }, "setup_url resolution failed");
    }
    return reply.redirect(back, 303);
  });

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
    // ?archived=1 lists the archive instead of the active classrooms.
    const archived = (req.query as { archived?: string }).archived === "1";
    const rows = await app.db
      .select({
        id: classrooms.id,
        name: classrooms.name,
        orgLogin: organizations.login,
        createdAt: classrooms.createdAt,
        archivedAt: classrooms.archivedAt,
        // Staff seats (teacher self-enroll) are not part of the headcount.
        students: sql<number>`count(${enrollments.id}) filter (where not ${enrollments.staff})::int`,
        claimed: sql<number>`count(${enrollments.id}) filter (where ${enrollments.status} = 'claimed' and not ${enrollments.staff})::int`,
      })
      .from(classrooms)
      .innerJoin(organizations, eq(classrooms.orgId, organizations.id))
      .leftJoin(enrollments, eq(enrollments.classroomId, classrooms.id))
      .where(
        and(
          eq(classrooms.teacherId, req.user!.id),
          archived ? isNotNull(classrooms.archivedAt) : isNull(classrooms.archivedAt),
        ),
      )
      .groupBy(classrooms.id, organizations.login)
      .orderBy(classrooms.createdAt);

    // Cards, sortable list, timeline and hover popovers all feed from this
    // single payload: assignments (dates, state) and a roster preview.
    const ids = rows.map((r) => r.id);
    const assigns = ids.length
      ? await app.db
          .select({
            id: assignments.id,
            classroomId: assignments.classroomId,
            name: assignments.name,
            state: assignments.state,
            startAt: assignments.startAt,
            deadlineAt: assignments.deadlineAt,
          })
          .from(assignments)
          .where(and(inArray(assignments.classroomId, ids), isNull(assignments.archivedAt)))
          .orderBy(assignments.startAt)
      : [];
    const roster = ids.length
      ? await app.db
          .select({
            classroomId: enrollments.classroomId,
            nom: enrollments.nom,
            prenom: enrollments.prenom,
            status: enrollments.status,
            staff: enrollments.staff,
          })
          .from(enrollments)
          .where(inArray(enrollments.classroomId, ids))
          .orderBy(enrollments.nom, enrollments.prenom)
      : [];
    return rows.map((r) => ({
      ...r,
      assignments: assigns
        .filter((a) => a.classroomId === r.id)
        .map(({ classroomId: _c, ...a }) => a),
      roster: roster
        .filter((e) => e.classroomId === r.id)
        .map((e) => ({ nom: e.nom, prenom: e.prenom, claimed: e.status === "claimed", staff: e.staff })),
    }));
  });

  app.post("/app/api/classrooms", { preHandler: requireTeacher }, async (req, reply) => {
    const body = ClassroomCreate.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "validation", issues: body.error.issues });
    }
    // The organization must exist on GitHub (free-form input validated);
    // inconclusive lookup (rate limit) = let it through.
    const exists = await orgExistsOnGithub(body.data.orgLogin.trim(), config);
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
    const room = await ownedClassroom(app, req, reply);
    if (!room) return reply;
    let [org] = await app.db
      .select({
        login: organizations.login,
        installationId: organizations.installationId,
        githubOrgId: organizations.githubOrgId,
        plan: organizations.plan,
        status: organizations.status,
      })
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
          org = { ...org, installationId: found.installationId, githubOrgId: found.githubOrgId };
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
    // The organization itself may have vanished (deleted, or renamed away):
    // with no installation GitHub has nowhere to deliver the org events, so
    // no webhook ever tells us. Re-check existence while uninstalled and
    // persist the verdict — the page shows the wizard or the red state from
    // it, and an org recreated under the same login heals on the next open.
    let orgExists: boolean | null = org ? true : null;
    if (org && org.installationId === null) {
      orgExists = await orgExistsOnGithub(org.login, config);
      const verdict =
        orgExists === false ? ("degraded" as const) : orgExists === true ? ("active" as const) : null;
      if (verdict && verdict !== org.status) {
        await app.db
          .update(organizations)
          .set({ status: verdict })
          .where(eq(organizations.id, room.orgId));
        org = { ...org, status: verdict };
      }
      // Indeterminate lookup (rate limit): keep the stored status.
      if (orgExists === null && org.status === "degraded") orgExists = false;
    }
    // Billing plan check (org secrets vs private repos): re-read while the
    // plan is unknown or `free`, so the warning appears on install and
    // clears itself on the next open after the teacher upgrades.
    if (org && org.installationId !== null && (org.plan === null || org.plan === "free")) {
      const plan = await fetchOrgPlan(config, org.installationId, org.login);
      if (plan && plan !== org.plan) {
        await app.db
          .update(organizations)
          .set({ plan })
          .where(eq(organizations.id, room.orgId));
        org = { ...org, plan };
      }
    }
    // The install wizard targets the exact organization on GitHub
    // (installations/new/permissions?target_id=…), which needs its numeric
    // id: resolve and remember it the first time.
    if (org && org.githubOrgId === null) {
      try {
        const ghApp = githubApp(config);
        if (ghApp) {
          const { data } = await ghApp.octokit.request("GET /orgs/{org}", { org: org.login });
          await app.db
            .update(organizations)
            .set({ githubOrgId: data.id })
            .where(eq(organizations.id, room.orgId));
          org = { ...org, githubOrgId: data.id };
        }
      } catch (err) {
        req.log.warn({ err, org: org.login }, "org id resolution failed");
      }
    }
    // LLM reviews need the ANTHROPIC_API_KEY org secret (the reusable
    // workflow maps it explicitly): warn the teacher on the classroom page
    // rather than at the first failed review after a deadline.
    const llmSecret =
      org && org.installationId !== null
        ? await fetchOrgLlmSecret(config, org.installationId, org.login)
        : null;
    const roster = await rosterView(app.db, room.id);
    return {
      ...room,
      org: org ? { ...org, exists: orgExists, llmSecret } : org,
      roster,
      appSlug: config.GITHUB_APP_SLUG || null,
    };
  });

  app.post(
    "/app/api/classrooms/:id/archive",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const room = await ownedClassroom(app, req, reply);
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

  app.post(
    "/app/api/classrooms/:id/unarchive",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const room = await ownedClassroom(app, req, reply);
      if (!room) return reply;
      await app.db
        .update(classrooms)
        .set({ archivedAt: null })
        .where(eq(classrooms.id, room.id));
      await audit(app.db, {
        actorUserId: req.user!.id,
        actorType: "user",
        action: "classroom.unarchive",
        subjectType: "classroom",
        subjectId: room.id,
        payload: { name: room.name },
      });
      return reply.code(204).send();
    },
  );

  // Self-enroll: the teacher takes a (staff) seat in their own classroom to
  // exercise the student flow — accept, push, grades — without a second
  // account. The seat is claimed immediately (the email is already verified)
  // and flagged `staff` so it stays out of the class headcount.
  app.post(
    "/app/api/classrooms/:id/self-enroll",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const room = await ownedClassroom(app, req, reply);
      if (!room) return reply;
      const me = req.user!;
      try {
        await app.db
          .insert(enrollments)
          .values({
            id: randomUUID(),
            classroomId: room.id,
            nom: me.familyName,
            prenom: me.givenName,
            email: me.email.trim().toLowerCase(),
            status: "claimed",
            userId: me.id,
            claimedAt: new Date(),
            staff: true,
          })
          .onConflictDoUpdate({
            // Email already imported in this roster: claim it and mark staff.
            target: [enrollments.classroomId, enrollments.email],
            set: { status: "claimed", userId: me.id, claimedAt: new Date(), staff: true },
          });
      } catch {
        // UNIQUE(classroom_id, user_id): the user already claimed another
        // entry of this roster under a different email.
        return reply.code(409).send({ error: "already_enrolled" });
      }
      await audit(app.db, {
        actorUserId: me.id,
        actorType: "user",
        action: "roster.self_enroll",
        subjectType: "classroom",
        subjectId: room.id,
      });
      publish("roster", [`classroom:${room.id}`, `user:${me.id}`]);
      return reply.code(201).send({ ok: true });
    },
  );

  // --- Roster editing, entry by entry ---

  const EnrollmentPatch = z
    .object({
      nom: z.string().min(1).max(200).optional(),
      prenom: z.string().min(1).max(200).optional(),
      email: z.email().optional(),
    })
    .refine((b) => b.nom || b.prenom || b.email, { message: "Nothing to update" });

  app.patch(
    "/app/api/classrooms/:id/roster/:eid",
    { preHandler: requireTeacher },
    async (req, reply) => {
      const entry = await ownedEnrollment(app, req, reply);
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
      const entry = await ownedEnrollment(app, req, reply);
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
      const entry = await ownedEnrollment(app, req, reply);
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
    const room = await ownedClassroom(app, req, reply);
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
    const room = await ownedClassroom(app, req, reply);
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
      const room = await ownedClassroom(app, req, reply);
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
