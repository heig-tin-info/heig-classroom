/**
 * Workspace seeding — the 2026-09-17 fix.
 *
 * These tests are **unit tests**: the engine is faked, `git` is the real one,
 * and the "forge" is a local bare repository. They fit in a `pnpm test`,
 * without Podman nor Forgejo, because what is checked here is the portal's
 * logic: loud failure, empty target repository allowed in lab mode, re-seeding
 * on resumption, working branch with tracking.
 *
 * What the portal used to do, and what cost the production trial: anonymous
 * `git fetch` on a private repository, failure swallowed, session opened on an
 * empty directory.
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

/** Fake engine: it does not apply `:U`, the permissions are set by hand. */
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

/** Bare repository used as a local "forge": `<root>/forge/<owner>/<name>.git`. */
function forgePath(owner: string, name: string): string {
  return join(root, "forge", owner, `${name}.git`);
}
const localForgeUrl = (repo: { owner: string; name: string }): string =>
  forgePath(repo.owner, repo.name);

describe("loud failure of the seeding", () => {
  it("an unreachable target repository refuses the session, without launching a container", async () => {
    const assignment = await insertAssignment({ targetRepoPattern: "org/tp-{student}" });
    const seen: Array<{ owner: string; name: string }> = [];
    const manager = makeManager({
      // Port 1: connection refused immediately, no real network access.
      forgeUrlOf: (repo) => `http://127.0.0.1:1/${repo.owner}/${repo.name}.git`,
      forgeAuthorization: async (repo) => {
        seen.push(repo);
        return "Bearer ghs_token";
      },
    });

    await expect(manager.start(user, assignment)).rejects.toBeInstanceOf(WorkspaceBootstrapError);
    expect(engine.runs).toBe(0);
    expect(findAnySession(db, "student", "tp")?.state).toBe("failed");
    // The authorization was indeed requested for the **source** repository.
    expect(seen).toEqual([{ owner: "org", name: "tp-student" }]);
  });

  it("an unconfigured forge stays a named cause for the student", async () => {
    const assignment = await insertAssignment({ targetRepoPattern: "org/tp-{student}" });
    const manager = makeManager({
      forgeUrlOf: (repo) => `http://127.0.0.1:1/${repo.owner}/${repo.name}.git`,
      forgeAuthorization: async () => {
        throw new ForgeUnconfiguredError("no App");
      },
    });
    const err = await manager.start(user, assignment).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceBootstrapError);
    expect((err as WorkspaceBootstrapError).shortCause).toMatch(/accès à org\/tp-student/);
    expect(engine.runs).toBe(0);
  });

  it("a target repository with no branch at all is allowed in lab mode", async () => {
    const assignment = await insertAssignment({ targetRepoPattern: "org/tp-{student}" });
    // What classroom has just provisioned: a bare repository, without a commit.
    await git(["init", "--bare", "-q", forgePath("org", "tp-student")]);
    const manager = makeManager({ forgeUrlOf: localForgeUrl });

    const { session } = await manager.start(user, assignment);
    expect(engine.runs).toBe(1);
    expect(await refSnapshot(join(session.volumeDir, "staging.git"))).toEqual(new Map());
  });

  it("in exam mode, a template without a branch refuses the session", async () => {
    await git(["init", "--bare", "-q", forgePath("org", "template")]);
    const assignment = await insertAssignment({
      id: "exam",
      mode: "exam",
      templateRepo: forgePath("org", "template"),
    });
    const manager = makeManager();
    const err = await manager.start(user, assignment).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceBootstrapError);
    expect((err as WorkspaceBootstrapError).shortCause).toMatch(/aucune branche/);
    expect(engine.runs).toBe(0);
  });
});

describe("resumption: empty staging repository, workspace to be completed", () => {
  /** The state left by the first real trial: everything is there, but everything is empty. */
  async function sessionWithoutRepo(): Promise<{
    assignment: AssignmentRow;
    sessionId: string;
    volumeDir: string;
  }> {
    const assignment = await insertAssignment({ targetRepoPattern: "org/tp-{student}" });
    await git(["init", "--bare", "-q", forgePath("org", "tp-student")]);
    const manager = makeManager({ forgeUrlOf: localForgeUrl });
    const { session } = await manager.start(user, assignment);
    // The student wrote a file into an empty workspace.
    await writeFile(join(session.volumeDir, "work", "test"), "Excellent", "utf8");
    return { assignment, sessionId: session.id, volumeDir: session.volumeDir };
  }

  /** The student's repository, as it should have been fetched. */
  async function fillTheForge(branch = "master"): Promise<void> {
    const src = await makeSourceRepo({
      dir: join(root, "amont"),
      branch,
      files: { "quadratic.c": "int main(void){return 0;}\n", "Makefile": "all:\n\t@true\n" },
      message: "lab statement",
    });
    await git(["push", "--mirror", forgePath("org", "tp-student")], {
      env: { GIT_DIR: src.gitDir },
    });
  }

  it("re-seeds, sets the default branch and its tracking, and keeps the student's files", async () => {
    const { assignment, volumeDir } = await sessionWithoutRepo();
    await fillTheForge("master");
    engine.kill(containerNameFor(findAnySession(db, "student", "tp")!.id));

    const manager = makeManager({ forgeUrlOf: localForgeUrl });
    await manager.start(user, assignment);

    const work = join(volumeDir, "work");
    const refs = await refSnapshot(join(volumeDir, "staging.git"));
    expect([...refs.keys()]).toEqual(["refs/heads/master"]);
    // Argument-less `git pull` and `git push` must work inside the container.
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
    // The file the student had written is still there, untracked.
    expect((await git(["-C", work, "status", "--porcelain"])).trim()).toBe("?? test");
  });

  it("the live container is not relaunched, but the staging repository is re-seeded", async () => {
    const { assignment, volumeDir } = await sessionWithoutRepo();
    await fillTheForge("master");

    const manager = makeManager({ forgeUrlOf: localForgeUrl });
    const again = await manager.start(user, assignment);
    expect(again.launched).toBe(false);
    expect(engine.runs).toBe(1);
    expect([...(await refSnapshot(join(volumeDir, "staging.git"))).keys()]).toEqual([
      "refs/heads/master",
    ]);
  });

  it("when work/ belongs to the container, completion goes through podman exec", async () => {
    if (process.getuid?.() === 0) return; // root ignores permissions: the case cannot be simulated.
    const { assignment, volumeDir } = await sessionWithoutRepo();
    await fillTheForge("master");
    const work = join(volumeDir, "work");
    // What `:U` does: `work/` no longer belongs to the portal.
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
    // No secret enters the container (invariant 1).
    expect(exec?.argv[2]).not.toMatch(/Authorization|ghs_|token/);
  });

  it("a working repository that already carries commits is never touched again", async () => {
    const { assignment, volumeDir } = await sessionWithoutRepo();
    const work = join(volumeDir, "work");
    await git(["-C", work, "add", "-A"], { env: FIXTURE_ENV });
    await git(["-C", work, "commit", "-q", "-m", "the student's work"], { env: FIXTURE_ENV });
    const sha = (await git(["-C", work, "rev-parse", "HEAD"])).trim();

    await fillTheForge("master");
    engine.kill(containerNameFor(findAnySession(db, "student", "tp")!.id));
    const manager = makeManager({ forgeUrlOf: localForgeUrl });
    await manager.start(user, assignment);

    expect((await git(["-C", work, "rev-parse", "HEAD"])).trim()).toBe(sha);
    expect(engine.execs).toEqual([]);
  });
});

