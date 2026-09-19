/**
 * Session life cycle with a fake engine: what is checked here is the portal's
 * logic (resumption, reconciliation, garbage collection, snapshots), not
 * Podman. Podman is checked for real by `scripts/e2e.ts` and by
 * `git/channel.integration.test.ts`.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db, type DbHandle } from "../db/client.js";
import { assignments, users, type AssignmentRow, type UserRow } from "../db/schema.js";
import type { ContainerInfo, Engine, RunRequest } from "../engine/index.js";
import { gitBare } from "../git/index.js";

import {
  containerNameFor,
  createSessionManager,
  stagingSourceFor,
  type ManagerDeps,
} from "./manager.js";
import { snapshot } from "./shadow.js";
import { findAnySession, isOpen, targetRepoFor } from "./store.js";
import { remoteUrl } from "./workspace.js";

// --- fake engine ------------------------------------------------------------
class FakeEngine implements Engine {
  readonly containers = new Map<string, ContainerInfo>();
  runs = 0;
  private next = 10;

  runArgs(): string[] {
    return [];
  }
  async run(req: RunRequest): Promise<ContainerInfo> {
    this.runs += 1;
    const info: ContainerInfo = {
      id: `ctr-${this.runs}`,
      name: req.name,
      sessionId: req.sessionId,
      state: "running",
      ip: `10.77.0.${this.next++}`,
    };
    this.containers.set(req.name, info);
    return info;
  }
  async inspect(name: string): Promise<ContainerInfo | null> {
    return this.containers.get(name) ?? null;
  }
  async stop(name: string): Promise<void> {
    const info = this.containers.get(name);
    if (info) this.containers.set(name, { ...info, state: "exited" });
  }
  async rm(name: string): Promise<void> {
    this.containers.delete(name);
  }
  async listSessions(): Promise<ContainerInfo[]> {
    return [...this.containers.values()];
  }
  async waitHealthy(): Promise<number> {
    return 1;
  }
  readonly execs: Array<{ name: string; argv: string[] }> = [];
  async exec(name: string, argv: string[]): Promise<string> {
    this.execs.push({ name, argv });
    return "";
  }
  /** Simulates a `podman kill`: the container vanishes from under the portal. */
  kill(name: string): void {
    this.containers.delete(name);
  }
}

const LOG = { info: () => undefined, warn: () => undefined, error: () => undefined };

let handle: DbHandle;
let db: Db;
let root: string;
let engine: FakeEngine;
let user: UserRow;

function makeManager(graceMs = 60_000, extra: Partial<ManagerDeps> = {}) {
  return createSessionManager({
    ...extra,
    db,
    engine,
    volumesRoot: root,
    graceMs,
    gcIntervalMs: 60_000,
    shadowIntervalMs: 60_000,
    healthTimeoutMs: 1000,
    gitRemoteHost: "portal.internal",
    gitRemotePort: 9418,
    log: LOG,
  });
}

async function insertAssignment(patch: Partial<AssignmentRow> = {}): Promise<AssignmentRow> {
  const row = {
    id: "tp",
    title: "TP",
    mode: "lab" as const,
    image: "codespace/c-dev:4.137.0",
    uploadPack: true,
    templateRepo: null,
    targetRepo: null,
    targetRepoPattern: null,
    opensAt: null,
    closesAt: null,
    configKey: null,
    beks: [],
    sebConfig: null,
    createdAt: new Date(),
    ...patch,
  };
  db.insert(assignments).values(row).run();
  return row as AssignmentRow;
}

beforeEach(async () => {
  handle = openDb(":memory:");
  db = handle.db;
  root = await mkdtemp(join(tmpdir(), "v1-sessions-"));
  engine = new FakeEngine();
  const [row] = db
    .insert(users)
    .values({
      id: "u1",
      oidcSub: "sub-1",
      login: "student",
      email: "student@heig-vd.ch",
      displayName: "Sacha Student",
      role: "student",
      createdAt: new Date(),
    })
    .returning()
    .all();
  user = row as UserRow;
});

