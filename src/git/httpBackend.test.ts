import { rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, describe, expect, it } from "vitest";

import { openGitDb } from "../db/client.js";
import { FIXTURE_ENV, makeSourceRepo, tempDir } from "./fixtures.js";
import { git } from "./gitRunner.js";
import {
  authorizeSource,
  backendEnv,
  createGitServer,
  ipInCidr,
  normalizeIp,
  requestedService,
  serviceAllowed,
} from "./httpBackend.js";
import { createPushEventStore, type PushEventRow, type PushEventStore } from "./pushEvents.js";
import { ensureStagingRepo } from "./staging.js";
import type { SessionLookup, StagingSession } from "./types.js";

const dirs: string[] = [];
const servers: FastifyInstance[] = [];
afterAll(async () => {
  for (const app of servers) await app.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const CONTAINER: StagingSession = {
  sessionId: "s-1",
  student: "e1234567",
  assignment: "tp-pointeurs",
  containerIp: "10.77.0.7",
  uploadPack: true,
};

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

describe("adresse source", () => {
  it("ramène une adresse IPv4 mappée en IPv6 à sa forme v4", () => {
    expect(normalizeIp("::ffff:10.77.0.7")).toBe("10.77.0.7");
    expect(normalizeIp("10.77.0.7")).toBe("10.77.0.7");
  });

  it("borne le sous-réseau codespace", () => {
    expect(ipInCidr("10.77.0.7", "10.77.0.0/24")).toBe(true);
    expect(ipInCidr("10.77.0.254", "10.77.0.0/24")).toBe(true);
    expect(ipInCidr("10.77.1.7", "10.77.0.0/24")).toBe(false);
    expect(ipInCidr("127.0.0.1", "10.77.0.0/24")).toBe(false);
    expect(ipInCidr("10.77.0.999", "10.77.0.0/24")).toBe(false);
    expect(ipInCidr("::1", "10.77.0.0/24")).toBe(false);
  });

  it("n'accepte que l'adresse exacte de la session, depuis le pont", () => {
    expect(authorizeSource("10.77.0.7", CONTAINER)).toEqual({ ok: true });
    expect(authorizeSource("::ffff:10.77.0.7", CONTAINER)).toEqual({ ok: true });
    // Another container on the same bridge: not this session.
    expect(authorizeSource("10.77.0.8", CONTAINER)).toEqual({
      ok: false,
      reason: "wrong-session",
    });
    // The host, the gateway, the loopback: off the bridge entirely.
    expect(authorizeSource("127.0.0.1", CONTAINER).ok).toBe(false);
    expect(authorizeSource("192.168.1.10", CONTAINER)).toEqual({
      ok: false,
      reason: "off-bridge",
    });
  });
});

describe("service demandé et politique", () => {
  it("reconnaît les quatre requêtes du protocole intelligent", () => {
    expect(requestedService("GET", "info/refs", { service: "git-upload-pack" })).toBe(
      "git-upload-pack",
    );
    expect(requestedService("GET", "info/refs", { service: "git-receive-pack" })).toBe(
      "git-receive-pack",
    );
    expect(requestedService("POST", "git-upload-pack", {})).toBe("git-upload-pack");
    expect(requestedService("POST", "git-receive-pack", {})).toBe("git-receive-pack");
  });

  it("traite les chemins du protocole bête comme des lectures", () => {
    expect(requestedService("GET", "HEAD", {})).toBe("git-upload-pack");
    expect(requestedService("GET", "objects/info/packs", {})).toBe("git-upload-pack");
    expect(requestedService("GET", "objects/ab/cdef", {})).toBe("git-upload-pack");
  });

  it("autorise toujours receive-pack, et upload-pack selon le devoir", () => {
    expect(serviceAllowed("git-receive-pack", { uploadPack: false })).toBe(true);
    expect(serviceAllowed("git-upload-pack", { uploadPack: true })).toBe(true);
    expect(serviceAllowed("git-upload-pack", { uploadPack: false })).toBe(false);
  });
});

describe("variables CGI", () => {
  const env = backendEnv({
    projectRoot: "/vol/e1/tp",
    pathInfo: "/staging.git/git-receive-pack",
    method: "POST",
    queryString: "service=git-receive-pack",
    remoteAddr: "10.77.0.7",
    headers: {
      "content-type": "application/x-git-receive-pack-request",
      "content-length": "1234",
      "content-encoding": "gzip",
      "git-protocol": "version=2",
      cookie: "session=secret",
      authorization: "Basic abc",
    },
  });

  it("pose ce que git http-backend attend", () => {
    expect(env["GIT_PROJECT_ROOT"]).toBe("/vol/e1/tp");
    expect(env["GIT_HTTP_EXPORT_ALL"]).toBe("1");
    expect(env["PATH_INFO"]).toBe("/staging.git/git-receive-pack");
    expect(env["REQUEST_METHOD"]).toBe("POST");
    expect(env["QUERY_STRING"]).toBe("service=git-receive-pack");
    expect(env["CONTENT_TYPE"]).toBe("application/x-git-receive-pack-request");
    expect(env["CONTENT_LENGTH"]).toBe("1234");
    expect(env["REMOTE_ADDR"]).toBe("10.77.0.7");
  });

  it("transmet Content-Encoding pour que http-backend décompresse lui-même", () => {
    expect(env["HTTP_CONTENT_ENCODING"]).toBe("gzip");
    expect(env["HTTP_GIT_PROTOCOL"]).toBe("version=2");
  });

  it("ne transmet aucun autre en-tête, et neutralise la configuration du poste", () => {
    expect(env["HTTP_COOKIE"]).toBeUndefined();
    expect(env["HTTP_AUTHORIZATION"]).toBeUndefined();
    expect(env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    expect(env["HOME"]).toBe("/nonexistent");
  });

  it("omet CONTENT_LENGTH sur un corps en chunked (lecture jusqu'à EOF)", () => {
    const chunked = backendEnv({
      projectRoot: "/vol",
      pathInfo: "/staging.git/git-receive-pack",
      method: "POST",
      queryString: "",
      remoteAddr: "10.77.0.7",
      headers: { "transfer-encoding": "chunked" },
    });
    expect(chunked["CONTENT_LENGTH"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The real CGI, over loopback
// ---------------------------------------------------------------------------

/**
 * Same code path as the container, minus Podman: the bridge CIDR is
 * overridden to the loopback so the source-address check has something real
 * to accept. The container-side proof is in `channel.integration.test.ts`.
 */
async function harness(overrides: Partial<StagingSession> = {}) {
  const base = await tempDir("p3-backend-");
  dirs.push(base);
  const volumesRoot = join(base, "volumes");
  const session: StagingSession = { ...CONTAINER, containerIp: "127.0.0.1", ...overrides };
  const src = await makeSourceRepo({
    dir: join(base, "src"),
    files: { "main.c": "int main(void) { return 0; }\n" },
  });
  const staging = await ensureStagingRepo({
    volumesRoot,
    student: session.student,
    assignment: session.assignment,
    source: { mode: "lab", mirrorFrom: src.gitDir },
    ...(overrides.uploadPack === undefined ? {} : { uploadPack: overrides.uploadPack }),
  });

  const { db, close } = openGitDb(":memory:");
  const store: PushEventStore = createPushEventStore(db);
  const relayed: PushEventRow[][] = [];
  const sessions: SessionLookup = {
    async bySessionId(id) {
      return id === session.sessionId ? session : undefined;
    },
  };
  const app = createGitServer({
    sessions,
    store,
    volumesRoot,
    clientCidr: "127.0.0.0/8",
    relay: { schedule: (events) => void relayed.push(events) },
  });
  servers.push(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  const remote = `http://127.0.0.1:${port}/git/${session.sessionId}`;
  return { base, volumesRoot, staging, src, store, relayed, app, port, remote, close, session };
}

/** Polls until `PushEvent` rows show up (they are written on child exit). */
async function waitForEvents(store: PushEventStore, sessionId: string, n: number) {
  for (let i = 0; i < 100; i += 1) {
    const rows = await store.bySession(sessionId);
    if (rows.length >= n) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return store.bySession(sessionId);
}

describe("canal Git de bout en bout (boucle locale)", () => {
  it("clone, commit, push : le PushEvent porte le bon sha", async () => {
    const h = await harness();
    const clone = join(h.base, "clone");
    await git(["clone", h.remote, clone], { env: FIXTURE_ENV });

    await writeFile(join(clone, "main.c"), "int main(void) { return 42; }\n", "utf8");
    await git(["-C", clone, "commit", "-am", "rendu"], { env: FIXTURE_ENV });
    const sha = (await git(["-C", clone, "rev-parse", "HEAD"], { env: FIXTURE_ENV })).trim();
    const pushed = await git(["-C", clone, "push", "origin", "HEAD:main"], { env: FIXTURE_ENV });
    expect(pushed).toBeDefined();

    const rows = await waitForEvents(h.store, h.session.sessionId, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ref).toBe("refs/heads/main");
    expect(rows[0]?.sha).toBe(sha);
    expect(rows[0]?.oldSha).toBe(h.src.sha);
    expect(rows[0]?.state).toBe("pending");
    // The relay only ever hears about stored rows (invariant 7).
    expect(h.relayed[0]?.[0]?.id).toBe(rows[0]?.id);
    h.close();
  });

  it("une requête d'une autre adresse reçoit 403 sans toucher au dépôt", async () => {
    // The session belongs to a container on the bridge; the test speaks from
    // the loopback, which is the host's position.
    const h = await harness({ containerIp: "10.77.0.7" });
    const response = await fetch(`${h.remote}/info/refs?service=git-receive-pack`);
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/adresse source/);
    h.close();
  });

  it("une session inconnue reçoit 404", async () => {
    const h = await harness();
    const response = await fetch(
      `http://127.0.0.1:${h.port}/git/s-inexistante/info/refs?service=git-upload-pack`,
    );
    expect(response.status).toBe(404);
    h.close();
  });

  it("devoir uploadpack:false : le fetch est refusé proprement, le push passe", async () => {
    const open = await harness();
    const clone = join(open.base, "clone");
    await git(["clone", open.remote, clone], { env: FIXTURE_ENV });

    const closed = await harness({ sessionId: "s-exam", assignment: "exam-final", uploadPack: false });
    const failure = await git(["clone", closed.remote, join(closed.base, "clone")], {
      env: FIXTURE_ENV,
    }).catch((err: Error) => err.message);
    expect(String(failure)).toMatch(/désactivée pour ce devoir|403/);

    // …while the push, which is the submission, still works.
    await git(["-C", clone, "commit", "--allow-empty", "-m", "rendu d'examen"], {
      env: FIXTURE_ENV,
    });
    await git(["-C", clone, "remote", "set-url", "origin", closed.remote], { env: FIXTURE_ENV });
    await git(["-C", clone, "push", "origin", "HEAD:refs/heads/rendu"], { env: FIXTURE_ENV });
    const rows = await waitForEvents(closed.store, "s-exam", 1);
    expect(rows.map((r) => r.ref)).toContain("refs/heads/rendu");
    open.close();
    closed.close();
  });

  it("un corps gzippé est décompressé par http-backend (HTTP_CONTENT_ENCODING)", async () => {
    const h = await harness();
    // A protocol v2 `ls-refs`, gzipped, which is the shape `git` sends when
    // it decides to compress a request body. Without HTTP_CONTENT_ENCODING,
    // http-backend reads the deflate stream as pkt-lines and fails.
    const pkt = (payload: string) =>
      (payload.length + 4).toString(16).padStart(4, "0") + payload;
    const request = pkt("command=ls-refs\n") + pkt("object-format=sha1\n") + "0001" + "0000";
    const response = await fetch(`${h.remote}/git-upload-pack`, {
      method: "POST",
      headers: {
        "content-type": "application/x-git-upload-pack-request",
        "content-encoding": "gzip",
        "git-protocol": "version=2",
      },
      body: gzipSync(Buffer.from(request, "utf8")),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("refs/heads/main");
    h.close();
  });

  it("un gros push (plusieurs mégaoctets) traverse sans être bufferisé", async () => {
    const h = await harness();
    const clone = join(h.base, "clone");
    await git(["clone", h.remote, clone], { env: FIXTURE_ENV });
    await writeFile(join(clone, "gros.txt"), "ligne de données\n".repeat(400_000), "utf8");
    await git(["-C", clone, "add", "-A"], { env: FIXTURE_ENV });
    await git(["-C", clone, "commit", "-m", "gros fichier"], { env: FIXTURE_ENV });
    const sha = (await git(["-C", clone, "rev-parse", "HEAD"], { env: FIXTURE_ENV })).trim();
    await git(["-C", clone, "push", "origin", "HEAD:main"], { env: FIXTURE_ENV });

    const rows = await waitForEvents(h.store, h.session.sessionId, 1);
    expect(rows[0]?.sha).toBe(sha);
    h.close();
  });

  it("un push qui ne change rien n'enregistre aucun PushEvent", async () => {
    const h = await harness();
    const clone = join(h.base, "clone");
    await git(["clone", h.remote, clone], { env: FIXTURE_ENV });
    await git(["-C", clone, "push", "origin", "HEAD:main"], { env: FIXTURE_ENV }).catch(
      () => undefined,
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(await h.store.bySession(h.session.sessionId)).toEqual([]);
    h.close();
  });
});
