import { createServer, type Server } from "node:net";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openGitDb } from "../db/client.js";
import { FIXTURE_ENV, makeSourceRepo, tempDir } from "./fixtures.js";
import { createUnconfiguredGithubForge, type Forge } from "./forge.js";
import { git, gitBare } from "./gitRunner.js";
import { createPushEventStore, recordPush, NULL_OID, type PushEventRow } from "./pushEvents.js";
import {
  buildPushArgs,
  buildPushEnv,
  createRelayWorker,
  refspecFor,
  stagingTargets,
  UNCONFIGURED_BACKOFF,
} from "./relay.js";
import { ensureStagingRepo } from "./staging.js";
import type { RepoRef, StagingSession } from "./types.js";

const dirs: string[] = [];
async function root(): Promise<string> {
  const dir = await tempDir("p3-relay-");
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const SESSION: StagingSession = {
  sessionId: "s-relay",
  student: "e1234567",
  assignment: "tp-pointeurs",
  containerIp: "10.77.0.7",
  uploadPack: true,
  targetRepo: { owner: "codespace", name: "tp" },
};

/** The token the tests hunt for. */
const TOKEN = "forgejo-tok-4f2b9c1d7e0a5b3c";

/** A forge whose push URL is a local bare repository, switchable at will. */
function fakeForge(urlOf: () => string): Forge & { calls: number } {
  return {
    kind: "forgejo",
    calls: 0,
    pushUrl: () => urlOf(),
    authorization: async () => `token ${TOKEN}`,
    async ensureRepo() {
      /* the bare repo is created by the test */
    },
  };
}

describe("refspecs", () => {
  it("pousse un sha précis, en force (le dépôt de transit fait autorité)", () => {
    expect(refspecFor({ ref: "refs/heads/main", sha: "a".repeat(40) })).toBe(
      `+${"a".repeat(40)}:refs/heads/main`,
    );
  });

  it("propage une suppression de ref", () => {
    expect(refspecFor({ ref: "refs/heads/vieille", sha: NULL_OID })).toBe(":refs/heads/vieille");
  });
});

describe("passage du jeton", () => {
  it("n'est ni dans argv ni dans un fichier : seulement dans l'environnement", () => {
    const args = buildPushArgs("/vol/staging.git", "https://forge/e/tp.git", ["+abc:refs/heads/main"]);
    expect(args.join(" ")).not.toContain(TOKEN);
    expect(args.join(" ")).not.toMatch(/extraHeader/i);

    const env = buildPushEnv(`token ${TOKEN}`);
    expect(env["GIT_CONFIG_COUNT"]).toBe("1");
    expect(env["GIT_CONFIG_KEY_0"]).toBe("http.extraHeader");
    expect(env["GIT_CONFIG_VALUE_0"]).toBe(`Authorization: token ${TOKEN}`);
    // No `-c`, no `--config-env`, no temporary file: the three ways a token
    // would have become visible in `ps` or on disk.
    expect(Object.keys(env)).toEqual(["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]);
  });
});

describe("cadence d'une forge non configurée", () => {
  it("part d'une minute, double, et plafonne à une heure", () => {
    expect(UNCONFIGURED_BACKOFF(1)).toBe(60_000);
    expect(UNCONFIGURED_BACKOFF(2)).toBe(120_000);
    expect(UNCONFIGURED_BACKOFF(6)).toBe(1_920_000);
    expect(UNCONFIGURED_BACKOFF(7)).toBe(3_600_000);
    expect(UNCONFIGURED_BACKOFF(517)).toBe(3_600_000);
  });
});

describe("createRelayWorker", () => {
  async function scenario() {
    const base = await root();
    const volumesRoot = join(base, "volumes");
    const src = await makeSourceRepo({ dir: join(base, "src"), files: { "main.c": "int main(){}\n" } });
    const staging = await ensureStagingRepo({
      volumesRoot,
      student: SESSION.student,
      assignment: SESSION.assignment,
      source: { mode: "lab", mirrorFrom: src.gitDir },
    });
    const forgeRepo = join(base, "forge.git");
    await git(["init", "--bare", forgeRepo], { env: FIXTURE_ENV });
    const { db, close } = openGitDb(":memory:");
    const store = createPushEventStore(db);
    const repoOf = (): RepoRef | undefined => SESSION.targetRepo;
    return { base, volumesRoot, staging, forgeRepo, store, close, src, repoOf };
  }

  it("relaie les refs enregistrées puis marque relayed", async () => {
    const s = await scenario();
    const forge = fakeForge(() => s.forgeRepo);
    const worker = createRelayWorker({
      store: s.store,
      forge,
      targets: stagingTargets(s.volumesRoot, s.repoOf),
      backoffMs: () => 0,
    });

    await recordPush({ store: s.store }, SESSION, [
      { ref: "refs/heads/main", oldSha: null, sha: s.src.sha },
    ]);
    const result = await worker.runOnce();

    expect(result).toEqual({ relayed: 1, retried: 0, failed: 0 });
    expect((await gitBare(s.forgeRepo, ["rev-parse", "refs/heads/main"])).trim()).toBe(s.src.sha);
    const rows = await s.store.bySession(SESSION.sessionId);
    expect(rows[0]?.state).toBe("relayed");
    s.close();
  });

  it("forge injoignable : la ligne reste pending, puis passe relayed au retour", async () => {
    const s = await scenario();
    let target = join(s.base, "forge-absente.git");
    const worker = createRelayWorker({
      store: s.store,
      forge: fakeForge(() => target),
      targets: stagingTargets(s.volumesRoot, s.repoOf),
      backoffMs: () => 0,
      maxAttempts: 5,
    });

    await recordPush({ store: s.store }, SESSION, [
      { ref: "refs/heads/main", oldSha: null, sha: s.src.sha },
    ]);

    expect(await worker.runOnce()).toEqual({ relayed: 0, retried: 1, failed: 0 });
    let row = (await s.store.bySession(SESSION.sessionId))[0] as PushEventRow;
    // The student's push already succeeded: the submission is not at risk.
    expect(row.state).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBeTruthy();

    target = s.forgeRepo; // the forge comes back
    expect(await worker.runOnce()).toEqual({ relayed: 1, retried: 0, failed: 0 });
    row = (await s.store.bySession(SESSION.sessionId))[0] as PushEventRow;
    expect(row.state).toBe("relayed");
    s.close();
  });

  it("déclare failed seulement après épuisement du budget de tentatives", async () => {
    const s = await scenario();
    const worker = createRelayWorker({
      store: s.store,
      forge: fakeForge(() => join(s.base, "jamais.git")),
      targets: stagingTargets(s.volumesRoot, s.repoOf),
      backoffMs: () => 0,
      maxAttempts: 2,
    });
    await recordPush({ store: s.store }, SESSION, [
      { ref: "refs/heads/main", oldSha: null, sha: s.src.sha },
    ]);
    expect((await worker.runOnce()).retried).toBe(1);
    expect((await worker.runOnce()).failed).toBe(1);
    expect((await s.store.bySession(SESSION.sessionId))[0]?.state).toBe("failed");
    s.close();
  });

  it("forge non configurée : la ligne reste pending indéfiniment, avec l'erreur nommée", async () => {
    // Déploiement sans GitHub App (docs/deploy.md) : le rendu est enregistré,
    // le service ne tombe pas, et la ligne ne doit **jamais** passer `failed` —
    // elle n'a pas eu de destination, ce n'est pas une panne de la forge.
    const s = await scenario();
    const worker = createRelayWorker({
      store: s.store,
      forge: createUnconfiguredGithubForge(),
      targets: stagingTargets(s.volumesRoot, s.repoOf),
      backoffMs: () => 0,
      unconfiguredBackoffMs: () => 0,
      maxAttempts: 2,
    });
    await recordPush({ store: s.store }, SESSION, [
      { ref: "refs/heads/main", oldSha: null, sha: s.src.sha },
    ]);
    for (let i = 0; i < 4; i++) {
      expect(await worker.runOnce()).toEqual({ relayed: 0, retried: 1, failed: 0 });
    }
    const row = (await s.store.bySession(SESSION.sessionId))[0] as PushEventRow;
    expect(row.state).toBe("pending");
    expect(row.attempts).toBe(4);
    expect(row.lastError).toMatch(/GitHub App non configurée/);
    s.close();
  });

  it("forge non configurée : une tentative par heure au plus, et un seul warn", async () => {
    // Mesuré en production : 517 tentatives et 517 `warn`, un par minute. Le
    // « pending, jamais failed » est voulu ; la cadence, non.
    const s = await scenario();
    const warns: string[] = [];
    let clock = new Date("2026-09-18T08:00:00Z");
    const worker = createRelayWorker({
      store: s.store,
      forge: createUnconfiguredGithubForge(),
      targets: stagingTargets(s.volumesRoot, s.repoOf),
      maxAttempts: 2,
      now: () => clock,
      log: { info: () => undefined, warn: (_o, m) => warns.push(m) },
    });
    await recordPush({ store: s.store }, SESSION, [
      { ref: "refs/heads/main", oldSha: null, sha: s.src.sha },
    ]);

    const waits: number[] = [];
    for (let i = 0; i < 12; i++) {
      expect(await worker.runOnce()).toEqual({ relayed: 0, retried: 1, failed: 0 });
      const row = (await s.store.bySession(SESSION.sessionId))[0] as PushEventRow;
      waits.push((row.nextAttemptAt as Date).getTime() - clock.getTime());
      clock = row.nextAttemptAt as Date; // on saute directement à l'échéance
    }

    // 1 min, 2, 4, 8, 16, 32, puis le plafond d'une heure.
    expect(waits.slice(0, 6)).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000]);
    expect(waits.slice(6)).toEqual(Array(6).fill(3_600_000));
    // Douze tentatives, un seul warn : le journal reste lisible.
    expect(warns).toEqual(["relais en attente : la forge n'est pas configurée pour ce dépôt"]);
    // Et la ligne n'est toujours pas `failed` : elle n'a jamais eu de destination.
    expect((await s.store.bySession(SESSION.sessionId))[0]?.state).toBe("pending");
    s.close();
  });

  it("une panne ordinaire garde sa cadence et son warn par tentative", async () => {
    const s = await scenario();
    const warns: string[] = [];
    const worker = createRelayWorker({
      store: s.store,
      forge: fakeForge(() => join(s.base, "jamais.git")),
      targets: stagingTargets(s.volumesRoot, s.repoOf),
      backoffMs: () => 0,
      maxAttempts: 5,
      log: { info: () => undefined, warn: (_o, m) => warns.push(m) },
    });
    await recordPush({ store: s.store }, SESSION, [
      { ref: "refs/heads/main", oldSha: null, sha: s.src.sha },
    ]);
    await worker.runOnce();
    await worker.runOnce();
    expect(warns).toEqual([
      "relais en échec, nouvelle tentative programmée",
      "relais en échec, nouvelle tentative programmée",
    ]);
    s.close();
  });

  it("ne pousse qu'une fois la dernière valeur d'une ref poussée plusieurs fois", async () => {
    const s = await scenario();
    const clone = join(s.base, "clone");
    await git(["clone", s.staging.gitDir, clone], { env: FIXTURE_ENV });
    await git(["-C", clone, "commit", "--allow-empty", "-m", "deuxième"], { env: FIXTURE_ENV });
    await git(["-C", clone, "push", "origin", "HEAD:main"], { env: FIXTURE_ENV });
    const head = (await git(["-C", clone, "rev-parse", "HEAD"], { env: FIXTURE_ENV })).trim();

    await recordPush({ store: s.store }, SESSION, [
      { ref: "refs/heads/main", oldSha: null, sha: s.src.sha },
    ]);
    await recordPush({ store: s.store }, SESSION, [
      { ref: "refs/heads/main", oldSha: s.src.sha, sha: head },
    ]);

    const worker = createRelayWorker({
      store: s.store,
      forge: fakeForge(() => s.forgeRepo),
      targets: stagingTargets(s.volumesRoot, s.repoOf),
      backoffMs: () => 0,
    });
    expect((await worker.runOnce()).relayed).toBe(2);
    expect((await gitBare(s.forgeRepo, ["rev-parse", "refs/heads/main"])).trim()).toBe(head);
    s.close();
  });

  it("sans dépôt cible, le push reste local et la ligne est close", async () => {
    const s = await scenario();
    const worker = createRelayWorker({
      store: s.store,
      forge: fakeForge(() => s.forgeRepo),
      targets: stagingTargets(s.volumesRoot, () => undefined),
      backoffMs: () => 0,
    });
    await recordPush({ store: s.store }, SESSION, [
      { ref: "refs/heads/main", oldSha: null, sha: s.src.sha },
    ]);
    expect((await worker.runOnce()).relayed).toBe(1);
    s.close();
  });
});

/** Every `/proc/<pid>/cmdline` that contains `needle`. */
async function cmdlinesContaining(needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const raw = await readFile(`/proc/${entry}/cmdline`, "utf8");
      if (raw.includes(needle)) hits.push(`${entry}: ${raw.replace(/\0/g, " ")}`);
    } catch {
      /* the process is gone, or not ours */
    }
  }
  return hits;
}