afterEach(async () => {
  handle.close();
  await rm(root, { recursive: true, force: true });
});

describe("invariant 6 — the source of the staging repository", () => {
  it("in exam mode, the teacher's template and nothing else", () => {
    const exam = {
      mode: "exam",
      templateRepo: "http://forge/template.git",
    } as AssignmentRow;
    // Even when the student's repository is there, the template wins.
    expect(stagingSourceFor(exam, "http://forge/student.git")).toEqual({
      mode: "exam",
      templateFrom: "http://forge/template.git",
    });
  });

  it("in exam mode without a template, explicit refusal rather than fallback", () => {
    const exam = { id: "e", mode: "exam", templateRepo: null } as AssignmentRow;
    expect(() => stagingSourceFor(exam, "http://forge/student.git")).toThrow(/template/);
  });

  it("in lab mode, the mirror of the student's repository", () => {
    const lab = { mode: "lab", templateRepo: "http://forge/template.git" } as AssignmentRow;
    expect(stagingSourceFor(lab, "http://forge/student.git")).toEqual({
      mode: "lab",
      mirrorFrom: "http://forge/student.git",
    });
  });
});

describe("target repository", () => {
  it("substitutes the convention", () => {
    expect(targetRepoFor({ targetRepo: null, targetRepoPattern: "org/tp-{student}" }, "sacha")).toEqual(
      { owner: "org", name: "tp-sacha" },
    );
  });
  it("prefers the fixed value", () => {
    expect(
      targetRepoFor({ targetRepo: "org/fixe", targetRepoPattern: "org/tp-{student}" }, "sacha"),
    ).toEqual({ owner: "org", name: "fixe" });
  });
  it("returns undefined without a destination: the staging repository is the terminus", () => {
    expect(targetRepoFor({ targetRepo: null, targetRepoPattern: null }, "sacha")).toBeUndefined();
  });
});

describe("opening window", () => {
  const now = new Date("2026-06-01T10:00:00Z");
  it("open without bounds", () => {
    expect(isOpen({ opensAt: null, closesAt: null } as AssignmentRow, now)).toBe(true);
  });
  it("closed before the opening and after the closing", () => {
    expect(
      isOpen({ opensAt: new Date("2026-06-02T00:00:00Z"), closesAt: null } as AssignmentRow, now),
    ).toBe(false);
    expect(
      isOpen({ opensAt: null, closesAt: new Date("2026-05-31T00:00:00Z") } as AssignmentRow, now),
    ).toBe(false);
  });
});

describe("creation and resumption (analyse.md D5)", () => {
  it("a single live session per pair, and a single container", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const first = await manager.start(user, assignment);
    const second = await manager.start(user, assignment);
    expect(second.session.id).toBe(first.session.id);
    expect(second.launched).toBe(false);
    expect(engine.runs).toBe(1);
  });

  it("writes an origin remote that carries the session id", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, assignment);
    const config = await gitBare(join(session.volumeDir, "work", ".git"), [
      "config",
      "remote.origin.url",
    ]);
    expect(config.trim()).toBe(remoteUrl("portal.internal", 9418, session.id));
  });

  it("relaunches on the same volume when the container has vanished", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, assignment);
    await writeFile(join(session.volumeDir, "work", "note.txt"), "work", "utf8");
    engine.kill(containerNameFor(session.id));

    const again = await manager.ensureRunning(session.id);
    expect(engine.runs).toBe(2);
    expect(again.volumeDir).toBe(session.volumeDir);
    expect(again.state).toBe("running");
  });

  it("keeps the same session id after a close: the remote stays valid", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const first = await manager.start(user, assignment);
    await manager.close(first.session.id, "test");
    const second = await manager.start(user, assignment);
    expect(second.session.id).toBe(first.session.id);
    expect(findAnySession(db, "student", "tp")?.state).toBe("running");
  });
});

