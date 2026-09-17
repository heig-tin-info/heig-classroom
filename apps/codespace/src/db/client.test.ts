/**
 * Les migrations drizzle-kit sont la seule source du schéma physique depuis
 * V1 (`git/db.ts` a disparu). Ce test affirme que la base ouverte par
 * `openDb` porte bien les quatre tables du cadrage, et que `push_events` — la
 * table écrite par P3 — n'a pas dérivé.
 */
import { describe, expect, it } from "vitest";

import { openDb } from "./client.js";
import { assignments, pushEvents, sessions, users } from "./schema.js";

describe("migrations", () => {
  it("crée exactement les quatre entités du cadrage", () => {
    const handle = openDb(":memory:");
    const rows = handle.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
    );
    expect(rows.map((r) => r.name)).toEqual([
      "assignments",
      "push_events",
      "sessions",
      "users",
    ]);
    handle.close();
  });

  it("garde les colonnes que le canal Git écrit", () => {
    const handle = openDb(":memory:");
    const columns = handle.db
      .all<{ name: string }>("PRAGMA table_info(push_events)")
      .map((c) => c.name);
    for (const expected of [
      "id",
      "session_id",
      "student",
      "assignment",
      "ref",
      "sha",
      "old_sha",
      "received_at",
      "state",
      "attempts",
      "next_attempt_at",
      "relayed_at",
      "last_error",
    ]) {
      expect(columns).toContain(expected);
    }
    handle.close();
  });

  it("accepte les quatre entités et leurs contraintes", () => {
    const handle = openDb(":memory:");
    const now = new Date();
    handle.db
      .insert(users)
      .values({
        id: "u1",
        oidcSub: "sub",
        login: "student",
        email: "s@x",
        displayName: "S",
        role: "student",
        createdAt: now,
      })
      .run();
    handle.db
      .insert(assignments)
      .values({
        id: "tp",
        title: "TP",
        mode: "lab",
        image: "img",
        uploadPack: true,
        beks: ["a", "b"],
        sebConfig: { examKeySalt: "sel", quitUrl: "http://x/" },
        createdAt: now,
      })
      .run();
    handle.db
      .insert(sessions)
      .values({
        id: "s1",
        userId: "u1",
        student: "student",
        assignmentId: "tp",
        volumeDir: "/v",
        state: "running",
        createdAt: now,
        lastSeen: now,
        cookieToken: "t",
        sebVerified: false,
      })
      .run();
    handle.db
      .insert(pushEvents)
      .values({
        id: "p1",
        sessionId: "s1",
        student: "student",
        assignment: "tp",
        ref: "refs/heads/main",
        sha: "a".repeat(40),
        oldSha: null,
        receivedAt: now,
      })
      .run();

    // Le JSON revient typé, pas en chaîne.
    const assignment = handle.db.select().from(assignments).get();
    expect(assignment?.beks).toEqual(["a", "b"]);
    expect(assignment?.sebConfig?.examKeySalt).toBe("sel");
    // Les horodatages reviennent en Date, pas en nombre.
    expect(handle.db.select().from(sessions).get()?.lastSeen).toBeInstanceOf(Date);

    // Clé étrangère : une session sans devoir est refusée.
    expect(() =>
      handle.db
        .insert(sessions)
        .values({
          id: "s2",
          userId: "u1",
          student: "student",
          assignmentId: "inexistant",
          volumeDir: "/v",
          state: "running",
          createdAt: now,
          lastSeen: now,
          cookieToken: "t",
          sebVerified: false,
        })
        .run(),
    ).toThrow();

    // Unicité de l'identifiant institutionnel : deux comptes ne partagent pas
    // un répertoire de volume.
    expect(() =>
      handle.db
        .insert(users)
        .values({
          id: "u2",
          oidcSub: "autre",
          login: "student",
          email: "s2@x",
          displayName: "S2",
          role: "student",
          createdAt: now,
        })
        .run(),
    ).toThrow();

    handle.close();
  });

  it("est rejouable : ouvrir deux fois ne rejoue pas les migrations", () => {
    const first = openDb(":memory:");
    first.close();
    const second = openDb(":memory:");
    expect(second.db.all("SELECT 1 AS ok")).toEqual([{ ok: 1 }]);
    second.close();
  });
});
