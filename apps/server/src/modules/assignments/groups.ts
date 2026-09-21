/**
 * Group assignments (issue #2, lot 1: group formation). Groups belong to ONE
 * assignment and are formed by the staff, never by the students: the screen
 * selects a group and clicks the students into it. The maximum size is a hint
 * — it warns, it never refuses.
 *
 * Lot 1 stops at the formation: no GitHub call, no repository. What lot 2 will
 * create (one repository per group) already casts its shadow here — a group
 * whose repository exists is LOCKED: no rename (the repository is named after
 * the slug), no deletion, no member removal (revoking a collaborator is a
 * lot-2 action). Adding a member stays allowed: lot 2 will simply invite them.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { AssignmentGroup, AssignmentGroupsPayload, GroupMember } from "@hgc/contracts";

import { audit, type AuditAction } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import {
  assignmentGroupMembers,
  assignmentGroups,
  assignments,
  avatars,
  enrollments,
  studentRepos,
  users,
} from "../../db/schema.js";
import { publish } from "../../events.js";
import { accessibleAssignment, teacherGuard } from "../guards.js";
import { slugify } from "./shared.js";

type AssignmentRow = typeof assignments.$inferSelect;
type GroupRow = typeof assignmentGroups.$inferSelect;

/** Members of the class, staff seats excluded, in the roster's own order. */
async function rosterMembers(db: Db, classroomId: string): Promise<GroupMember[]> {
  const rows = await db
    .select({
      enrollmentId: enrollments.id,
      nom: enrollments.nom,
      prenom: enrollments.prenom,
      email: enrollments.email,
      claimStatus: enrollments.status,
      userId: users.id,
      githubLogin: users.githubLogin,
      pictureUrl: users.pictureUrl,
      avatarAt: avatars.updatedAt,
    })
    .from(enrollments)
    .leftJoin(users, eq(enrollments.userId, users.id))
    .leftJoin(avatars, eq(avatars.userId, users.id))
    .where(and(eq(enrollments.classroomId, classroomId), eq(enrollments.staff, false)))
    .orderBy(enrollments.nom, enrollments.prenom);
  // Same cascade as the roster table: upload > IdP claim > public GitHub
  // avatar > (initials, client-side).
  return rows.map(({ userId, pictureUrl, avatarAt, ...m }) => ({
    ...m,
    avatarUrl:
      avatarAt && userId
        ? `/app/api/users/${userId}/avatar?v=${avatarAt.getTime()}`
        : (pictureUrl ?? (m.githubLogin ? `https://github.com/${m.githubLogin}.png?size=48` : null)),
  }));
}

/**
 * Repository of each group (lot 2 fills `student_repos.group_id`; null
 * everywhere in lot 1). Its mere presence locks the group, hence one lookup
 * shared by the read view and every write guard.
 */
async function reposByGroup(db: Db, assignmentId: string) {
  const rows = await db
    .select({
      groupId: studentRepos.groupId,
      fullName: studentRepos.fullName,
      provisionStatus: studentRepos.provisionStatus,
    })
    .from(studentRepos)
    .where(
      and(
        eq(studentRepos.assignmentId, assignmentId),
        isNotNull(studentRepos.groupId),
        // A repository deleted on GitHub (issue #10, terminal `deleted_at`)
        // has nothing left to revoke or to rename: it must not lock the
        // group for the rest of the semester.
        isNull(studentRepos.deletedAt),
      ),
    );
  const byGroup = new Map<string, { fullName: string | null; provisionStatus: "pending" | "ok" | "error" }>();
  // The members share ONE repository: the first row per group describes it.
  for (const r of rows) if (!byGroup.has(r.groupId!)) byGroup.set(r.groupId!, r);
  return byGroup;
}