/**
 * Audit L3 of 2026-09-18: `cs_session` used to carry the same token for the
 * whole life of the volume. A copy taken once — a shoulder-surfed devtools
 * panel, a shared machine — stayed valid for weeks. The session id is stable
 * on purpose (the `origin` remote written into `work/` depends on it); the
 * token is not, and it is the token the proxy checks.
 */
describe("the proxy cookie token rotates (audit L3)", () => {
  it("a resume on a live container hands out a new token and retires the old one", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const first = await manager.start(user, assignment);
    const second = await manager.start(user, assignment);

    expect(second.session.id).toBe(first.session.id);
    expect(second.launched).toBe(false);
    expect(second.cookieToken).not.toBe(first.cookieToken);
    // What the proxy will do with an older tab's cookie.
    const row = findAnySession(db, "student", "tp")!;
    expect(manager.checkCookie(row, second.cookieToken)).toBe(true);
    expect(manager.checkCookie(row, first.cookieToken)).toBe(false);
    // The returned row is the one the caller sets the cookie from: it must
    // already carry the rotated value, not the stale one.
    expect(second.session.cookieToken).toBe(second.cookieToken);
  });

  it("a resume after the container vanished rotates too", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const first = await manager.start(user, assignment);
    engine.kill(containerNameFor(first.session.id));

    const second = await manager.start(user, assignment);
    expect(second.launched).toBe(true);
    expect(second.cookieToken).not.toBe(first.cookieToken);
    expect(manager.checkCookie(findAnySession(db, "student", "tp")!, first.cookieToken)).toBe(
      false,
    );
  });

  it("closing retires the token, and reopening does not bring it back", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const first = await manager.start(user, assignment);
    await manager.close(first.session.id, "test");
    expect(manager.checkCookie(findAnySession(db, "student", "tp")!, first.cookieToken)).toBe(
      false,
    );

    const second = await manager.start(user, assignment);
    expect(second.cookieToken).not.toBe(first.cookieToken);
    expect(manager.checkCookie(second.session, first.cookieToken)).toBe(false);
  });

  it("a plain reload does not rotate: ensureRunning is not an opening", async () => {
    // The student reloading `/s/<id>/` goes through the proxy, which calls
    // `ensureRunning`. Rotating there would invalidate the very cookie the
    // browser is sending.
    const assignment = await insertAssignment();
    const manager = makeManager();
    const first = await manager.start(user, assignment);
    const again = await manager.ensureRunning(first.session.id);
    expect(manager.checkCookie(again, first.cookieToken)).toBe(true);
  });

  it("two concurrent starts share one session and one token", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const [a, b] = await Promise.all([
      manager.start(user, assignment),
      manager.start(user, assignment),
    ]);
    expect(b!.session.id).toBe(a!.session.id);
    // The in-flight follower must not hand out a value already rotated away:
    // both callers set the same, live cookie.
    expect(b!.cookieToken).toBe(a!.cookieToken);
    expect(manager.checkCookie(findAnySession(db, "student", "tp")!, a!.cookieToken)).toBe(true);
  });
});

describe("garbage collection", () => {
  it("destroys the container after the grace period and keeps the volume", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager(1000);
    const { session } = await manager.start(user, assignment);
    manager.touch(session.id, new Date(Date.now() - 10_000));

    const result = await manager.collect();
    expect(result.closed).toBe(1);
    expect(await engine.inspect(containerNameFor(session.id))).toBeNull();
    // The volume stays: that is the whole point of the decision.
    expect(findAnySession(db, "student", "tp")?.volumeDir).toBe(session.volumeDir);
  });

  it("spares a session whose heartbeat is fresh", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager(60_000);
    const { session } = await manager.start(user, assignment);
    manager.touch(session.id);
    expect((await manager.collect()).closed).toBe(0);
    expect((await engine.inspect(containerNameFor(session.id)))?.state).toBe("running");
  });
});

