/**
 * P3 acceptance test (jalon-0) — needs Podman and Forgejo.
 *
 * What it proves, end to end and with a real container on the real
 * `codespace` bridge:
 *
 *   - a student container clones, commits and pushes over
 *     `http://portal.internal:9418/git/<session>`;
 *   - the `PushEvent` lands in the database with the right sha;
 *   - the commit reaches Forgejo in under ten seconds;
 *   - the same push from the host is 403;
 *   - Forgejo down: the student's push still succeeds, the event stays
 *     `pending`, and turns `relayed` when Forgejo comes back;
 *   - an assignment with `uploadpack: false` refuses fetch cleanly and
 *     accepts push.
 *
 * Network filtering is *not* tested here: that is P2 (`infra/net/test.sh`).
 * This test only needs the bridge to exist, and creates it idempotently
 * with the options CLAUDE.md fixes. It never deletes it, and never stops
 * Forgejo for good.
 *
 * Commands to bring the dependencies up by hand: see README.md.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openGitDb } from "../db/client.js";
import { FIXTURE_ENV, makeSourceRepo, tempDir } from "./fixtures.js";
import { createForgejoForge, type Forge } from "./forge.js";
import { git } from "./gitRunner.js";
import { startGitServer } from "./httpBackend.js";
import { createPushEventStore, type PushEventStore } from "./pushEvents.js";
import { createRelayWorker, stagingTargets, type RelayWorker } from "./relay.js";
import { ensureStagingRepo } from "./staging.js";
import type { RepoRef, SessionLookup, StagingSession } from "./types.js";

const execFileAsync = promisify(execFile);

// --- environment ------------------------------------------------------------

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const PODMAN_URL = "unix:///run/podman/podman.sock";
const NETWORK = "codespace";
const SUBNET = "10.77.0.0/24";
const GATEWAY = "10.77.0.254";
const GIT_PORT = 9418;
/** Fixed address for the test container; the portal assigns these in V1. */
const CONTAINER_IP = "10.77.0.42";
/** Image étudiante (P1) : elle porte git et vit sur le réseau clos. */
const GIT_IMAGE = process.env["CODESPACE_IMAGE"] ?? "codespace/c-dev:4.137.0";