/** Every file under `dir` whose bytes contain `needle`. */
async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) hits.push(...(await filesContaining(path, needle)));
    else if (entry.isFile()) {
      const raw = await readFile(path).catch(() => Buffer.alloc(0));
      if (raw.includes(needle)) hits.push(path);
    }
  }
  return hits;
}

describe("jeton invisible pendant un relais", () => {
  it("n'apparaît dans aucun /proc/*/cmdline ni sur le disque", async () => {
    const s = await root();
    const volumesRoot = join(s, "volumes");
    const src = await makeSourceRepo({ dir: join(s, "src"), files: { "a.c": "\n" } });
    await ensureStagingRepo({
      volumesRoot,
      student: SESSION.student,
      assignment: SESSION.assignment,
      source: { mode: "lab", mirrorFrom: src.gitDir },
    });
    const { db, close } = openGitDb(":memory:");
    const store = createPushEventStore(db);

    // A socket that accepts and never answers: the relay's `git push` is
    // genuinely in flight for as long as the scan needs.
    const server: Server = createServer(() => {
      /* hold the connection open */
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    const worker = createRelayWorker({
      store,
      forge: fakeForge(() => `http://127.0.0.1:${port}/e1234567/tp.git`),
      targets: stagingTargets(volumesRoot, () => SESSION.targetRepo),
      backoffMs: () => 0,
      pushTimeoutMs: 4000,
    });
    await recordPush({ store }, SESSION, [
      { ref: "refs/heads/main", oldSha: null, sha: src.sha },
    ]);

    const inFlight = worker.runOnce();
    let sawGitPush = false;
    const hits: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      hits.push(...(await cmdlinesContaining(TOKEN)));
      if ((await cmdlinesContaining(`127.0.0.1:${port}`)).length > 0) sawGitPush = true;
      if (sawGitPush && i > 5) break;
    }
    await inFlight;
    server.close();

    // The scan really did run while a relay was going on.
    expect(sawGitPush).toBe(true);
    expect(hits).toEqual([]);

    // And nothing wrote it down either: not the repository config, not a
    // credential file, not a stray temporary file next to the volume.
    expect(await filesContaining(s, TOKEN)).toEqual([]);
    close();
  });
});