describe("reconciliation at portal start-up", () => {
  it("keeps a session whose container is still running", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, assignment);
    const result = await manager.reconcile();
    expect(result).toMatchObject({ resumed: 1, stopped: 0, orphans: 0 });
    expect(findAnySession(db, "student", "tp")?.state).toBe("running");
    // No container recreated: that is the point of the V1 assertion.
    expect(engine.runs).toBe(1);
  });

  it("marks stopped a session whose container has vanished", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, assignment);
    engine.kill(containerNameFor(session.id));
    const result = await manager.reconcile();
    expect(result).toMatchObject({ resumed: 0, stopped: 1 });
    expect(findAnySession(db, "student", "tp")?.state).toBe("stopped");
  });

  it("removes an orphan session container", async () => {
    await engine.run({ sessionId: "ghost", name: "cs-ghost", workDir: "/tmp/x" });
    const manager = makeManager();
    const result = await manager.reconcile();
    expect(result.orphans).toBe(1);
    expect(await engine.inspect("cs-ghost")).toBeNull();
  });

  it("never sees the anchor: the engine only returns session-labelled containers", async () => {
    // `listSessions()` filters on `label=heig-codespace.session`; the anchor
    // carries `heig-codespace.role=anchor` and therefore does not show up here.
    const manager = makeManager();
    expect(await manager.reconcile()).toMatchObject({ orphans: 0 });
    expect((await engine.listSessions()).every((c) => c.sessionId !== null)).toBe(true);
  });
});

describe("shadow repository (analyse.md 3.3)", () => {
  it("captures the working tree and excludes the student's repository", async () => {
    const volume = join(root, "student", "tp");
    await mkdir(join(volume, "work", ".git"), { recursive: true });
    await writeFile(join(volume, "work", "hello.c"), "int main(void){return 0;}\n", "utf8");
    await writeFile(join(volume, "work", ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

    const first = await snapshot(volume);
    expect(first.sha).toBeTruthy();
    const files = await gitBare(join(volume, "shadow.git"), [
      "ls-tree",
      "-r",
      "--name-only",
      "HEAD",
    ]);
    expect(files).toContain("hello.c");
    expect(files).not.toContain(".git/");
  });

  it("commits nothing when nothing has changed", async () => {
    const volume = join(root, "student", "tp2");
    await mkdir(join(volume, "work"), { recursive: true });
    await writeFile(join(volume, "work", "a.txt"), "a\n", "utf8");
    expect((await snapshot(volume)).sha).toBeTruthy();
    expect((await snapshot(volume)).sha).toBeNull();
  });

  it("captures a later modification", async () => {
    const volume = join(root, "student", "tp3");
    await mkdir(join(volume, "work"), { recursive: true });
    await writeFile(join(volume, "work", "a.txt"), "a\n", "utf8");
    await snapshot(volume);
    await writeFile(join(volume, "work", "a.txt"), "b\n", "utf8");
    expect((await snapshot(volume)).sha).toBeTruthy();
    const log = await gitBare(join(volume, "shadow.git"), ["log", "--oneline"]);
    expect(log.trim().split("\n")).toHaveLength(2);
  });
});

describe("SessionLookup for the Git channel", () => {
  it("returns the container address, which is the whole authentication", async () => {
    const assignment = await insertAssignment({ targetRepoPattern: "org/tp-{student}" });
    const manager = makeManager();
    const { session } = await manager.start(user, assignment);
    const found = await manager.lookup.bySessionId(session.id);
    expect(found).toMatchObject({
      student: "student",
      assignment: "tp",
      containerIp: session.containerIp,
      uploadPack: true,
      targetRepo: { owner: "org", name: "tp-student" },
    });
  });

  it("returns undefined for a closed session: no push is accepted any more", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, assignment);
    await manager.close(session.id, "test");
    expect(await manager.lookup.bySessionId(session.id)).toBeUndefined();
  });
});