/** Roster entries of the class that are in no group of this assignment. */
export async function unassignedStudents(
  db: Db,
  assignment: { id: string; classroomId: string },
): Promise<{ enrollmentId: string; nom: string; prenom: string }[]> {
  const roster = await rosterMembers(db, assignment.classroomId);
  const taken = new Set(
    (
      await db
        .select({ enrollmentId: assignmentGroupMembers.enrollmentId })
        .from(assignmentGroupMembers)
        .where(eq(assignmentGroupMembers.assignmentId, assignment.id))
    ).map((m) => m.enrollmentId),
  );
  return roster
    .filter((m) => !taken.has(m.enrollmentId))
    .map((m) => ({ enrollmentId: m.enrollmentId, nom: m.nom, prenom: m.prenom }));
}

/**
 * The publish guard as ONE SQL predicate on `assignments`, for the callers
 * that cannot read then write: the ticker claims its scheduled publications
 * with a conditional UPDATE (ADR-006), so the rule has to travel inside that
 * claim. Reads: not a group assignment, or it has at least one group and no
 * non-staff student of its classroom is left outside them.
 */
export function groupFormationComplete(): SQL {
  return sql`(
    ${assignments.groupMode} = false
    OR (
      EXISTS (
        SELECT 1 FROM ${assignmentGroups}
        WHERE ${assignmentGroups.assignmentId} = ${assignments.id}
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${enrollments}
        WHERE ${enrollments.classroomId} = ${assignments.classroomId}
          AND ${enrollments.staff} = false
          AND NOT EXISTS (
            SELECT 1 FROM ${assignmentGroupMembers}
            WHERE ${assignmentGroupMembers.assignmentId} = ${assignments.id}
              AND ${assignmentGroupMembers.enrollmentId} = ${enrollments.id}
          )
      )
    )
  )`;
}

/** Number of groups of an assignment (publish guard: zero group blocks too). */
export async function countGroups(db: Db, assignmentId: string): Promise<number> {
  const rows = await db
    .select({ id: assignmentGroups.id })
    .from(assignmentGroups)
    .where(eq(assignmentGroups.assignmentId, assignmentId));
  return rows.length;
}

/** The whole group-formation screen in one payload (both panes re-render). */
export async function groupsPayload(
  db: Db,
  assignment: AssignmentRow,
): Promise<AssignmentGroupsPayload> {
  const roster = await rosterMembers(db, assignment.classroomId);
  const groups = await db
    .select()
    .from(assignmentGroups)
    .where(eq(assignmentGroups.assignmentId, assignment.id))
    .orderBy(asc(assignmentGroups.position));
  const memberships = await db
    .select()
    .from(assignmentGroupMembers)
    .where(eq(assignmentGroupMembers.assignmentId, assignment.id));
  const repos = await reposByGroup(db, assignment.id);

  const assigned = new Set<string>();
  const membersOf = new Map<string, GroupMember[]>();
  // Roster order inside a group too: the panes read the same way. A
  // membership whose roster entry is gone (student removed from the class)
  // has no line to show, so it simply does not appear.
  for (const m of roster) {
    const membership = memberships.find((x) => x.enrollmentId === m.enrollmentId);
    if (!membership) continue;
    assigned.add(m.enrollmentId);
    membersOf.set(membership.groupId, [...(membersOf.get(membership.groupId) ?? []), m]);
  }

  // "Copy from…": the other group-mode assignments of the class that have at
  // least one group, oldest first (the semester reads top-down).
  const copySources = await db
    .select({
      id: assignments.id,
      name: assignments.name,
      groups: sql<number>`count(${assignmentGroups.id})::int`,
    })
    .from(assignments)
    .innerJoin(assignmentGroups, eq(assignmentGroups.assignmentId, assignments.id))
    .where(
      and(
        eq(assignments.classroomId, assignment.classroomId),
        eq(assignments.groupMode, true),
        isNull(assignments.archivedAt),
        ne(assignments.id, assignment.id),
      ),
    )
    .groupBy(assignments.id, assignments.name, assignments.createdAt)
    .orderBy(asc(assignments.createdAt));

  return {
    assignment: {
      id: assignment.id,
      name: assignment.name,
      state: assignment.state,
      groupMode: assignment.groupMode,
      groupMaxSize: assignment.groupMaxSize,
    },
    groups: groups.map((g) => view(g, membersOf.get(g.id) ?? [], repos)),
    unassigned: roster.filter((m) => !assigned.has(m.enrollmentId)),
    copySources: copySources.map((s) => ({ ...s, groups: Number(s.groups) })),
  };
}

