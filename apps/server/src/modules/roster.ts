import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { parseRosterCsv, rosterFromRows, type Cell, type RosterParse } from "@hgc/domain";

import { audit } from "../audit.js";
import { publish } from "../events.js";
import type { Db } from "../db/client.js";
import { avatars, enrollments, users } from "../db/schema.js";

export interface RosterImportSummary {
  inserted: number;
  updated: number;
}

/**
 * Atomic roster import (AU-14/16): upsert by (classroom, email); existing
 * entries keep their claim status, only last/first name are refreshed.
 * No implicit deletion.
 */
export async function importRoster(
  db: Db,
  classroomId: string,
  source: { csv: string } | { rows: Cell[][] },
): Promise<{ parse: RosterParse; summary?: RosterImportSummary }> {
  const parse = "csv" in source ? parseRosterCsv(source.csv) : rosterFromRows(source.rows);
  if (!parse.ok) return { parse };

  let inserted = 0;
  let updated = 0;
  await db.transaction(async (tx) => {
    for (const row of parse.rows) {
      const [res] = await tx
        .insert(enrollments)
        .values({
          id: randomUUID(),
          classroomId,
          nom: row.nom,
          prenom: row.prenom,
          email: row.email,
        })
        .onConflictDoUpdate({
          target: [enrollments.classroomId, enrollments.email],
          set: { nom: row.nom, prenom: row.prenom },
        })
        .returning({ claimedAt: enrollments.claimedAt, status: enrollments.status });
      // xmax = 0 is Postgres's insert marker, but let's stay portable:
      // we count as "inserted" what was not yet claimed nor known.
      if (res && res.status === "pending" && res.claimedAt === null) inserted += 1;
      else updated += 1;
    }
  });
  // Fine-grained insert/update counting will come with a real need; what
  // matters is atomicity and idempotent replay.
  return { parse, summary: { inserted, updated } };
}

/**
 * Automatic claim at login (AU-18, H3): every `pending` entry whose
 * email (verified by the IdP) matches is attached to the user.
 * If the user has already claimed another entry in the same classroom,
 * the entry is flagged as a conflict (AU-21) instead of being attached.
 */
export async function claimEnrollments(db: Db, user: { id: string; email: string }) {
  const pending = await db
    .select({
      id: enrollments.id,
      classroomId: enrollments.classroomId,
      nom: enrollments.nom,
      prenom: enrollments.prenom,
    })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.status, "pending"),
        sql`lower(${enrollments.email}) = ${user.email.toLowerCase()}`,
      ),
    );

  let claimed = 0;
  for (const entry of pending) {
    try {
      await db
        .update(enrollments)
        .set({ status: "claimed", userId: user.id, claimedAt: new Date() })
        .where(and(eq(enrollments.id, entry.id), eq(enrollments.status, "pending")));
      claimed += 1;
      publish("roster", [`classroom:${entry.classroomId}`, `user:${user.id}`], {
        kind: "student_joined",
        message: `${entry.prenom} ${entry.nom} joined the classroom`,
      });
      await audit(db, {
        actorUserId: user.id,
        actorType: "system",
        action: "roster.claim",
        subjectType: "enrollment",
        subjectId: entry.id,
      });
    } catch {
      // UNIQUE(classroom_id, user_id): the user already has an entry in
      // this classroom; a conflict for the teacher to resolve (AU-21).
      await db
        .update(enrollments)
        .set({ conflictFlag: true })
        .where(eq(enrollments.id, entry.id));
      await audit(db, {
        actorUserId: user.id,
        actorType: "system",
        action: "roster.claim_conflict",
        subjectType: "enrollment",
        subjectId: entry.id,
      });
    }
  }
  return claimed;
}

/**
 * Reverse claim (after an import or an email edit): attaches a classroom's
 * `pending` entries to already existing accounts whose verified email
 * matches; the student does not need to log in again.
 */
export async function claimForExistingUsers(db: Db, classroomId: string) {
  const matches = await db
    .select({ enrollmentId: enrollments.id, userId: users.id, userEmail: users.email })
    .from(enrollments)
    .innerJoin(
      users,
      and(
        sql`lower(${users.email}) = lower(${enrollments.email})`,
        eq(users.emailVerified, true),
      ),
    )
    .where(and(eq(enrollments.classroomId, classroomId), eq(enrollments.status, "pending")));

  for (const m of matches) {
    try {
      await db
        .update(enrollments)
        .set({ status: "claimed", userId: m.userId, claimedAt: new Date() })
        .where(and(eq(enrollments.id, m.enrollmentId), eq(enrollments.status, "pending")));
      await audit(db, {
        actorUserId: m.userId,
        actorType: "system",
        action: "roster.claim",
        subjectType: "enrollment",
        subjectId: m.enrollmentId,
      });
      publish("roster", [`classroom:${classroomId}`, `user:${m.userId}`]);
    } catch {
      await db
        .update(enrollments)
        .set({ conflictFlag: true })
        .where(eq(enrollments.id, m.enrollmentId));
    }
  }
  return matches.length;
}

/** Teacher's roster table (US-01): identity, status, GitHub, last login. */
export async function rosterView(db: Db, classroomId: string) {
  const rows = await db
    .select({
      id: enrollments.id,
      nom: enrollments.nom,
      prenom: enrollments.prenom,
      email: enrollments.email,
      status: enrollments.status,
      conflictFlag: enrollments.conflictFlag,
      staff: enrollments.staff,
      claimedAt: enrollments.claimedAt,
      githubLogin: users.githubLogin,
      lastLoginAt: users.lastLoginAt,
      userId: users.id,
      pictureUrl: users.pictureUrl,
      avatarAt: avatars.updatedAt,
    })
    .from(enrollments)
    .leftJoin(users, eq(enrollments.userId, users.id))
    .leftJoin(avatars, eq(avatars.userId, users.id))
    .where(eq(enrollments.classroomId, classroomId))
    .orderBy(enrollments.nom, enrollments.prenom);
  // Avatar: upload > IdP claim > public GitHub avatar > (client-side initials)
  return rows.map(({ avatarAt, pictureUrl, ...r }) => ({
    ...r,
    avatarUrl:
      avatarAt && r.userId
        ? `/app/api/users/${r.userId}/avatar?v=${avatarAt.getTime()}`
        : (pictureUrl ??
          (r.githubLogin ? `https://github.com/${r.githubLogin}.png?size=48` : null)),
  }));
}
