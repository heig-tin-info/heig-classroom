import { describe, expect, it } from "vitest";

import { openGitDb } from "../db/client.js";
import {
  createPushEventStore,
  diffRefs,
  recordPush,
  NULL_OID,
  type PushEventRow,
  type PushEventStore,
} from "./pushEvents.js";
import type { StagingSession } from "./types.js";

const SESSION: StagingSession = {
  sessionId: "s-42",
  student: "e1234567",
  assignment: "tp-pointeurs",
  containerIp: "10.77.0.7",
  uploadPack: true,
  targetRepo: { owner: "codespace", name: "e1234567-tp-pointeurs" },
};

const A = "a".repeat(40);
const B = "b".repeat(40);

function store(): { store: PushEventStore; close: () => void } {
  const { db, close } = openGitDb(":memory:");
  return { store: createPushEventStore(db), close };
}

describe("diffRefs", () => {
  it("detects creation, update and deletion", () => {
    const before = new Map([
      ["refs/heads/main", A],
      ["refs/heads/old", A],
    ]);
    const after = new Map([
      ["refs/heads/main", B],
      ["refs/heads/new", B],
    ]);
    expect(diffRefs(before, after)).toEqual([
      { ref: "refs/heads/main", oldSha: A, sha: B },
      { ref: "refs/heads/new", oldSha: null, sha: B },
      { ref: "refs/heads/old", oldSha: A, sha: NULL_OID },
    ]);
  });

  it("reports nothing when nothing moves (push with no effect)", () => {
    const refs = new Map([["refs/heads/main", A]]);
    expect(diffRefs(refs, new Map(refs))).toEqual([]);
  });
});

describe("recordPush", () => {
  it("writes the PushEvent BEFORE notifying the relay (invariant 7)", async () => {
    const { store: s, close } = store();
    const order: string[] = [];
    let seenByRelay: PushEventRow[] = [];
    const observed = {
      ...s,
      async insert(rows: Parameters<PushEventStore["insert"]>[0]) {
        // A slow insert is exactly where the ordering bug would hide.
        await new Promise((r) => setTimeout(r, 10));
        order.push("insert");
        return s.insert(rows);
      },
    };

    await recordPush(
      {
        store: observed,
        relay: {
          async schedule(events) {
            order.push("relay");
            seenByRelay = events;
            // The rows the relay is handed must already be readable.
            expect(await s.bySession(SESSION.sessionId)).toHaveLength(events.length);
          },
        },
      },
      SESSION,
      [{ ref: "refs/heads/main", oldSha: null, sha: A }],
    );

    expect(order).toEqual(["insert", "relay"]);
    expect(seenByRelay[0]?.sha).toBe(A);
    expect(seenByRelay[0]?.state).toBe("pending");
    close();
  });

  it("does not call the relay when no ref has changed", async () => {
    const { store: s, close } = store();
    let called = 0;
    const rows = await recordPush({ store: s, relay: { schedule: () => void called++ } }, SESSION, []);
    expect(rows).toEqual([]);
    expect(called).toBe(0);
    close();
  });

  it("records one row per ref, in the pending state", async () => {
    const { store: s, close } = store();
    await recordPush({ store: s }, SESSION, [
      { ref: "refs/heads/main", oldSha: A, sha: B },
      { ref: "refs/tags/submission", oldSha: null, sha: B },
    ]);
    const rows = await s.bySession(SESSION.sessionId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.ref).sort()).toEqual(["refs/heads/main", "refs/tags/submission"]);
    expect(rows.every((r) => r.state === "pending")).toBe(true);
    expect(rows[0]?.student).toBe("e1234567");
    expect(rows[0]?.receivedAt).toBeInstanceOf(Date);
    close();
  });
});

describe("PushEventStore", () => {
  it("makes eligible only the pending rows whose delay has elapsed", async () => {
    const { store: s, close } = store();
    const t0 = new Date("2026-09-17T10:00:00Z");
    const rows = await recordPush({ store: s, now: () => t0 }, SESSION, [
      { ref: "refs/heads/main", oldSha: null, sha: A },
      { ref: "refs/heads/other", oldSha: null, sha: B },
    ]);
    expect(await s.dueForRelay(t0, 10)).toHaveLength(2);

    const first = rows[0] as PushEventRow;
    await s.markRetry([first.id], new Date(t0.getTime() + 5000), "forge unreachable");
    expect((await s.dueForRelay(t0, 10)).map((r) => r.id)).not.toContain(first.id);
    expect((await s.dueForRelay(new Date(t0.getTime() + 5000), 10)).map((r) => r.id)).toContain(
      first.id,
    );

    await s.markRelayed([first.id], t0);
    const relayed = (await s.bySession(SESSION.sessionId)).find((r) => r.id === first.id);
    expect(relayed?.state).toBe("relayed");
    expect(relayed?.relayedAt).toBeInstanceOf(Date);
    close();
  });

  it("markRetry increments the counter and keeps the pending state", async () => {
    const { store: s, close } = store();
    const [row] = await recordPush({ store: s }, SESSION, [
      { ref: "refs/heads/main", oldSha: null, sha: A },
    ]);
    const id = (row as PushEventRow).id;
    await s.markRetry([id], new Date(0), "error 1");
    await s.markRetry([id], new Date(0), "error 2");
    const after = (await s.bySession(SESSION.sessionId))[0];
    expect(after?.attempts).toBe(2);
    expect(after?.state).toBe("pending");
    expect(after?.lastError).toBe("error 2");

    await s.markFailed([id], "budget exhausted");
    expect((await s.bySession(SESSION.sessionId))[0]?.state).toBe("failed");
    close();
  });
});