/** `.env` at the repository root; git-ignored, holds the Forgejo token. */
function dotEnv(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(join(REPO_ROOT, ".env"), "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m?.[1]) out[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}
const ENV = { ...dotEnv(), ...process.env };
const FORGE_URL = ENV["FORGE_URL"]?.replace("localhost", "127.0.0.1") ?? "http://127.0.0.1:3300";
const FORGE_TOKEN = ENV["FORGE_TOKEN"] ?? "";
const FORGE_USER = ENV["FORGE_USER"] ?? "codespace";
const FORGE_CONTAINER = ENV["FORGE_CONTAINER"] ?? "infra_forgejo_1";

/** Always `--remote --url`: without it the CLI is silently rootless. */
async function podman(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("podman", ["--remote", "--url", PODMAN_URL, ...args], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function podmanOk(...args: string[]): Promise<boolean> {
  return podman(...args).then(
    () => true,
    () => false,
  );
}

async function forgeReachable(): Promise<boolean> {
  return fetch(`${FORGE_URL}/api/v1/version`, { signal: AbortSignal.timeout(2000) }).then(
    (r) => r.ok,
    () => false,
  );
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`délai dépassé en attendant ${what}${last ? ` (${String(last)})` : ""}`);
}

// --- fixture ----------------------------------------------------------------

const run = `${Date.now().toString(36)}`;
const STUDENT = `e${run}`;
const LAB: StagingSession = {
  sessionId: `s-lab-${run}`,
  student: STUDENT,
  assignment: "tp-pointeurs",
  containerIp: CONTAINER_IP,
  uploadPack: true,
  targetRepo: { owner: FORGE_USER, name: `p3-lab-${run}` },
};
const EXAM: StagingSession = {
  sessionId: `s-exam-${run}`,
  student: STUDENT,
  assignment: "exam-final",
  containerIp: CONTAINER_IP,
  uploadPack: false,
};

let base = "";
let volumesRoot = "";
let app: FastifyInstance | null = null;
let store: PushEventStore;
let closeDb: () => void = () => undefined;
let worker: RelayWorker;
let forge: Forge;
let available = false;
let boundHost = "";
let skipReason = "";
const containers: string[] = [];

/** Runs a shell script in a container attached to the `codespace` bridge. */
async function inContainer(script: string, name: string): Promise<string> {
  containers.push(name);
  return podman(
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    `${NETWORK}:ip=${CONTAINER_IP}`,
    "--dns=none",
    "--add-host",
    `portal.internal:${GATEWAY}`,
    "--entrypoint",
    "/bin/sh",
    GIT_IMAGE,
    "-c",
    script,
  );
}

const IDENTITY = "-c user.name=etudiant -c user.email=etudiant@codespace.local";

beforeAll(async () => {
  if (!(await podmanOk("version"))) {
    skipReason = "socket Podman rootful indisponible";
    return;
  }
  if (!FORGE_TOKEN) {
    skipReason = "FORGE_TOKEN absent de .env (voir src/git/README.md)";
    return;
  }
  if (!(await forgeReachable())) {
    await podmanOk("start", FORGE_CONTAINER);
    if (!(await waitFor("Forgejo", forgeReachable, 30_000).catch(() => false))) {
      skipReason = `Forgejo injoignable sur ${FORGE_URL} (voir src/git/README.md)`;
      return;
    }
  }
  // Idempotent, with exactly the options of CLAUDE.md invariant 2: P2 owns
  // this network and may be creating it at the same moment.
  if (!(await podmanOk("network", "exists", NETWORK))) {
    await podmanOk(
      "network",
      "create",
      "--internal",
      "--disable-dns",
      "--subnet",
      SUBNET,
      "--gateway",
      GATEWAY,
      NETWORK,
    );
  }
  if (!(await podmanOk("network", "exists", NETWORK))) {
    skipReason = `réseau ${NETWORK} indisponible`;
    return;
  }

  base = await tempDir("p3-integration-");
  volumesRoot = join(base, "volumes");
  const template = await makeSourceRepo({
    dir: join(base, "modele"),
    files: { "main.c": "int main(void) { return 0; }\n", "README.md": "# TP pointeurs\n" },
    message: "modèle de l'enseignant",
  });
  for (const session of [LAB, EXAM]) {
    await ensureStagingRepo({
      volumesRoot,
      student: session.student,
      assignment: session.assignment,
      source: { mode: "exam", templateFrom: template.gitDir },
      uploadPack: session.uploadPack,
    });
  }

  const db = openGitDb(":memory:");
  closeDb = db.close;
  store = createPushEventStore(db.db);
  forge = createForgejoForge({ baseUrl: FORGE_URL, token: FORGE_TOKEN });
  const repoOf = (row: { sessionId: string }): RepoRef | undefined =>
    row.sessionId === LAB.sessionId ? LAB.targetRepo : undefined;
  worker = createRelayWorker({
    store,
    forge,
    targets: stagingTargets(volumesRoot, repoOf),
    backoffMs: () => 500,
    maxAttempts: 60,
    pushTimeoutMs: 20_000,
  });
  worker.start(500);

  const sessions: SessionLookup = {
    async bySessionId(id) {
      if (id === LAB.sessionId) return LAB;
      if (id === EXAM.sessionId) return EXAM;
      return undefined;
    },
  };
  // The gateway first (P2 keeps `codespace-anchor` attached, so cs0 and
  // 10.77.0.254 are permanent), 0.0.0.0 as the fallback. Either way the
  // source-address check is what authenticates.
  const started = await waitFor(
    "le port 9418 (un autre agent peut l'occuper)",
    async () =>
      startGitServer({
        sessions,
        store,
        volumesRoot,
        relay: worker,
        host: GATEWAY,
        port: GIT_PORT,
      }).then(
        (s) => s,
        () => null,
      ),
    30_000,
  );
  app = started.app;
  boundHost = started.host;
  available = true;
}, 180_000);

afterAll(async () => {
  worker?.stop();
  if (app) await app.close();
  closeDb();
  for (const name of containers) await podmanOk("rm", "-f", name);
  // Forgejo and the `codespace` network are left running on purpose; only
  // the repository this run created is removed, so the dev forge does not
  // fill up with `p3-lab-*`.
  if (!(await forgeReachable())) await podmanOk("start", FORGE_CONTAINER);
  if (available && LAB.targetRepo) {
    await fetch(`${FORGE_URL}/api/v1/repos/${LAB.targetRepo.owner}/${LAB.targetRepo.name}`, {
      method: "DELETE",
      headers: { Authorization: `token ${FORGE_TOKEN}` },
    }).catch(() => undefined);
  }
  if (base) await rm(base, { recursive: true, force: true });
}, 120_000);

describe("canal Git, conteneur sur le réseau codespace", () => {
  it("dépendances disponibles", () => {
    if (!available) console.warn(`P3 intégration ignorée : ${skipReason}`);
    else console.info(`P3 intégration : service Git lié à ${boundHost}:${GIT_PORT}`);
    expect(available || skipReason.length > 0).toBe(true);
  });

  it("clone, commit, push depuis le conteneur ; PushEvent puis Forgejo en moins de 10 s", async () => {
    if (!available) return;
    await forge.ensureRepo(LAB.targetRepo as RepoRef);

    const out = await inContainer(
      [
        "set -e",
        `git clone -q http://portal.internal:${GIT_PORT}/git/${LAB.sessionId} /tmp/depot`,
        "cd /tmp/depot",
        "printf 'int main(void) { return 42; }\\n' > main.c",
        "git add -A",
        `git ${IDENTITY} commit -q -m "rendu de l'étudiant"`,
        "git push -q origin HEAD:main",
        'echo "SHA=$(git rev-parse HEAD)"',
      ].join("\n"),
      `p3-push-${run}`,
    );
    const sha = /SHA=([0-9a-f]{40})/.exec(out)?.[1];
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const started = Date.now();
    const rows = await waitFor("le PushEvent", async () => {
      const found = await store.bySession(LAB.sessionId);
      return found.length > 0 ? found : null;
    });
    expect(rows[0]?.ref).toBe("refs/heads/main");
    expect(rows[0]?.sha).toBe(sha);

    await waitFor(
      "le commit dans Forgejo",
      async () => {
        const url = `${FORGE_URL}/api/v1/repos/${LAB.targetRepo?.owner}/${LAB.targetRepo?.name}/git/commits/${sha}`;
        const r = await fetch(url, { headers: { Authorization: `token ${FORGE_TOKEN}` } });
        return r.ok;
      },
      10_000,
    );
    expect(Date.now() - started).toBeLessThan(10_000);

    const relayed = await waitFor("l'état relayed", async () => {
      const found = await store.bySession(LAB.sessionId);
      return found.every((r) => r.state === "relayed") ? found : null;
    });
    expect(relayed.every((r) => r.state === "relayed")).toBe(true);
  }, 120_000);

  it("le même push depuis l'hôte (IP hors session) reçoit 403", async () => {
    if (!available) return;
    const local = join(base, "depuis-hote");
    await git(["init", "--initial-branch=main", local], { env: FIXTURE_ENV });
    await git(["-C", local, "commit", "--allow-empty", "-m", "depuis l'hôte"], {
      env: FIXTURE_ENV,
    });
    // Whatever address the listener took, the host reaches it from its own
    // side: the loopback (off the bridge) or the gateway itself (on the
    // bridge, but not this session's container). Both are 403.
    const hostSide = boundHost === "0.0.0.0" ? "127.0.0.1" : boundHost;
    const remote = `http://${hostSide}:${GIT_PORT}/git/${LAB.sessionId}`;
    const failure = await git(["-C", local, "push", remote, "HEAD:refs/heads/pirate"], {
      env: FIXTURE_ENV,
    }).then(
      () => "le push a été accepté",
      (err: Error) => err.message,
    );
    expect(failure).toMatch(/403/);

    // …and the staging repository is untouched.
    const response = await fetch(`${remote}/info/refs?service=git-receive-pack`);
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/adresse source/);
  }, 60_000);

  it("Forgejo arrêté : le push réussit, l'événement reste pending, puis relayed au retour", async () => {
    if (!available) return;
    await podman("stop", "-t", "2", FORGE_CONTAINER);
    await waitFor("l'arrêt de Forgejo", async () => !(await forgeReachable()), 30_000);

    const before = (await store.bySession(LAB.sessionId)).length;
    const out = await inContainer(
      [
        "set -e",
        `git clone -q http://portal.internal:${GIT_PORT}/git/${LAB.sessionId} /tmp/depot`,
        "cd /tmp/depot",
        "printf 'int main(void) { return 7; }\\n' > main.c",
        "git add -A",
        `git ${IDENTITY} commit -q -m "rendu pendant la panne de la forge"`,
        "git push -q origin HEAD:main",
        'echo "SHA=$(git rev-parse HEAD)"',
      ].join("\n"),
      `p3-panne-${run}`,
    );
    const sha = /SHA=([0-9a-f]{40})/.exec(out)?.[1];
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    // The submission is recorded even though the forge is unreachable.
    const rows = await waitFor("le PushEvent de la panne", async () => {
      const found = (await store.bySession(LAB.sessionId)).filter((r) => r.sha === sha);
      return found.length > 0 ? found : null;
    });
    const pending = await waitFor("au moins une tentative de relais échouée", async () => {
      const row = (await store.bySession(LAB.sessionId)).find((r) => r.id === rows[0]?.id);
      return row && row.attempts > 0 ? row : null;
    }, 20_000);
    expect(pending.state).toBe("pending");
    expect(pending.lastError).toBeTruthy();

    await podman("start", FORGE_CONTAINER);
    await waitFor("le retour de Forgejo", forgeReachable, 60_000);

    const relayed = await waitFor(
      "le passage à relayed",
      async () => {
        const row = (await store.bySession(LAB.sessionId)).find((r) => r.id === rows[0]?.id);
        return row?.state === "relayed" ? row : null;
      },
      60_000,
    );
    expect(relayed.state).toBe("relayed");
  }, 240_000);

  it("devoir uploadpack:false : le clone est refusé proprement, le push fonctionne", async () => {
    if (!available) return;
    const fetchAttempt = await inContainer(
      `git clone http://portal.internal:${GIT_PORT}/git/${EXAM.sessionId} /tmp/exam 2>&1 || true`,
      `p3-fetch-refuse-${run}`,
    );
    expect(fetchAttempt).toMatch(/désactivée pour ce devoir|403/);

    // The push, which is the submission, is never refused.
    const out = await inContainer(
      [
        "set -e",
        "mkdir -p /tmp/rendu && cd /tmp/rendu",
        "git init -q --initial-branch=main .",
        "printf 'reponse\\n' > reponse.txt",
        "git add -A",
        `git ${IDENTITY} commit -q -m "rendu d'examen"`,
        `git push -q http://portal.internal:${GIT_PORT}/git/${EXAM.sessionId} HEAD:refs/heads/rendu`,
        'echo "SHA=$(git rev-parse HEAD)"',
      ].join("\n"),
      `p3-exam-push-${run}`,
    );
    const sha = /SHA=([0-9a-f]{40})/.exec(out)?.[1];
    const rows = await waitFor("le PushEvent d'examen", async () => {
      const found = await store.bySession(EXAM.sessionId);
      return found.length > 0 ? found : null;
    });
    expect(rows.map((r) => r.ref)).toContain("refs/heads/rendu");
    expect(rows.find((r) => r.ref === "refs/heads/rendu")?.sha).toBe(sha);
  }, 120_000);
});
