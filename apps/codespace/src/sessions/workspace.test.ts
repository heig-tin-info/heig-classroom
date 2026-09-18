/**
 * Amorçage de l'espace de travail — le correctif du 2026-09-17.
 *
 * Ces tests sont **unitaires** : le moteur est simulé, `git` est le vrai, et
 * la « forge » est un dépôt nu local. Ils tiennent en un `pnpm test`, sans
 * Podman ni Forgejo, parce que ce qui est vérifié ici est la logique du
 * portail : échec bruyant, dépôt cible vide autorisé en travaux pratiques,
 * réamorçage à la reprise, branche de travail avec suivi.
 *
 * Ce que le portail faisait avant, et qui a coûté l'essai en production :
 * `git fetch` anonyme sur un dépôt privé, échec avalé, session ouverte sur un
 * répertoire vide.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db, type DbHandle } from "../db/client.js";
import { assignments, users, type AssignmentRow, type UserRow } from "../db/schema.js";
import type { ContainerInfo, Engine, RunRequest } from "../engine/index.js";
import { ForgeUnconfiguredError, git, gitBare, refSnapshot } from "../git/index.js";
import { FIXTURE_ENV, makeSourceRepo } from "../git/fixtures.js";

import {
  containerNameFor,
  createSessionManager,
  defaultBranchOf,
  repoRefFromUrl,
  shortCauseOf,
  WorkspaceBootstrapError,
  type ManagerDeps,
} from "./manager.js";
import { completionScript, identityScript, shellQuote } from "./workspace.js";
import { findAnySession } from "./store.js";

/** Moteur simulé : il n'applique pas `:U`, les droits sont posés à la main. */
class FakeEngine implements Engine {
  readonly containers = new Map<string, ContainerInfo>();
  readonly execs: Array<{ name: string; argv: string[] }> = [];
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
  async stop(): Promise<void> {}
  async rm(name: string): Promise<void> {
    this.containers.delete(name);
  }
  async listSessions(): Promise<ContainerInfo[]> {
    return [...this.containers.values()];
  }
  async waitHealthy(): Promise<number> {
    return 1;
  }
  async exec(name: string, argv: string[]): Promise<string> {
    this.execs.push({ name, argv });
    return "";
  }
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

function makeManager(extra: Partial<ManagerDeps> = {}) {
  return createSessionManager({
    ...extra,
    db,
    engine,
    volumesRoot: root,
    graceMs: 60_000,
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
  root = await mkdtemp(join(tmpdir(), "v1-workspace-"));
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

/** Dépôt nu servant de « forge » locale : `<root>/forge/<owner>/<name>.git`. */
function forgePath(owner: string, name: string): string {
  return join(root, "forge", owner, `${name}.git`);
}
const localForgeUrl = (repo: { owner: string; name: string }): string =>
  forgePath(repo.owner, repo.name);

describe("échec bruyant de l'amorçage", () => {
  it("un dépôt cible injoignable refuse la session, sans lancer de conteneur", async () => {
    const assignment = await insertAssignment({ targetRepoPattern: "org/tp-{student}" });
    const seen: Array<{ owner: string; name: string }> = [];
    const manager = makeManager({
      // Port 1 : connexion refusée immédiatement, aucun accès réseau réel.
      forgeUrlOf: (repo) => `http://127.0.0.1:1/${repo.owner}/${repo.name}.git`,
      forgeAuthorization: async (repo) => {
        seen.push(repo);
        return "Bearer ghs_jeton";
      },
    });

    await expect(manager.start(user, assignment)).rejects.toBeInstanceOf(WorkspaceBootstrapError);
    expect(engine.runs).toBe(0);
    expect(findAnySession(db, "student", "tp")?.state).toBe("failed");
    // L'autorisation a bien été demandée pour le dépôt **source**.
    expect(seen).toEqual([{ owner: "org", name: "tp-student" }]);
  });

  it("une forge non configurée reste une cause nommée pour l'étudiant", async () => {
    const assignment = await insertAssignment({ targetRepoPattern: "org/tp-{student}" });
    const manager = makeManager({
      forgeUrlOf: (repo) => `http://127.0.0.1:1/${repo.owner}/${repo.name}.git`,
      forgeAuthorization: async () => {
        throw new ForgeUnconfiguredError("pas d'App");
      },
    });
    const err = await manager.start(user, assignment).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceBootstrapError);
    expect((err as WorkspaceBootstrapError).shortCause).toMatch(/accès à org\/tp-student/);
    expect(engine.runs).toBe(0);
  });

  it("un dépôt cible sans aucune branche est autorisé en mode travaux pratiques", async () => {
    const assignment = await insertAssignment({ targetRepoPattern: "org/tp-{student}" });
    // Ce que classroom vient de provisionner : un dépôt nu, sans commit.
    await git(["init", "--bare", "-q", forgePath("org", "tp-student")]);
    const manager = makeManager({ forgeUrlOf: localForgeUrl });

    const { session } = await manager.start(user, assignment);
    expect(engine.runs).toBe(1);
    expect(await refSnapshot(join(session.volumeDir, "staging.git"))).toEqual(new Map());
  });

  it("en mode examen, un modèle sans branche refuse la session", async () => {
    await git(["init", "--bare", "-q", forgePath("org", "modele")]);
    const assignment = await insertAssignment({
      id: "exam",
      mode: "exam",
      templateRepo: forgePath("org", "modele"),
    });
    const manager = makeManager();
    const err = await manager.start(user, assignment).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceBootstrapError);
    expect((err as WorkspaceBootstrapError).shortCause).toMatch(/aucune branche/);
    expect(engine.runs).toBe(0);
  });
});

describe("reprise : dépôt de transit vide, espace de travail à compléter", () => {
  /** L'état laissé par le premier essai réel : tout est là, mais tout est vide. */
  async function sessionSansDepot(): Promise<{
    assignment: AssignmentRow;
    sessionId: string;
    volumeDir: string;
  }> {
    const assignment = await insertAssignment({ targetRepoPattern: "org/tp-{student}" });
    await git(["init", "--bare", "-q", forgePath("org", "tp-student")]);
    const manager = makeManager({ forgeUrlOf: localForgeUrl });
    const { session } = await manager.start(user, assignment);
    // L'étudiant a écrit un fichier dans un espace de travail vide.
    await writeFile(join(session.volumeDir, "work", "test"), "Excellent", "utf8");
    return { assignment, sessionId: session.id, volumeDir: session.volumeDir };
  }

  /** Le dépôt de l'étudiant, tel qu'il aurait dû être récupéré. */
  async function remplirLaForge(branch = "master"): Promise<void> {
    const src = await makeSourceRepo({
      dir: join(root, "amont"),
      branch,
      files: { "quadratic.c": "int main(void){return 0;}\n", "Makefile": "all:\n\t@true\n" },
      message: "sujet du labo",
    });
    await git(["push", "--mirror", forgePath("org", "tp-student")], {
      env: { GIT_DIR: src.gitDir },
    });
  }

  it("réamorce, pose la branche par défaut et son suivi, et garde les fichiers de l'étudiant", async () => {
    const { assignment, volumeDir } = await sessionSansDepot();
    await remplirLaForge("master");
    engine.kill(containerNameFor(findAnySession(db, "student", "tp")!.id));

    const manager = makeManager({ forgeUrlOf: localForgeUrl });
    await manager.start(user, assignment);

    const work = join(volumeDir, "work");
    const refs = await refSnapshot(join(volumeDir, "staging.git"));
    expect([...refs.keys()]).toEqual(["refs/heads/master"]);
    // `git pull` et `git push` sans argument doivent marcher dans le conteneur.
    expect((await git(["-C", work, "branch", "--show-current"])).trim()).toBe("master");
    expect(
      (
        await git(["-C", work, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
      ).trim(),
    ).toBe("origin/master");
    expect((await git(["-C", work, "ls-files"])).split("\n").filter(Boolean).sort()).toEqual([
      "Makefile",
      "quadratic.c",
    ]);
    // Le fichier que l'étudiant avait écrit est toujours là, non suivi.
    expect((await git(["-C", work, "status", "--porcelain"])).trim()).toBe("?? test");
  });

  it("le conteneur vivant n'est pas relancé, mais le dépôt de transit est réamorcé", async () => {
    const { assignment, volumeDir } = await sessionSansDepot();
    await remplirLaForge("master");

    const manager = makeManager({ forgeUrlOf: localForgeUrl });
    const again = await manager.start(user, assignment);
    expect(again.launched).toBe(false);
    expect(engine.runs).toBe(1);
    expect([...(await refSnapshot(join(volumeDir, "staging.git"))).keys()]).toEqual([
      "refs/heads/master",
    ]);
  });

  it("quand work/ appartient au conteneur, l'achèvement passe par podman exec", async () => {
    if (process.getuid?.() === 0) return; // root ignore les droits : le cas ne se simule pas.
    const { assignment, volumeDir } = await sessionSansDepot();
    await remplirLaForge("master");
    const work = join(volumeDir, "work");
    // Ce que `:U` fait : `work/` n'appartient plus au portail.
    await chmod(work, 0o555);
    try {
      engine.kill(containerNameFor(findAnySession(db, "student", "tp")!.id));
      const manager = makeManager({ forgeUrlOf: localForgeUrl });
      await manager.start(user, assignment);
    } finally {
      await chmod(work, 0o755);
    }

    const exec = engine.execs.at(-1);
    expect(exec?.argv[0]).toBe("sh");
    expect(exec?.argv[2]).toBe(completionScript("master"));
    expect(exec?.argv[2]).toContain("git fetch -q origin");
    expect(exec?.argv[2]).toContain("git checkout -q -B 'master' 'origin/master'");
    expect(exec?.argv[2]).toContain("--set-upstream-to='origin/master'");
    // Aucun secret n'entre dans le conteneur (invariant 1).
    expect(exec?.argv[2]).not.toMatch(/Authorization|ghs_|token/);
  });

  it("un dépôt de travail qui porte déjà des commits n'est jamais retouché", async () => {
    const { assignment, volumeDir } = await sessionSansDepot();
    const work = join(volumeDir, "work");
    await git(["-C", work, "add", "-A"], { env: FIXTURE_ENV });
    await git(["-C", work, "commit", "-q", "-m", "travail de l'étudiant"], { env: FIXTURE_ENV });
    const sha = (await git(["-C", work, "rev-parse", "HEAD"])).trim();

    await remplirLaForge("master");
    engine.kill(containerNameFor(findAnySession(db, "student", "tp")!.id));
    const manager = makeManager({ forgeUrlOf: localForgeUrl });
    await manager.start(user, assignment);

    expect((await git(["-C", work, "rev-parse", "HEAD"])).trim()).toBe(sha);
    expect(engine.execs).toEqual([]);
  });
});

describe("identité git de l'étudiant dans work/.git/config", () => {
  async function config(work: string, key: string): Promise<string> {
    return (await git(["-C", work, "config", "--local", "--get", key]).catch(() => "")).trim();
  }

  it("est posée à l'amorçage, depuis l'hôte, avant le podman run", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, assignment);
    const work = join(session.volumeDir, "work");
    expect(await config(work, "user.name")).toBe("Sacha Student");
    expect(await config(work, "user.email")).toBe("student@heig-vd.ch");
    // Rien n'est passé par le conteneur : l'hôte pouvait encore écrire.
    expect(engine.execs).toEqual([]);
  });

  it("n'écrase jamais l'identité que l'étudiant a posée lui-même", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, assignment);
    const work = join(session.volumeDir, "work");
    await git(["-C", work, "config", "--local", "user.name", "Pseudonyme"]);
    engine.kill(containerNameFor(session.id));
    await makeManager().start(user, assignment);
    expect(await config(work, "user.name")).toBe("Pseudonyme");
  });

  it("passe par podman exec quand work/ appartient déjà au conteneur", async () => {
    if (process.getuid?.() === 0) return; // root ignore les droits.
    const assignment = await insertAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, assignment);
    const work = join(session.volumeDir, "work");
    await chmod(work, 0o555);
    try {
      engine.kill(containerNameFor(session.id));
      await makeManager().start(user, assignment);
    } finally {
      await chmod(work, 0o755);
    }
    const exec = engine.execs.find((e) => e.argv[2]?.includes("user.email"));
    expect(exec?.argv[0]).toBe("sh");
    expect(exec?.argv[2]).toBe(identityScript({ name: "Sacha Student", email: "student@heig-vd.ch" }));
    // Aucun secret n'entre dans le conteneur (invariant 1).
    expect(exec?.argv[2]).not.toMatch(/Authorization|ghs_|token/);
  });