function view(
  g: GroupRow,
  members: GroupMember[],
  repos: Map<string, { fullName: string | null; provisionStatus: "pending" | "ok" | "error" }>,
): AssignmentGroup {
  const repo = repos.get(g.id);
  return {
    id: g.id,
    name: g.name,
    slug: g.slug,
    members,
    repo: repo ? { fullName: repo.fullName, provisionStatus: repo.provisionStatus } : null,
  };
}

/**
 * `Group N` with the first free N: deleting group 2 frees the name again.
 * Both uniques have to be free, not just the name — a group named "Group 2!"
 * owns the slug `group-2`, and proposing "Group 2" would hand the primary
 * button a name that can only 409.
 */
function defaultName(names: Set<string>, slugs: Set<string>): string {
  for (let n = 1; ; n++) {
    const name = `Group ${n}`;
    if (!names.has(name) && !slugs.has(slugify(name))) return name;
  }
}

/** `base`, `base 2`, `base 3`… — for the homonyms of the singles flow. */
function freeName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

function freeSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export async function assignmentGroupRoutes(
  app: FastifyInstance,
  _opts: { config: AppConfig },
) {
  const requireTeacher = teacherGuard(app);
  const base = "/app/api/classrooms/:id/assignments/:aid/groups";

  /**
   * The accessible assignment, on the condition that it IS a group
   * assignment: an individual assignment has no group screen at all, reads
   * included (the client turns the 409 into "this assignment is individual").
   */
  async function groupScope(req: FastifyRequest, reply: FastifyReply) {
    const scope = await accessibleAssignment(app, req, reply);
    if (!scope) return null;
    if (!scope.assignment.groupMode) {
      await reply.code(409).send({
        error: "group_mode_off",
        message: "This assignment is not a group assignment",
      });
      return null;
    }
    return scope;
  }

  /** A group of this assignment, or 404 (same opacity as everywhere else). */
  async function loadGroup(req: FastifyRequest, reply: FastifyReply, assignmentId: string) {
    const params = z.object({ gid: z.uuid() }).safeParse(req.params);
    if (!params.success) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    const [group] = await app.db
      .select()
      .from(assignmentGroups)
      .where(
        and(
          eq(assignmentGroups.id, params.data.gid),
          eq(assignmentGroups.assignmentId, assignmentId),
        ),
      )
      .limit(1);
    if (!group) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    return group;
  }

  /** 409 `has_repo` when the group already owns a repository (see header). */
  async function refuseLocked(reply: FastifyReply, assignmentId: string, groupId: string) {
    const repos = await reposByGroup(app.db, assignmentId);
    if (!repos.has(groupId)) return false;
    await reply.code(409).send({
      error: "has_repo",
      message: "This group already has a repository: its members and its name are frozen",
    });
    return true;
  }

  /** The groups of the assignment and the names/slugs already taken. */
  async function existing(assignmentId: string) {
    const groups = await app.db
      .select()
      .from(assignmentGroups)
      .where(eq(assignmentGroups.assignmentId, assignmentId))
      .orderBy(asc(assignmentGroups.position));
    return {
      groups,
      names: new Set(groups.map((g) => g.name)),
      slugs: new Set(groups.map((g) => g.slug)),
      nextPosition: groups.reduce((max, g) => Math.max(max, g.position + 1), 0),
    };
  }

  async function trace(
    req: FastifyRequest,
    assignment: AssignmentRow,
    action: AuditAction,
    payload?: unknown,
  ) {
    await audit(app.db, {
      actorUserId: req.user!.id,
      actorType: "user",
      action,
      subjectType: "assignment",
      subjectId: assignment.id,
      payload,
    });
    publish("assignments", [`classroom:${assignment.classroomId}`]);
  }

  app.get(base, { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await groupScope(req, reply);
    if (!scope) return reply;
    return groupsPayload(app.db, scope.assignment);
  });

  const GroupCreate = z.object({ name: z.string().min(1).max(100).optional() });

  app.post(base, { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await groupScope(req, reply);
    if (!scope) return reply;
    const body = GroupCreate.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "validation", issues: body.error.issues });
    }
    const { names, slugs, nextPosition } = await existing(scope.assignment.id);
    const name = body.data.name?.trim() || defaultName(names, slugs);
    const stem = slugify(name);
    if (!stem) {
      return reply
        .code(400)
        .send({ error: "validation", message: "Name contains no usable characters" });
    }
    // Two different names can slugify the same ("Les Castors" and "les
    // castors!"): suffix the slug rather than refuse a name that is free.
    // A duplicate NAME still 409s, on the unique index below.
    const slug = freeSlug(stem, slugs);
    const [row] = await app.db
      .insert(assignmentGroups)
      .values({
        id: randomUUID(),
        assignmentId: scope.assignment.id,
        name,
        slug,
        position: nextPosition,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      return reply.code(409).send({
        error: "duplicate_name",
        message: `A group “${name}” already exists on this assignment`,
      });
    }
    await trace(req, scope.assignment, "group.create", { name, slug });
    return reply.code(201).send(view(row, [], new Map()));
  });

  const GroupRename = z.object({ name: z.string().min(1).max(100) });

  app.patch(`${base}/:gid`, { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await groupScope(req, reply);
    if (!scope) return reply;
    const group = await loadGroup(req, reply, scope.assignment.id);
    if (!group) return reply;
    const body = GroupRename.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "validation", issues: body.error.issues });
    }
    // The slug names the repository: renaming a group that has one would
    // desynchronize the two (lot 2 territory), so the whole rename is refused.
    if (await refuseLocked(reply, scope.assignment.id, group.id)) return reply;
    const name = body.data.name.trim();
    const slug = slugify(name);
    if (!slug) {
      return reply
        .code(400)
        .send({ error: "validation", message: "Name contains no usable characters" });
    }
    const { names, slugs } = await existing(scope.assignment.id);
    names.delete(group.name);
    slugs.delete(group.slug);
    if (names.has(name) || slugs.has(slug)) {
      return reply.code(409).send({
        error: "duplicate_name",
        message: `A group “${name}” already exists on this assignment`,
      });
    }
    const [row] = await app.db
      .update(assignmentGroups)
      .set({ name, slug })
      .where(eq(assignmentGroups.id, group.id))
      .returning();
    await trace(req, scope.assignment, "group.rename", { from: group.name, to: name });
    // The group is not locked (checked above), so it has no repository.
    const payload = await groupsPayload(app.db, scope.assignment);
    return payload.groups.find((g) => g.id === group.id) ?? view(row!, [], new Map());
  });

  app.delete(`${base}/:gid`, { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await groupScope(req, reply);
    if (!scope) return reply;
    const group = await loadGroup(req, reply, scope.assignment.id);
    if (!group) return reply;
    if (await refuseLocked(reply, scope.assignment.id, group.id)) return reply;
    // The memberships go with it (cascade): its students become unassigned.
    await app.db.delete(assignmentGroups).where(eq(assignmentGroups.id, group.id));
    await trace(req, scope.assignment, "group.delete", { name: group.name });
    return reply.code(204).send();
  });

  const MemberAdd = z.object({ enrollmentId: z.uuid() });

  app.post(`${base}/:gid/members`, { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await groupScope(req, reply);
    if (!scope) return reply;
    const group = await loadGroup(req, reply, scope.assignment.id);
    if (!group) return reply;
    const body = MemberAdd.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "validation", issues: body.error.issues });
    }
    // Only a student of THIS class, and never a staff seat (they are not part
    // of the headcount, so they are not part of the groups either).
    const [student] = await app.db
      .select()
      .from(enrollments)
      .where(
        and(
          eq(enrollments.id, body.data.enrollmentId),
          eq(enrollments.classroomId, scope.assignment.classroomId),
          eq(enrollments.staff, false),
        ),
      )
      .limit(1);
    if (!student) return reply.code(404).send({ error: "not_found" });

    const [current] = await app.db
      .select()
      .from(assignmentGroupMembers)
      .where(
        and(
          eq(assignmentGroupMembers.assignmentId, scope.assignment.id),
          eq(assignmentGroupMembers.enrollmentId, student.id),
        ),
      )
      .limit(1);
    if (current?.groupId === group.id) return groupsPayload(app.db, scope.assignment);
    // Moving out of a group that has a repository would mean revoking a
    // collaborator — lot 2. Adding INTO one stays fine: lot 2 invites them.
    if (current && (await refuseLocked(reply, scope.assignment.id, current.groupId))) return reply;
    if (current) {
      // A move is ONE row changing group: an UPDATE, never a delete followed
      // by an insert. A failure in between would have left the student in no
      // group at all, and two clicks racing would have hit the unique index
      // (a 500 for what is a perfectly legitimate second click).
      await app.db
        .update(assignmentGroupMembers)
        .set({ groupId: group.id })
        .where(eq(assignmentGroupMembers.id, current.id));
    } else {
      // Same reasoning for the first assignment: the loser of the race sees
      // the row it wanted, not a unique-violation 500.
      await app.db
        .insert(assignmentGroupMembers)
        .values({
          id: randomUUID(),
          assignmentId: scope.assignment.id,
          groupId: group.id,
          enrollmentId: student.id,
        })
        .onConflictDoNothing();
    }
    await trace(req, scope.assignment, "group.member.add", {
      group: group.name,
      enrollmentId: student.id,
      from: current?.groupId ?? null,
    });
    return groupsPayload(app.db, scope.assignment);
  });

  app.delete(`${base}/:gid/members/:eid`, { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await groupScope(req, reply);
    if (!scope) return reply;
    const group = await loadGroup(req, reply, scope.assignment.id);
    if (!group) return reply;
    const params = z.object({ eid: z.uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    if (await refuseLocked(reply, scope.assignment.id, group.id)) return reply;
    const [gone] = await app.db
      .delete(assignmentGroupMembers)
      .where(
        and(
          eq(assignmentGroupMembers.assignmentId, scope.assignment.id),
          eq(assignmentGroupMembers.groupId, group.id),
          eq(assignmentGroupMembers.enrollmentId, params.data.eid),
        ),
      )
      .returning();
    if (!gone) return reply.code(404).send({ error: "not_found" });
    await trace(req, scope.assignment, "group.member.remove", {
      group: group.name,
      enrollmentId: params.data.eid,
    });
    return groupsPayload(app.db, scope.assignment);
  });

  const GroupCopy = z.object({ fromAssignmentId: z.uuid() });

  app.post(`${base}/copy`, { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await groupScope(req, reply);
    if (!scope) return reply;
    const body = GroupCopy.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "validation", issues: body.error.issues });
    }
    // Same classroom, group mode: anything else is not a source the teacher
    // could have seen, so it is a 404 rather than a validation error.
    const [source] = await app.db
      .select()
      .from(assignments)
      .where(
        and(
          eq(assignments.id, body.data.fromAssignmentId),
          eq(assignments.classroomId, scope.assignment.classroomId),
          eq(assignments.groupMode, true),
          ne(assignments.id, scope.assignment.id),
        ),
      )
      .limit(1);
    if (!source) return reply.code(404).send({ error: "not_found" });

    // The copy REPLACES the current groups: with a repository around, that is
    // a deletion in disguise, so one locked group refuses the whole operation.
    const repos = await reposByGroup(app.db, scope.assignment.id);
    if (repos.size > 0) {
      return reply.code(409).send({
        error: "has_repo",
        message: "Some groups already have a repository: they can no longer be replaced",
      });
    }
    const sourceGroups = await app.db
      .select()
      .from(assignmentGroups)
      .where(eq(assignmentGroups.assignmentId, source.id))
      .orderBy(asc(assignmentGroups.position));
    // The copy replaces everything: from an empty source it would just wipe
    // the teacher's work and report success. There is nothing to copy.
    if (sourceGroups.length === 0) {
      return reply.code(409).send({
        error: "empty_source",
        message: `“${source.name}” has no group to copy`,
      });
    }
    const sourceMembers = await app.db
      .select()
      .from(assignmentGroupMembers)
      .where(
        inArray(
          assignmentGroupMembers.groupId,
          sourceGroups.map((g) => g.id),
        ),
      );
    // A student who left the class since then is simply not copied.
    const stillHere = new Set(
      (await rosterMembers(app.db, scope.assignment.classroomId)).map((m) => m.enrollmentId),
    );

    // One transaction: the screen never shows the half-second where the old
    // groups are gone and the new ones are not in yet, and a failure mid-copy
    // leaves the teacher's groups untouched instead of destroyed.
    await app.db.transaction(async (tx) => {
      await tx
        .delete(assignmentGroups)
        .where(eq(assignmentGroups.assignmentId, scope.assignment.id));
      const copies = sourceGroups.map((g) => ({
        id: randomUUID(),
        assignmentId: scope.assignment.id,
        name: g.name,
        slug: g.slug,
        position: g.position,
        source: g.id,
      }));
      await tx.insert(assignmentGroups).values(copies.map(({ source: _s, ...g }) => g));
      const members = copies.flatMap((copy) =>
        sourceMembers
          .filter((m) => m.groupId === copy.source && stillHere.has(m.enrollmentId))
          .map((m) => ({
            id: randomUUID(),
            assignmentId: scope.assignment.id,
            groupId: copy.id,
            enrollmentId: m.enrollmentId,
          })),
      );
      if (members.length > 0) await tx.insert(assignmentGroupMembers).values(members);
    });
    await trace(req, scope.assignment, "group.copy", {
      from: source.id,
      groups: sourceGroups.length,
    });
    return groupsPayload(app.db, scope.assignment);
  });

  const GroupSplit = z.object({ size: z.number().int().min(2).max(10) });

  app.post(`${base}/split`, { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await groupScope(req, reply);
    if (!scope) return reply;
    const body = GroupSplit.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "validation", issues: body.error.issues });
    }
    // Only the students left over are distributed: the groups already formed
    // are the teacher's work and are never touched.
    const left = await unassignedStudents(app.db, scope.assignment);
    const { names, slugs, nextPosition } = await existing(scope.assignment.id);
    let position = nextPosition;
    let created = 0;
    for (let i = 0; i < left.length; i += body.data.size) {
      const name = defaultName(names, slugs);
      names.add(name);
      const slug = freeSlug(slugify(name), slugs);
      slugs.add(slug);
      const id = randomUUID();
      await app.db.insert(assignmentGroups).values({
        id,
        assignmentId: scope.assignment.id,
        name,
        slug,
        position: position++,
      });
      await app.db.insert(assignmentGroupMembers).values(
        left.slice(i, i + body.data.size).map((s) => ({
          id: randomUUID(),
          assignmentId: scope.assignment.id,
          groupId: id,
          enrollmentId: s.enrollmentId,
        })),
      );
      created += 1;
    }
    await trace(req, scope.assignment, "group.split", { size: body.data.size, created });
    return groupsPayload(app.db, scope.assignment);
  });

  app.post(`${base}/singles`, { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await groupScope(req, reply);
    if (!scope) return reply;
    // "Everyone else alone": what the publish guard offers when students are
    // left over — one group of one each, named after the student.
    const left = await unassignedStudents(app.db, scope.assignment);
    const { names, slugs, nextPosition } = await existing(scope.assignment.id);
    let position = nextPosition;
    for (const s of left) {
      const name = freeName(`${s.prenom} ${s.nom}`.trim(), names);
      names.add(name);
      const slug = freeSlug(slugify(name) || `group-${position + 1}`, slugs);
      slugs.add(slug);
      const id = randomUUID();
      await app.db.insert(assignmentGroups).values({
        id,
        assignmentId: scope.assignment.id,
        name,
        slug,
        position: position++,
      });
      await app.db.insert(assignmentGroupMembers).values({
        id: randomUUID(),
        assignmentId: scope.assignment.id,
        groupId: id,
        enrollmentId: s.enrollmentId,
      });
    }
    await trace(req, scope.assignment, "group.singles", { created: left.length });
    return groupsPayload(app.db, scope.assignment);
  });
}
