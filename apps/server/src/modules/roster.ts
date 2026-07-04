import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { parseRosterCsv, type RosterParse } from "@hgc/domain";

import { audit } from "../audit.js";
import type { Db } from "../db/client.js";
import { enrollments, users } from "../db/schema.js";

export interface RosterImportSummary {
  inserted: number;
  updated: number;
}

/**
 * Import atomique du roster (AU-14/16) : upsert par (classroom, email) — les
 * entrées existantes gardent leur statut de claim, seuls nom/prénom sont
 * rafraîchis. Aucune suppression implicite.
 */
export async function importRoster(
  db: Db,
  classroomId: string,
  csvText: string,
): Promise<{ parse: RosterParse; summary?: RosterImportSummary }> {
  const parse = parseRosterCsv(csvText);
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
      // xmax = 0 est le marqueur d'insert de Postgres, mais restons portables :
      // on compte comme « inséré » ce qui n'était pas encore claimé ni connu.
      if (res && res.status === "pending" && res.claimedAt === null) inserted += 1;
      else updated += 1;
    }
  });
  // Le comptage insert/update fin viendra avec un vrai besoin ; l'essentiel
  // est l'atomicité et l'idempotence du rejeu.
  return { parse, summary: { inserted, updated } };
}

/**
 * Claim automatique au login (AU-18, H3) : toute entrée `pending` dont
 * l'e-mail (vérifié par l'IdP) correspond est rattachée à l'utilisateur.
 * Si l'utilisateur a déjà claimé une autre entrée de la même classroom,
 * l'entrée est marquée en conflit (AU-21) au lieu d'être rattachée.
 */
export async function claimEnrollments(db: Db, user: { id: string; email: string }) {
  const pending = await db
    .select({ id: enrollments.id, classroomId: enrollments.classroomId })
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
      await audit(db, {
        actorUserId: user.id,
        actorType: "system",
        action: "roster.claim",
        subjectType: "enrollment",
        subjectId: entry.id,
      });
    } catch {
      // UNIQUE(classroom_id, user_id) : l'utilisateur a déjà une entrée dans
      // cette classroom — conflit à résoudre par le teacher (AU-21).
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

/** Tableau roster du teacher (US-01) : identité, statut, GitHub, dernière connexion. */
export async function rosterView(db: Db, classroomId: string) {
  return db
    .select({
      id: enrollments.id,
      nom: enrollments.nom,
      prenom: enrollments.prenom,
      email: enrollments.email,
      status: enrollments.status,
      conflictFlag: enrollments.conflictFlag,
      claimedAt: enrollments.claimedAt,
      githubLogin: users.githubLogin,
      lastLoginAt: users.lastLoginAt,
    })
    .from(enrollments)
    .leftJoin(users, eq(enrollments.userId, users.id))
    .where(eq(enrollments.classroomId, classroomId))
    .orderBy(enrollments.nom, enrollments.prenom);
}