  it("le script n'écrase rien, sort sans bruit hors dépôt, et cite proprement", () => {
    const script = identityScript({ name: "Jean-Luc D'Arc", email: "j@heig-vd.ch" });
    expect(script).toContain("git rev-parse --git-dir >/dev/null 2>&1 || exit 0");
    expect(script).toContain("git config --local --get user.name >/dev/null 2>&1 ||");
    expect(script).toContain(`user.name 'Jean-Luc D'\\''Arc'`);
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
});

describe("repoRefFromUrl et shortCauseOf", () => {
  it("découpe une URL de clonage", () => {
    expect(repoRefFromUrl("https://github.com/org/depot.git")).toEqual({
      owner: "org",
      name: "depot",
    });
    expect(repoRefFromUrl("https://github.com/org/depot")).toEqual({ owner: "org", name: "depot" });
    // Un chemin local n'est pas un dépôt de forge : pas d'autorisation à poser.
    expect(repoRefFromUrl("/srv/codespace/volumes/e/d/source.git")).toBeUndefined();
  });

  it("nomme la cause en français, sans jargon de git", () => {
    const repo = { owner: "org", name: "depot" };
    expect(shortCauseOf(new ForgeUnconfiguredError("x"), repo)).toBe(
      "le portail n'a pas les accès à org/depot",
    );
    expect(shortCauseOf(new Error("remote: Repository not found"), repo)).toBe(
      "dépôt org/depot introuvable",
    );
    expect(shortCauseOf(new Error("fatal: Authentication failed"), repo)).toBe(
      "accès refusé au dépôt org/depot",
    );
    expect(shortCauseOf(new Error("Connection refused"), repo)).toBe(
      "récupération de org/depot impossible",
    );
  });
});

describe("branche par défaut", () => {
  it("suit ce que classroom annonce, pas la première branche venue", () => {
    const lab = { mode: "lab", sourceRepo: null } as unknown as AssignmentRow;
    expect(
      defaultBranchOf({ targetRepo: { fullName: "o/d", defaultBranch: "master" } }, lab),
    ).toBe("master");
    // Invariant 6 : en examen, la branche du modèle de l'enseignant.
    const exam = {
      mode: "exam",
      sourceRepo: { fullName: "o/modele", defaultBranch: "trunk" },
    } as unknown as AssignmentRow;
    expect(
      defaultBranchOf({ targetRepo: { fullName: "o/d", defaultBranch: "master" } }, exam),
    ).toBe("trunk");
    expect(defaultBranchOf({ targetRepo: null }, lab)).toBe("main");
  });

  it("le dépôt a `grading` avant `master` : c'est `master` qui est posée, avec son suivi", async () => {
    const assignment = await insertAssignment({
      targetRepoPattern: "org/tp-{student}",
      sourceRepo: { fullName: "org/tp-student", defaultBranch: "master" },
    });
    // Ce que la CI de classroom laisse dans un dépôt d'étudiant : une branche
    // `grading` qui trie avant `master` et qui n'est pas le travail.
    const src = await makeSourceRepo({
      dir: join(root, "amont"),
      branch: "master",
      files: { "quadratic.c": "int main(void){return 0;}\n" },
      message: "sujet",
    });
    await git(["branch", "grading", "master"], { env: { GIT_DIR: src.gitDir } });
    await git(["init", "--bare", "-q", forgePath("org", "tp-student")]);
    await git(["push", "--mirror", forgePath("org", "tp-student")], {
      env: { GIT_DIR: src.gitDir },
    });

    const manager = makeManager({ forgeUrlOf: localForgeUrl });
    const { session } = await manager.start(user, assignment);
    const work = join(session.volumeDir, "work");

    expect(
      (await gitBare(join(session.volumeDir, "staging.git"), ["symbolic-ref", "HEAD"])).trim(),
    ).toBe("refs/heads/master");
    expect((await git(["-C", work, "branch", "--show-current"])).trim()).toBe("master");
    expect(
      (
        await git(["-C", work, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
      ).trim(),
    ).toBe("origin/master");
  });
});