describe("the student's git identity in work/.git/config", () => {
  async function config(work: string, key: string): Promise<string> {
    return (await git(["-C", work, "config", "--local", "--get", key]).catch(() => "")).trim();
  }

  it("is set at seeding time, from the host, before the podman run", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, assignment);
    const work = join(session.volumeDir, "work");
    expect(await config(work, "user.name")).toBe("Sacha Student");
    expect(await config(work, "user.email")).toBe("student@heig-vd.ch");
    // Nothing went through the container: the host could still write.
    expect(engine.execs).toEqual([]);
  });

  it("never overwrites the identity the student set themselves", async () => {
    const assignment = await insertAssignment();
    const manager = makeManager();
    const { session } = await manager.start(user, assignment);
    const work = join(session.volumeDir, "work");
    await git(["-C", work, "config", "--local", "user.name", "Pseudonym"]);
    engine.kill(containerNameFor(session.id));
    await makeManager().start(user, assignment);
    expect(await config(work, "user.name")).toBe("Pseudonym");
  });

  it("goes through podman exec when work/ already belongs to the container", async () => {
    if (process.getuid?.() === 0) return; // root ignores permissions.
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
    // No secret enters the container (invariant 1).
    expect(exec?.argv[2]).not.toMatch(/Authorization|ghs_|token/);
  });

  it("the script overwrites nothing, exits quietly outside a repository, and quotes properly", () => {
    const script = identityScript({ name: "Jean-Luc D'Arc", email: "j@heig-vd.ch" });
    expect(script).toContain("git rev-parse --git-dir >/dev/null 2>&1 || exit 0");
    expect(script).toContain("git config --local --get user.name >/dev/null 2>&1 ||");
    expect(script).toContain(`user.name 'Jean-Luc D'\\''Arc'`);
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
});

describe("repoRefFromUrl et shortCauseOf", () => {
  it("splits a clone URL", () => {
    expect(repoRefFromUrl("https://github.com/org/depot.git")).toEqual({
      owner: "org",
      name: "depot",
    });
    expect(repoRefFromUrl("https://github.com/org/depot")).toEqual({ owner: "org", name: "depot" });
    // A local path is not a forge repository: no authorization to set.
    expect(repoRefFromUrl("/srv/codespace/volumes/e/d/source.git")).toBeUndefined();
  });

  it("names the cause in French, without git jargon", () => {
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

describe("default branch", () => {
  it("follows what classroom announces, not the first branch that comes", () => {
    const lab = { mode: "lab", sourceRepo: null } as unknown as AssignmentRow;
    expect(
      defaultBranchOf({ targetRepo: { fullName: "o/d", defaultBranch: "master" } }, lab),
    ).toBe("master");
    // Invariant 6: in an exam, the branch of the teacher's template.
    const exam = {
      mode: "exam",
      sourceRepo: { fullName: "o/modele", defaultBranch: "trunk" },
    } as unknown as AssignmentRow;
    expect(
      defaultBranchOf({ targetRepo: { fullName: "o/d", defaultBranch: "master" } }, exam),
    ).toBe("trunk");
    expect(defaultBranchOf({ targetRepo: null }, lab)).toBe("main");
  });

  it("the repository has `grading` before `master`: it is `master` that is set, with its tracking", async () => {
    const assignment = await insertAssignment({
      targetRepoPattern: "org/tp-{student}",
      sourceRepo: { fullName: "org/tp-student", defaultBranch: "master" },
    });
    // What classroom's CI leaves in a student repository: a `grading` branch
    // that sorts before `master` and that is not the work.
    const src = await makeSourceRepo({
      dir: join(root, "amont"),
      branch: "master",
      files: { "quadratic.c": "int main(void){return 0;}\n" },
      message: "statement",
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
