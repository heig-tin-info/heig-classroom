import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { parseRosterCsv, rosterFromRows, type Cell, type RosterParse } from "@hgc/domain";

import { audit } from "../audit.js";
import { publish } from "../events.js";
import type { Db } from "../db/client.js";
import { avatars, enrollments, userEmails, users } from "../db/schema.js";
import { emailIn, knownEmails, normalizeEmail, sharedWithOthers } from "../identity.js";

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
 * Automatic claim at login (AU-18, H3): every `pending` entry whose e-mail
 * is one of the account's known addresses (GH-11 — the login address, or an
 * institutional one asserted by edu-ID) is attached to the user.
 *
 * Nothing is attached on an ambiguous match. Three ways to be ambiguous:
 * the entry's address is also held by another account; several entries of
 * the SAME classroom match this account; the account already holds an entry
 * there. All three end the same way — `conflict_flag`, for a teacher to
 * resolve (AU-21) — because guessing would put a grade on the wrong person.
 */
export async function claimEnrollments(db: Db, user: { id: string }) {
  const emails = await knownEmails(db, user.id);
  if (emails.length === 0) return 0;

  const pending = await db
    .select({
      id: enrollments.id,
      classroomId: enrollments.classroomId,
      nom: enrollments.nom,
      prenom: enrollments.prenom,
      email: enrollments.email,
    })
    .from(enrollments)
    .where(and(eq(enrollments.status, "pending"), emailIn(enrollments.email, emails)));
  if (pending.length === 0) return 0;

  const shared = await sharedWithOthers(
    db,
    user.id,
    pending.map((e) => e.email),
  );
  const perClassroom = new Map<string, number>();
  for (const entry of pending) {
    perClassroom.set(entry.classroomId, (perClassroom.get(entry.classroomId) ?? 0) + 1);
  }

  async function flagConflict(entryId: string) {
    await db
      .update(enrollments)
      .set({ conflictFlag: true })
      .where(eq(enrollments.id, entryId));
    await audit(db, {
      actorUserId: user.id,
      actorType: "system",
      action: "roster.claim_conflict",
      subjectType: "enrollment",
      subjectId: entryId,
    });
  }

  let claimed = 0;
  for (const entry of pending) {
    if (shared.has(normalizeEmail(entry.email)) || perClassroom.get(entry.classroomId)! > 1) {
      await flagConflict(entry.id);
      continue;
    }
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
      await flagConflict(entry.id);
    }
  }
  return claimed;
}

/**
 * Reverse claim (after an import or an e-mail edit): attaches a classroom's
 * `pending` entries to existing accounts, on the same address set and the
 * same ambiguity rules as the login claim.
 */
export async function claimForExistingUsers(db: Db, classroomId: string) {
  const matches = await db
    .select({
      enrollmentId: enrollments.id,
      enrollmentEmail: enrollments.email,
      userId: userEmails.userId,
    })
    .from(enrollments)
    .innerJoin(
      userEmails,
      and(
        sql`lower(${enrollments.email}) = ${userEmails.email}`,
        eq(userEmails.verified, true),
      ),
    )
    .where(and(eq(enrollments.classroomId, classroomId), eq(enrollments.status, "pending")));

  // One entry claimed by two accounts, or one account claiming two entries
  // of this classroom: ambiguous either way.
  const usersPerEntry = new Map<string, Set<string>>();
  const entriesPerUser = new Map<string, Set<string>>();
  const link = (map: Map<string, Set<string>>, key: string, value: string) => {
    const set = map.get(key) ?? new Set<string>();
    set.add(value);
    map.set(key, set);
  };
  for (const m of matches) {
    link(usersPerEntry, m.enrollmentId, m.userId);
    link(entriesPerUser, m.userId, m.enrollmentId);
  }

  let claimed = 0;
  for (const m of matches) {
    const ambiguous =
      usersPerEntry.get(m.enrollmentId)!.size > 1 || entriesPerUser.get(m.userId)!.size > 1;
    if (ambiguous) {
      await db
        .update(enrollments)
        .set({ conflictFlag: true })
        .where(eq(enrollments.id, m.enrollmentId));
      await audit(db, {
        actorUserId: m.userId,
        actorType: "system",
        action: "roster.claim_conflict",
        subjectType: "enrollment",
        subjectId: m.enrollmentId,
      });
      continue;
    }
    try {
      await db
        .update(enrollments)
        .set({ status: "claimed", userId: m.userId, claimedAt: new Date() })
        .where(and(eq(enrollments.id, m.enrollmentId), eq(enrollments.status, "pending")));
      claimed += 1;
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
  return claimed;
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
