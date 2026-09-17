/**
 * Cycle de vie des sessions avec un moteur simulé : ce qui est vérifié ici,
 * c'est la logique du portail (reprise, réconciliation, ramasse-miettes,
 * instantanés), pas Podman. Podman est vérifié pour de vrai par
 * `scripts/e2e.ts` et par `git/channel.integration.test.ts`.
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

// --- moteur simulé ----------------------------------------------------------
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
  /** Simule un `podman kill` : le conteneur disparaît sous le portail. */
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

describe("invariant 6 — la source du dépôt de transit", () => {
  it("en mode examen, le modèle de l'enseignant et rien d'autre", () => {
    const exam = {
      mode: "exam",
      templateRepo: "http://forge/modele.git",
    } as AssignmentRow;
    // Même en présence du dépôt de l'étudiant, c'est le modèle qui l'emporte.
    expect(stagingSourceFor(exam, "http://forge/etudiant.git")).toEqual({
      mode: "exam",
      templateFrom: "http://forge/modele.git",
    });
  });

  it("en mode examen sans modèle, refus explicite plutôt que repli", () => {
    const exam = { id: "e", mode: "exam", templateRepo: null } as AssignmentRow;
    expect(() => stagingSourceFor(exam, "http://forge/etudiant.git")).toThrow(/modèle/);
  });

  it("en mode travaux pratiques, le miroir du dépôt de l'étudiant", () => {
    const lab = { mode: "lab", templateRepo: "http://forge/modele.git" } as AssignmentRow;
    expect(stagingSourceFor(lab, "http://forge/etudiant.git")).toEqual({
      mode: "lab",
      mirrorFrom: "http://forge/etudiant.git",
    });
  });
});

describe("dépôt cible", () => {
  it("substitue la convention", () => {
    expect(targetRepoFor({ targetRepo: null, targetRepoPattern: "org/tp-{student}" }, "sacha")).toEqual(
      { owner: "org", name: "tp-sacha" },
    );
  });
  it("préfère la valeur fixe", () => {
    expect(
      targetRepoFor({ targetRepo: "org/fixe", targetRepoPattern: "org/tp-{student}" }, "sacha"),
    ).toEqual({ owner: "org", name: "fixe" });
  });
  it("rend undefined sans destination : le dépôt de transit est le terminus", () => {
    expect(targetRepoFor({ targetRepo: null, targetRepoPattern: null }, "sacha")).toBeUndefined();
  });
});

describe("fenêtre d'ouverture", () => {
  const now = new Date("2026-06-01T10:00:00Z");
  it("ouvert sans bornes", () => {
    expect(isOpen({ opensAt: null, closesAt: null } as AssignmentRow, now)).toBe(true);
  });
  it("fermé avant l'ouverture et après la clôture", () => {
    expect(
      isOpen({ opensAt: new Date("2026-06-02T00:00:00Z"), closesAt: null } as AssignmentRow, now),
    ).toBe(false);
    expect(
      isOpen({ opensAt: null, closesAt: new Date("2026-05-31T00:00:00Z") } as AssignmentRow, now),
    ).toBe(false);
  });
});

describe("création et reprise (analyse.md D5)", () => {
  it("une seule session vivante par couple, et un seul conteneur", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const first = await manager.start(user, assignment);
    const second = await manager.start(user, assignment);
    expect(second.session.id).toBe(first.session.id);
    expect(second.launched).toBe(false);
    expect(engine.runs).toBe(1);
  });

  it("écrit un remote origin qui porte l'identifiant de session", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, assignment);
    const config = await gitBare(join(session.volumeDir, "work", ".git"), [
      "config",
      "remote.origin.url",
    ]);
    expect(config.trim()).toBe(remoteUrl("portal.internal", 9418, session.id));
  });

  it("relance sur le même volume quand le conteneur a disparu", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, assignment);
    await writeFile(join(session.volumeDir, "work", "note.txt"), "travail", "utf8");
    engine.kill(containerNameFor(session.id));

    const again = await manager.ensureRunning(session.id);
    expect(engine.runs).toBe(2);
    expect(again.volumeDir).toBe(session.volumeDir);
    expect(again.state).toBe("running");
  });

  it("garde le même identifiant de session après une fermeture : le remote reste valable", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const first = await manager.start(user, assignment);
    await manager.close(first.session.id, "test");
    const second = await manager.start(user, assignment);
    expect(second.session.id).toBe(first.session.id);
    expect(findAnySession(db, "student", "tp")?.state).toBe("running");
  });
});

