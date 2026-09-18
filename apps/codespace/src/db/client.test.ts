/**
 * The drizzle-kit migrations are the only source of the physical schema since
 * V1 (`git/db.ts` is gone). This test asserts that the database opened by
 * `openDb` does carry the four entities of the framing document, and that
 * `push_events` — the table written by P3 — has not drifted.
 *
 * Fifth table since the classroom integration: `launch_tokens_used`. It is not
 * an entity of the framing document but a uniqueness register — a consumed
 * `jti` and its expiry date — whose primary key *is* the single-use guarantee
 * of the launch token.
 */
import { describe, expect, it } from "vitest";

import { openDb } from "./client.js";
import { assignments, pushEvents, sessions, users } from "./schema.js";

describe("migrations", () => {
  it("creates exactly the four entities of the framing document, plus the token register", () => {
    const handle = openDb(":memory:");
    const rows = handle.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
    );
    expect(rows.map((r) => r.name)).toEqual([
      "assignments",
      "launch_tokens_used",
      "push_events",
      "sessions",
      "users",
    ]);
    handle.close();
  });

  it("keeps the columns the Git channel writes", () => {
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

  it("accepts the four entities and their constraints", () => {
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
        sebConfig: { examKeySalt: "salt", quitUrl: "http://x/" },
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

    // The JSON comes back typed, not as a string.
    const assignment = handle.db.select().from(assignments).get();
    expect(assignment?.beks).toEqual(["a", "b"]);
    expect(assignment?.sebConfig?.examKeySalt).toBe("salt");
    // The timestamps come back as Date, not as numbers.
    expect(handle.db.select().from(sessions).get()?.lastSeen).toBeInstanceOf(Date);

    // Foreign key: a session without an assignment is refused.
    expect(() =>
      handle.db
        .insert(sessions)
        .values({
          id: "s2",
          userId: "u1",
          student: "student",
          assignmentId: "nonexistent",
          volumeDir: "/v",
          state: "running",
          createdAt: now,
          lastSeen: now,
          cookieToken: "t",
          sebVerified: false,
        })
        .run(),
    ).toThrow();

    // Uniqueness of the institutional identifier: two accounts do not share a
    // volume directory.
    expect(() =>
      handle.db
        .insert(users)
        .values({
          id: "u2",
          oidcSub: "other",
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

  it("is replayable: opening twice does not replay the migrations", () => {
    const first = openDb(":memory:");
    first.close();
    const second = openDb(":memory:");
    expect(second.db.all("SELECT 1 AS ok")).toEqual([{ ok: 1 }]);
    second.close();
  });
});