describe("ramasse-miettes", () => {
  it("détruit le conteneur après la grâce et conserve le volume", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager(1000);
    const { session } = await manager.start(user, assignment);
    manager.touch(session.id, new Date(Date.now() - 10_000));

    const result = await manager.collect();
    expect(result.closed).toBe(1);
    expect(await engine.inspect(containerNameFor(session.id))).toBeNull();
    // Le volume reste : c'est tout l'objet de la décision.
    expect(findAnySession(db, "student", "tp")?.volumeDir).toBe(session.volumeDir);
  });

  it("épargne une session dont le battement est frais", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager(60_000);
    const { session } = await manager.start(user, assignment);
    manager.touch(session.id);
    expect((await manager.collect()).closed).toBe(0);
    expect((await engine.inspect(containerNameFor(session.id)))?.state).toBe("running");
  });
});

describe("réconciliation au démarrage du portail", () => {
  it("garde une session dont le conteneur tourne encore", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, assignment);
    const result = await manager.reconcile();
    expect(result).toMatchObject({ resumed: 1, stopped: 0, orphans: 0 });
    expect(findAnySession(db, "student", "tp")?.state).toBe("running");
    // Aucun conteneur recréé : c'est le point de l'assertion V1.
    expect(engine.runs).toBe(1);
  });

  it("marque stopped une session dont le conteneur a disparu", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, assignment);
    engine.kill(containerNameFor(session.id));
    const result = await manager.reconcile();
    expect(result).toMatchObject({ resumed: 0, stopped: 1 });
    expect(findAnySession(db, "student", "tp")?.state).toBe("stopped");
  });

  it("supprime un conteneur de session orphelin", async () => {
    await engine.run({ sessionId: "fantome", name: "cs-fantome", workDir: "/tmp/x" });
    const manager = makeManager();
    const result = await manager.reconcile();
    expect(result.orphans).toBe(1);
    expect(await engine.inspect("cs-fantome")).toBeNull();
  });

  it("ne voit jamais l'ancrage : le moteur ne rend que les conteneurs étiquetés session", async () => {
    // `listSessions()` filtre sur `label=heig-codespace.session` ; l'ancrage
    // porte `heig-codespace.role=anchor` et n'apparaît donc pas ici.
    const manager = makeManager();
    expect(await manager.reconcile()).toMatchObject({ orphans: 0 });
    expect((await engine.listSessions()).every((c) => c.sessionId !== null)).toBe(true);
  });
});

describe("dépôt fantôme (analyse.md 3.3)", () => {
  it("capture l'arbre de travail et exclut le dépôt de l'étudiant", async () => {
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

  it("ne commite rien quand rien n'a changé", async () => {
    const volume = join(root, "student", "tp2");
    await mkdir(join(volume, "work"), { recursive: true });
    await writeFile(join(volume, "work", "a.txt"), "a\n", "utf8");
    expect((await snapshot(volume)).sha).toBeTruthy();
    expect((await snapshot(volume)).sha).toBeNull();
  });

  it("capture une modification ultérieure", async () => {
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

describe("SessionLookup pour le canal Git", () => {
  it("rend l'adresse du conteneur, qui est toute l'authentification", async () => {
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

  it("rend undefined pour une session fermée : plus aucun push n'est accepté", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, assignment);
    await manager.close(session.id, "test");
    expect(await manager.lookup.bySessionId(session.id)).toBeUndefined();
  });
});
