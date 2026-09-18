/**
 * End-to-end acceptance test of portal v0 (docs/jalon-0.md § V1).
 *
 * It does, for real and in this order:
 *
 *   1. Keycloak sign-in as `student` — a real OIDC flow, code + PKCE;
 *   2. Start click, workbench loading, **websocket upgrade really
 *      checked** through the proxy;
 *   3. inside the container: `hello.c`, `make`, `gdb -batch`, `git push`;
 *      `PushEvent` in the database and commit in Forgejo;
 *   4. `podman kill` then reload: restarted on the same volume;
 *   5. no more heartbeat, grace period elapsed: container destroyed, volume
 *      and `shadow.git` intact;
 *   6. portal restart with a live session: same container;
 *   7. `/s/<sid>/` without a cookie: refused, and the teacher board is served
 *      only to an account carrying the `teacher` realm role;
 *   8. exam: `/exam/<id>/start` refused without `X-Dev-SEB`, accepted with it,
 *      then `/s/<sid>/` refused from another address;
 *   9. launch from classroom: assignment pushed by `PUT /api/assignments/<id>`
 *      with a service token, session opened by `GET /launch?token=…` without a
 *      second sign-in, push relayed to the repository **of the token**, token
 *      replay refused, teacher quota opposed to a second student.
 *
 * ## Why not Playwright
 *
 * Here the browser would only add the rendering of the workbench, which the
 * script already checks through the `vscode-workbench-web-configuration`
 * configuration served and through a **real** websocket upgrade (`101` and a
 * recomputed `Sec-WebSocket-Accept`). The rest of the journey — cookies,
 * refusals, addresses — is driven more reliably over HTTP, and one more
 * Chromium binary would just be one more point of failure on a WSL workstation.
 *
 * A single concession to the browser is necessary: Keycloak sets its state
 * cookies as `Secure` even in the clear, which a real browser accepts on
 * `http://localhost` (an origin deemed trustworthy) and which the standard
 * library would refuse. So the cookie jar below does what the browser does on
 * localhost, and nothing more.
 *
 * ## The terminal
 *
 * jalon-0 says "in the code-server terminal". Without a browser there is no
 * terminal; the commands therefore go through `podman exec`, in the same
 * container, under the same `student` user, with the same hardening.
 * It is the same shell, opened through another door.
 *
 * Run with:  pnpm --filter @hgc/codespace e2e
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, readdir, rm } from "node:fs/promises";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// --- test bench configuration -----------------------------------------------
// Dedicated database and volumes: the test is replayable and does not touch
// day-to-day development. The grace period is shortened so that the garbage
// collector assertion holds in a few seconds rather than in ten minutes;
// it is the only relaxed setting, and it is an explicit one.
const E2E_ROOT = join(REPO_ROOT, "var/e2e");
process.env["DATABASE_PATH"] = join(E2E_ROOT, "codespace.sqlite");
process.env["VOLUMES_ROOT"] = join(E2E_ROOT, "volumes");
process.env["SESSION_GRACE_MS"] = process.env["E2E_GRACE_MS"] ?? "8000";
process.env["SESSION_GC_INTERVAL_MS"] = "2000";
process.env["SHADOW_INTERVAL_MS"] = process.env["E2E_SHADOW_MS"] ?? "5000";
process.env["LOG_LEVEL"] = process.env["E2E_LOG_LEVEL"] ?? "warn";
process.env["SEB_VERIFIER"] = "simulated";
// Development only: makes `request.ip` controllable through
// `X-Forwarded-For`, which is the only way to simulate a second workstation
// without a second workstation. `loadConfig()` refuses this setting in production.
process.env["TRUST_PROXY"] = "1";

const { loadConfig } = await import("../src/auth/config.js");
const { buildPortal } = await import("../src/server.js");
const { runSeed } = await import("../src/db/seed.js");
const { containerNameFor } = await import("../src/sessions/manager.js");
const { forgejoSeedForge } = await import("../src/db/seed.js");
const { signHs256 } = await import("@hgc/domain");

const config = loadConfig();
const BASE = `http://localhost:${config.PORT}`;
const PODMAN = ["--remote", "--url", config.PODMAN_URL];

// --- log --------------------------------------------------------------------
let failures = 0;
const measures: Array<[string, string]> = [];

function step(title: string): void {
  console.log(`\n=== ${title}`);
}
function ok(what: string, detail = ""): void {
  console.log(`  PASS  ${what}${detail ? ` — ${detail}` : ""}`);
}
function fail(what: string, detail: string): void {
  failures += 1;
  console.log(`  FAIL  ${what} — ${detail}`);
}
function check(condition: boolean, what: string, detail = ""): boolean {
  if (condition) ok(what, detail);
  else fail(what, detail || "false condition");
  return condition;
}
function measure(name: string, value: string): void {
  measures.push([name, value]);
  console.log(`  MEASURE ${name} = ${value}`);
}

// --- podman -----------------------------------------------------------------
async function podman(args: string[], timeoutMs = 300_000): Promise<string> {
  const { stdout } = await execFileAsync("podman", [...PODMAN, ...args], {
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return stdout;
}
async function podmanOk(args: string[]): Promise<boolean> {
  return podman(args).then(
    () => true,
    () => false,
  );
}
/** `podman exec` with the container shell; returns stdout even on failure. */
async function inSession(sessionId: string, script: string): Promise<{ out: string; code: number }> {
  try {
    const out = await podman(["exec", containerNameFor(sessionId), "/bin/sh", "-lc", script]);
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.code ?? 1 };
  }
}

// --- cookie jar -------------------------------------------------------------
interface Cookie {
  name: string;
  value: string;
  path: string;
}
class Jar {
  private readonly jar: Cookie[] = [];

  absorb(headers: Headers): void {
    // `getSetCookie` returns each header separately: indispensable, Keycloak
    // sets three of them at once.
    for (const raw of headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (!pair || eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let path = "/";
      for (const attr of attrs) {
        const [k, v] = attr.split("=");
        if (k?.trim().toLowerCase() === "path" && v) path = v.trim();
      }
      const index = this.jar.findIndex((c) => c.name === name && c.path === path);
      if (value === "" || /;\s*max-age=0/i.test(raw)) {
        if (index >= 0) this.jar.splice(index, 1);
        continue;
      }
      if (index >= 0) this.jar[index] = { name, value, path };
      else this.jar.push({ name, value, path });
    }
  }

  header(url: string): string | undefined {
    const path = new URL(url).pathname;
    const matching = this.jar.filter(
      (c) => path === c.path || path.startsWith(c.path.endsWith("/") ? c.path : `${c.path}/`),
    );
    return matching.length > 0
      ? matching.map((c) => `${c.name}=${c.value}`).join("; ")
      : undefined;
  }

  get(name: string): string | undefined {
    return this.jar.find((c) => c.name === name)?.value;
  }
}

interface Reply {
  status: number;
  location: string | null;
  body: string;
  headers: Headers;
  /** Path followed by `follow`, so that diagnosing a failure stays readable. */
  hops: string[];
}

async function request(
  jar: Jar,
  url: string,
  init: RequestInit & { noCookies?: boolean } = {},
): Promise<Reply> {
  const cookie = init.noCookies ? undefined : jar.header(url);
  const res = await fetch(url, {
    ...init,
    redirect: "manual",
    headers: {
      accept: "text/html,application/xhtml+xml",
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!init.noCookies) jar.absorb(res.headers);
  return {
    status: res.status,
    location: res.headers.get("location"),
    body: await res.text(),
    headers: res.headers,
    hops: [`${res.status} ${url}`],
  };
}

/** Follows the redirects internal to the portal, keeping the cookies. */
async function follow(jar: Jar, url: string, max = 6): Promise<Reply> {
  let current = url;
  const hops: string[] = [];
  for (let i = 0; i < max; i++) {
    const reply = await request(jar, current);
    hops.push(`${reply.status} ${current}${reply.location ? ` → ${reply.location}` : ""}`);
    if (reply.status >= 300 && reply.status < 400 && reply.location) {
      current = new URL(reply.location, current).href;
      continue;
    }
    return { ...reply, hops };
  }
  throw new Error(`too many redirects from ${url}`);
}

// --- OIDC sign-in -----------------------------------------------------------
async function login(jar: Jar, username: string, password: string): Promise<void> {
  // 1. the portal redirects to Keycloak
  const start = await request(jar, `${BASE}/auth/login`);
  if (start.status !== 303 || !start.location) {
    throw new Error(`/auth/login did not redirect (${start.status})`);
  }
  // 2. the Keycloak form
  const form = await fetch(start.location, { redirect: "manual" });
  const kcJar = new Jar();
  kcJar.absorb(form.headers);
  const html = await form.text();
  const action = /id="kc-form-login"[^>]*action="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
  if (!action) throw new Error("Keycloak sign-in form not found");
  const posted = await fetch(action, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(kcJar.header(action) ? { cookie: kcJar.header(action) as string } : {}),
    },
    body: new URLSearchParams({ username, password, credentialId: "" }).toString(),
  });
  const callback = posted.headers.get("location");
  if (!callback) {
    throw new Error(`Keycloak did not redirect to the portal (${posted.status})`);
  }
  // 3. back on /auth/callback: the portal exchanges the code and sets its cookie
  const done = await request(jar, callback);
  if (done.status !== 303) throw new Error(`/auth/callback answered ${done.status}`);
}

// --- websocket upgrade -------------------------------------------------------
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * A real upgrade: 101 **and** a `Sec-WebSocket-Accept` recomputed from the key
 * that was sent. A 200 or a 403 is not an upgrade.
 */
function upgradeWebSocket(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; upgraded: boolean; acceptValid: boolean }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const u = new URL(url);
    // Standard base64, not base64url: `ws` validates the key against
    // /^[+/0-9A-Za-z]{22}==$/ and would refuse a `-` or a `_`.
    const key = randomBytes(16).toString("base64");
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: "GET",
      headers: {
        Host: u.host,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
        ...headers,
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      rejectPromise(new Error("websocket upgrade: timed out"));
    }, 15_000);
    req.on("upgrade", (res, socket) => {
      clearTimeout(timer);
      const expected = createHash("sha1").update(key + WS_GUID).digest("base64");
      const accept = res.headers["sec-websocket-accept"];
      socket.destroy();
      resolvePromise({ status: 101, upgraded: true, acceptValid: accept === expected });
    });
    req.on("response", (res) => {
      clearTimeout(timer);
      res.resume();
      resolvePromise({ status: res.statusCode ?? 0, upgraded: false, acceptValid: false });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    req.end();
  });
}

// --- utilities ---------------------------------------------------------------
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null);
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * The volume is chowned to the container's UID range by `:U`: uid 1000 cannot
 * delete it. So we go through a container, the way the operators would have
 * to.
 */
async function wipeE2eRoot(): Promise<void> {
  // The mount would create the directory if it were missing, as root: we only
  // mount what already exists.
  if (await exists(E2E_ROOT)) {
    await podmanOk([
      "run", "--rm", "-v", `${E2E_ROOT}:/v`, "docker.io/library/alpine:3.20",
      "sh", "-c", "rm -rf /v/volumes /v/codespace.sqlite*",
    ]);
  }
  await rm(E2E_ROOT, { recursive: true, force: true }).catch(() => undefined);
}

async function removeSessionContainers(): Promise<void> {
  const out = await podman([
    "ps", "--all", "--filter", "label=heig-codespace.session", "--format", "{{.Names}}",
  ]).catch(() => "");
  for (const name of out.split("\n").map((s) => s.trim()).filter(Boolean)) {
    await podmanOk(["rm", "-f", name]);
  }
}

// --- the test ----------------------------------------------------------------
type Portal = Awaited<ReturnType<typeof buildPortal>>;

async function startPortal(): Promise<Portal> {
  const portal = await buildPortal();
  await portal.app.listen({ port: config.PORT, host: config.HOST });
  return portal;
}

async function main(): Promise<void> {
  step("prerequisites");
  check(await podmanOk(["version"]), "rootful Podman socket reachable", config.PODMAN_URL);
  const anchor = await podman(["inspect", "codespace-anchor", "--format", "{{.State.Status}}"]).catch(
    () => "",
  );
  check(anchor.trim() === "running", "anchor container running (never touched by the test)");
  check(
    await podmanOk(["image", "exists", config.CODESPACE_IMAGE]),
    "student image present",
    config.CODESPACE_IMAGE,
  );
  check(
    await fetch(`${config.FORGE_URL}/api/v1/version`, { signal: AbortSignal.timeout(3000) }).then(
      (r) => r.ok,
      () => false,
    ),
    "Forgejo reachable",
    config.FORGE_URL,
  );
  check(
    await fetch(`${config.OIDC_ISSUER}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(3000),
    }).then(
      (r) => r.ok,
      () => false,
    ),
    "Keycloak reachable",
    config.OIDC_ISSUER,
  );
  check(
    config.CODESPACE_LAUNCH_SECRET.length >= 32,
    "shared launch secret present in .env (CODESPACE_LAUNCH_SECRET)",
    `${config.CODESPACE_LAUNCH_SECRET.length} characters`,
  );
  if (failures > 0) throw new Error("prerequisites not met");

  step("fresh test bench");
  await removeSessionContainers();
  await wipeE2eRoot();
  await runSeed({ config, seedDir: join(REPO_ROOT, "seed"), log: () => undefined });
  ok("seed laid down in a dedicated database and volumes", E2E_ROOT);

  let portal = await startPortal();
  const jar = new Jar();

  try {
    // --- 1. sign-in --------------------------------------------------------
    step("1. real OIDC sign-in (Keycloak, code + PKCE)");
    await login(jar, "student", "student");
    const home = await follow(jar, `${BASE}/`);
    check(home.status === 200, "home page served after sign-in");
    check(home.body.includes("Sacha Student"), "the identity really comes from the IdP");
    check(home.body.includes("tp-pointeurs"), "the lab assignment is listed");
    check(
      !home.body.includes('action="/assignments/exam-c/start"'),
      "the exam assignment has no Start button (invariant 5)",
    );

    // --- 2. start ----------------------------------------------------------
    step("2. Start click, workbench, websocket");
    const clicked = Date.now();
    const started = await request(jar, `${BASE}/assignments/tp-pointeurs/start`, {
      method: "POST",
    });
    check(started.status === 303, "Start redirects", `${started.status} ${started.location}`);
    const sid = /\/s\/([^/]+)\//.exec(started.location ?? "")?.[1] ?? "";
    check(sid.length > 0, "session id received", sid);
    check(jar.get("cs_session")?.startsWith(`${sid}.`) === true, "session cookie set");

    const workbench = await follow(jar, new URL(started.location as string, BASE).href);
    const tWorkbench = Date.now() - clicked;
    check(workbench.status === 200, "workbench served through the proxy");
    check(
      workbench.body.includes("vscode-workbench-web-configuration"),
      "the page really is the code-server workbench",
    );
    measure("Start click → workbench page", `${(tWorkbench / 1000).toFixed(2)} s`);

    const wsUrl = `${BASE}/s/${sid}/?reconnectionToken=11111111-1111-1111-1111-111111111111&reconnection=false&skipWebSocketFrames=false`;
    const wsStarted = Date.now();
    const ws = await upgradeWebSocket(wsUrl, {
      Cookie: jar.header(`${BASE}/s/${sid}/`) ?? "",
    });
    const tWs = Date.now() - wsStarted;
    check(ws.upgraded, "websocket upgrade through the proxy", `status ${ws.status}`);
    check(ws.acceptValid, "Sec-WebSocket-Accept recomputed and correct");
    measure("Start click → websocket established", `${((Date.now() - clicked) / 1000).toFixed(2)} s`);
    measure("websocket upgrade alone", `${tWs} ms`);

    const wsNoCookie = await upgradeWebSocket(wsUrl, {});
    check(
      !wsNoCookie.upgraded && wsNoCookie.status === 403,
      "websocket refused without a session cookie",
      `status ${wsNoCookie.status}`,
    );

    // --- 3. compilation, debugging, push -----------------------------------
    step("3. inside the container: hello.c, make, gdb, git push");
    const listing = await inSession(sid, "ls -a /work && git -C /work remote -v");
    check(listing.out.includes("Makefile"), "the model is in the workspace");
    check(
      listing.out.includes(".vscode"),
      "the gdb launch configuration comes from the model repository",
    );
    check(
      listing.out.includes("portal.internal:9418/git/"),
      "the origin remote is the portal's Git channel",
    );

    const build = await inSession(
      sid,
      [
        "set -e",
        "cd /work",
        "cat > hello.c <<'EOF'",
        "#include <stdio.h>",
        "int main(void) { int x = 42; printf(\"reponse %d\\n\", x); return 0; }",
        "EOF",
        "make 2>&1",
        "./hello",
        "gdb -batch -ex run -ex bt ./hello 2>&1 | tail -5",
        "gdb -batch -ex 'show disable-randomization' ./hello 2>&1 | tail -1",
      ].join("\n"),
    );
    check(build.code === 0, "make + gdb -batch inside the container", build.out.slice(-200));
    check(build.out.includes("reponse 42"), "the compiled program runs");
    check(
      /exited normally|\[Inferior .* exited normally\]/.test(build.out),
      "gdb ran the program without Operation not permitted",
    );
    check(
      /disable-randomization.*is on|randomization.*\bon\b/i.test(build.out),
      "gdb does disable ASLR (the project's seccomp profile)",
    );

    const pushed = await inSession(
      sid,
      [
        "set -e",
        "cd /work",
        "git config user.name etudiant",
        "git config user.email etudiant@codespace.local",
        "git add -A",
        "git commit -q -m 'rendu du TP'",
        "git push -q origin HEAD:main",
        'echo "SHA=$(git rev-parse HEAD)"',
      ].join("\n"),
    );
    const sha = /SHA=([0-9a-f]{40})/.exec(pushed.out)?.[1] ?? "";
    check(pushed.code === 0 && sha !== "", "git push from the container", pushed.out.slice(-200));

    const events = await waitFor("the PushEvent", async () => {
      const rows = await portal.store.bySession(sid);
      return rows.some((r) => r.sha === sha) ? rows : null;
    });
    check(
      events.some((r) => r.sha === sha && r.ref === "refs/heads/main"),
      "PushEvent in the database with the right sha",
      sha.slice(0, 12),
    );

    const relayStarted = Date.now();
    await waitFor(
      "the commit in Forgejo",
      async () =>
        fetch(
          `${config.FORGE_URL}/api/v1/repos/codespace/tp-pointeurs-student/git/commits/${sha}`,
          { headers: { Authorization: `token ${config.FORGE_TOKEN}` } },
        ).then((r) => r.ok),
      30_000,
    );
    ok("commit relayed into Forgejo");
    measure("push → commit in Forgejo", `${((Date.now() - relayStarted) / 1000).toFixed(2)} s`);

    // --- 4. podman kill then reload ----------------------------------------
    step("4. podman kill then page reload");
    const beforeKill = (
      await podman(["inspect", containerNameFor(sid), "--format", "{{.Id}}"])
    ).trim();
    await podman(["kill", containerNameFor(sid)]);
    await waitFor(
      "the container to stop",
      async () =>
        (await podman(["inspect", containerNameFor(sid), "--format", "{{.State.Status}}"]))
          .trim() !== "running",
    );
    ok("container killed");
    const reloadStarted = Date.now();
    const reloaded = await follow(jar, `${BASE}/s/${sid}/`);
    check(
      reloaded.status === 200,
      "reload served",
      `${reloaded.status} · ${reloaded.hops.join(" | ")}`,
    );
    check(
      reloaded.body.includes("vscode-workbench-web-configuration"),
      "the workbench is there again",
      reloaded.body.slice(0, 160).replace(/\s+/g, " "),
    );
    const afterKill = (
      await podman(["inspect", containerNameFor(sid), "--format", "{{.Id}}"])
    ).trim();
    check(afterKill !== beforeKill, "a new container was started");
    measure("reload after kill → workbench", `${((Date.now() - reloadStarted) / 1000).toFixed(2)} s`);
    const survived = await inSession(sid, "cat /work/hello.c");
    check(survived.out.includes("reponse %d"), "the file is there: same volume");

    // --- 5. grace period ----------------------------------------------------
    step("5. no more heartbeat: grace period, then container destruction");
    const volumeDir = join(config.volumesRoot, "student", "tp-pointeurs");
    await waitFor(
      "the container to be destroyed after the grace period",
      async () => !(await podmanOk(["inspect", containerNameFor(sid)])),
      Number(process.env["SESSION_GRACE_MS"]) + 20_000,
    );
    ok("container destroyed after the grace period", `${process.env["SESSION_GRACE_MS"]} ms`);
    check(await exists(join(volumeDir, "work")), "the work volume is kept");
    check(await exists(join(volumeDir, "staging.git")), "the staging repository is kept");
    check(await exists(join(volumeDir, "shadow.git")), "the shadow repository exists");
    const shadowLog = await execFileAsync("git", [
      "--git-dir",
      join(volumeDir, "shadow.git"),
      "log",
      "--oneline",
    ]).then(
      (r) => r.stdout,
      () => "",
    );
    check(
      shadowLog.trim().split("\n").filter(Boolean).length >= 1,
      "shadow.git holds at least one snapshot",
      shadowLog.trim().split("\n")[0] ?? "",
    );
    const shadowFiles = await execFileAsync("git", [
      "--git-dir",
      join(volumeDir, "shadow.git"),
      "ls-tree",
      "-r",
      "--name-only",
      "HEAD",
    ]).then(
      (r) => r.stdout,
      () => "",
    );
    check(shadowFiles.includes("hello.c"), "the snapshot holds the student's work");
    check(
      !shadowFiles.includes(".git/"),
      "the snapshot excludes the student's repository",
    );

    // --- 6. portal restart with a live session -----------------------------
    step("6. portal restart with a live session");
    const restarted = await request(jar, `${BASE}/assignments/tp-pointeurs/start`, {
      method: "POST",
    });
    const sid2 = /\/s\/([^/]+)\//.exec(restarted.location ?? "")?.[1] ?? "";
    check(sid2 === sid, "the (student, assignment) session is resumed, not duplicated", sid2);
    await follow(jar, `${BASE}/s/${sid}/`);
    const liveBefore = (
      await podman(["inspect", containerNameFor(sid), "--format", "{{.Id}}"])
    ).trim();

    await portal.close();
    portal = await startPortal();
    ok("portal restarted");
    const afterRestart = await follow(jar, `${BASE}/s/${sid}/`);
    check(
      afterRestart.status === 200,
      "the session stays reachable after the restart",
      `${afterRestart.status} ${afterRestart.body.slice(0, 160).replace(/\s+/g, " ")}`,
    );
    const liveAfter = (
      await podman(["inspect", containerNameFor(sid), "--format", "{{.Id}}"])
    ).trim();
    check(liveAfter === liveBefore, "the container was not recreated", liveAfter.slice(0, 12));

    // --- 7. refusal without a cookie ---------------------------------------
    step("7. access refused without a session cookie");
    const naked = await request(jar, `${BASE}/s/${sid}/`, { noCookies: true });
    check(naked.status === 403, "403 without a cookie", String(naked.status));
    check(naked.body.includes("Session non autorisée"), "explicit refusal page");

    // --- 7 bis. teacher role -----------------------------------------------
    step("7 bis. teacher role, derived from the realm");
    const teacherJar = new Jar();
    await login(teacherJar, "teacher", "teacher");
    const board = await follow(teacherJar, `${BASE}/teacher/sessions`);
    check(board.status === 200, "the sessions board is served to the teacher");
    check(board.body.includes("Sacha Student"), "the student's session is listed there");
    check(board.body.includes("tp-pointeurs") || board.body.includes("TP 3"), "the assignment is listed there");
    check(board.body.includes("Fermer"), "the Fermer button is offered");
    const studentBoard = await follow(jar, `${BASE}/teacher/sessions`);
    check(
      studentBoard.status === 403,
      "the same board is refused to the student",
      String(studentBoard.status),
    );

    // --- 8. exam mode -------------------------------------------------------
    step("8. exam mode: SEB verification, then provenance");
    const examJar = new Jar();
    await login(examJar, "student2", "student2");
    const refused = await request(examJar, `${BASE}/exam/exam-c/start`);
    check(refused.status === 403, "exam start refused without the SEB header", String(refused.status));
    check(
      refused.body.includes("Safe Exam Browser"),
      "the refusal page is the exam one",
    );

    const accepted = await request(examJar, `${BASE}/exam/exam-c/start`, {
      headers: { "x-dev-seb": "ok" },
    });
    check(accepted.status === 303, "start accepted with X-Dev-SEB", String(accepted.status));
    const examSid = /\/s\/([^/]+)\//.exec(accepted.location ?? "")?.[1] ?? "";
    check(examSid !== "", "exam session created", examSid);
    check(examJar.get("exam_session") !== undefined, "exam_session cookie set");
    check(examJar.get("cs_session")?.startsWith(`${examSid}.`) === true, "session cookie set");

    const examPage = await follow(examJar, `${BASE}/s/${examSid}/`);
    check(
      examPage.status === 200,
      "the exam opens from the same workstation",
      `${examPage.status} ${examPage.body.slice(0, 160).replace(/\s+/g, " ")}`,
    );
    const examWork = await inSession(examSid, "ls /work && git -C /work log --oneline | head -1");
    check(
      examWork.out.includes("Makefile"),
      "the exam workspace is bootstrapped from the teacher's model (invariant 6)",
    );

    const elsewhere = await request(examJar, `${BASE}/s/${examSid}/`, {
      headers: { "x-forwarded-for": "192.0.2.7" },
    });
    check(
      elsewhere.status === 403,
      "the exam is refused from another client address",
      String(elsewhere.status),
    );
    check(
      elsewhere.body.includes("autre poste") || elsewhere.body.includes("Safe Exam Browser"),
      "'session outside SEB' page",
    );

    // Invariant 5, asserted: the proxy looks at no SEB header. A request *with*
    // the SEB headers but without a cookie is still refused.
    const headersOnly = await request(examJar, `${BASE}/s/${examSid}/`, {
      noCookies: true,
      headers: { "x-dev-seb": "ok", "x-safeexambrowser-configkeyhash": "0".repeat(64) },
    });
    check(
      headersOnly.status === 403,
      "the proxy is not convinced by an SEB header (invariant 5)",
      String(headersOnly.status),
    );

    // --- 9. launch from classroom ------------------------------------------
    step("9. launch from classroom: PUT of the assignment, then /launch");

    const nowSec = (): number => Math.floor(Date.now() / 1000);
    const SECRET = config.CODESPACE_LAUNCH_SECRET;
    const CLASSROOM_ASSIGNMENT = "classroom-lab";
    const CLASSROOM_STUDENT = "e2e-classroom";
    const CLASSROOM_TEACHER = "t-e2e";
    const CLASSROOM_REPO = `${config.FORGE_USER}/classroom-launch-e2e`;
    /** Marker of the current run, so the submission differs from the previous one. */
    const runTag = `${Date.now()}-${randomBytes(4).toString("hex")}`;

    /** Service token: server to server, audience `heig-codespace-api`. */
    const makeServiceToken = (): Promise<string> =>
      signHs256(
        {
          iss: "heig-classroom",
          aud: "heig-codespace-api",
          iat: nowSec(),
          exp: nowSec() + 300,
        },
        SECRET,
      );

    /** Launch token: what classroom issues when Start is clicked. */
    const makeLaunchToken = (over: Record<string, unknown> = {}): Promise<string> =>
      signHs256(
        {
          iss: "heig-classroom",
          aud: "heig-codespace",
          iat: nowSec(),
          exp: nowSec() + 300,
          jti: randomBytes(16).toString("hex"),
          sub: CLASSROOM_STUDENT,
          email: "e2e@heig-vd.ch",
          displayName: "Classroom student",
          githubLogin: "e2e-gh",
          assignmentId: CLASSROOM_ASSIGNMENT,
          repo: { fullName: CLASSROOM_REPO, defaultBranch: "main" },
          ...over,
        },
        SECRET,
      );

    // The student's repository, as classroom would have provisioned it. Public,
    // like the seed ones: the mirror of the staging repository is read by a
    // `git fetch` without a token, by design (docs/v1.md D-V1-8).
    const seedForge = forgejoSeedForge(config.FORGE_URL, config.FORGE_TOKEN);
    const [repoOwner, repoName] = CLASSROOM_REPO.split("/") as [string, string];
    await seedForge.ensure(repoOwner, repoName);
    ok("student repository created in the forge", CLASSROOM_REPO);

    const syncBody = (quota: number): unknown => ({
      id: CLASSROOM_ASSIGNMENT,
      slug: "tp-classroom",
      name: "Lab launched from classroom",
      classroomId: "c-e2e",
      classroomName: "Classe de bout en bout",
      mode: "online",
      image: config.CODESPACE_IMAGE,
      sourceRepo: { fullName: `${config.FORGE_USER}/tp-pointeurs-modele`, defaultBranch: "main" },
      browserExamKeys: [],
      teacher: { id: CLASSROOM_TEACHER, email: "teacher@heig-vd.ch" },
      quota: { maxActiveSessions: quota },
      startAt: new Date(Date.now() - 3_600_000).toISOString(),
      deadlineAt: null,
    });

    const putAssignment = async (quota: number): Promise<Reply> =>
      request(new Jar(), `${BASE}/api/assignments/${CLASSROOM_ASSIGNMENT}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${await makeServiceToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(syncBody(quota)),
      });

    const unauthorised = await request(new Jar(), `${BASE}/api/assignments/${CLASSROOM_ASSIGNMENT}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(syncBody(2)),
    });
    check(unauthorised.status === 401, "PUT refused without a service token", String(unauthorised.status));

    const synced = await putAssignment(2);
    check(synced.status === 200, "assignment synchronised from classroom", String(synced.status));
    const syncedBody = JSON.parse(synced.body) as { id: string; configKey: string | null };
    check(
      syncedBody.id === CLASSROOM_ASSIGNMENT && syncedBody.configKey === null,
      "PUT response: identifier, no Config Key in online mode",
    );
    const again = await putAssignment(2);
    check(again.status === 200 && again.body === synced.body, "the PUT is idempotent");

    // The student arrives **without signing in again**: no OIDC cookie in this
    // jar, only the token in the URL.
    const launchJar = new Jar();
    const launchToken = await makeLaunchToken();
    const launchStarted = Date.now();
    const launched = await request(launchJar, `${BASE}/launch?token=${launchToken}`);
    check(launched.status === 303, "/launch opens the session", `${launched.status} ${launched.location}`);
    const csid = /\/s\/([^/]+)\//.exec(launched.location ?? "")?.[1] ?? "";
    check(csid !== "", "session id received", csid);
    check(
      launchJar.get("cs_session")?.startsWith(`${csid}.`) === true,
      "portal session cookie set by /launch (no second sign-in)",
    );
    check(launchJar.get("cs_auth") === undefined, "no OIDC sign-in cookie is required");

    const classroomWorkbench = await follow(launchJar, new URL(launched.location as string, BASE).href);
    check(
      classroomWorkbench.status === 200 &&
        classroomWorkbench.body.includes("vscode-workbench-web-configuration"),
      "the editor opens for the session launched from classroom",
      `${classroomWorkbench.status}`,
    );
    measure(
      "launch token → workbench page",
      `${((Date.now() - launchStarted) / 1000).toFixed(2)} s`,
    );

    const replayed = await request(new Jar(), `${BASE}/launch?token=${launchToken}`);
    check(replayed.status === 403, "single use: the same token is refused", String(replayed.status));
    check(replayed.body.includes("déjà servi"), "explicit refusal page on replay");

    const unknownAssignment = await request(
      new Jar(),
      `${BASE}/launch?token=${await makeLaunchToken({ assignmentId: "jamais-synchronise" })}`,
    );
    check(
      unknownAssignment.status === 403 &&
        unknownAssignment.body.includes("non synchronisé depuis classroom"),
      "unknown assignment: named refusal",
    );

    // The push goes to the repository **of the token**, not to a convention of the assignment.
    const classroomPush = await inSession(
      csid,
      [
        "set -e",
        "cd /work",
        "git config user.name etudiant",
        "git config user.email etudiant@codespace.local",
        // Unique content: the student's repository survives from one run to the
        // next (only `var/e2e/` is wiped), so the mirror of the staging
        // repository brings back the previous submission. Without this,
        // `git commit` would have nothing to write on the second run.
        `echo 'depuis classroom ${runTag}' > rendu.txt`,
        "git add -A",
        "git commit -q -m 'submission launched from classroom'",
        "git push -q origin HEAD:main",
        'echo "SHA=$(git rev-parse HEAD)"',
      ].join("\n"),
    );
    const classroomSha = /SHA=([0-9a-f]{40})/.exec(classroomPush.out)?.[1] ?? "";
    check(
      classroomPush.code === 0 && classroomSha !== "",
      "git push from the container launched by token",
      classroomPush.out.slice(-200),
    );
    await waitFor(
      "the commit in the token's repository",
      async () =>
        fetch(`${config.FORGE_URL}/api/v1/repos/${CLASSROOM_REPO}/git/commits/${classroomSha}`, {
          headers: { Authorization: `token ${config.FORGE_TOKEN}` },
        }).then((r) => r.ok),
      30_000,
    );
    ok("push relayed to the repository carried by the token", CLASSROOM_REPO);

    const summaries = await request(new Jar(), `${BASE}/api/assignments/${CLASSROOM_ASSIGNMENT}/sessions`, {
      headers: { authorization: `Bearer ${await makeServiceToken()}` },
    });
    const rows = JSON.parse(summaries.body) as Array<{
      sessionId: string;
      userId: string;
      lastPushAt: string | null;
    }>;
    check(
      summaries.status === 200 && rows.some((r) => r.sessionId === csid && r.userId === CLASSROOM_STUDENT),
      "the sessions board is returned to classroom with its own user identifier",
      `${summaries.status} · ${rows.length} row(s)`,
    );
    check(
      rows.find((r) => r.sessionId === csid)?.lastPushAt !== null,
      "the summary carries the date of the last push",
    );

    // Per-teacher quota: one live session, quota lowered to one, a second
    // student of the same teacher is refused — and resuming the first is not.
    check((await putAssignment(1)).status === 200, "teacher quota lowered to one session");
    const overQuota = await request(
      new Jar(),
      `${BASE}/launch?token=${await makeLaunchToken({ sub: "e2e-classroom2", email: "e2e2@heig-vd.ch" })}`,
    );
    check(overQuota.status === 429, "second student refused: quota reached", String(overQuota.status));
    check(overQuota.body.includes("Quota atteint"), "explicit 429 page");
    const resumed = await request(new Jar(), `${BASE}/launch?token=${await makeLaunchToken()}`);
    check(
      resumed.status === 303,
      "resuming one's own session does not consume quota",
      String(resumed.status),
    );

    step("summary");
    for (const [name, value] of measures) console.log(`  ${name} : ${value}`);
    const volumes = await readdir(config.volumesRoot).catch(() => []);
    console.log(`  volumes kept: ${volumes.join(", ")}`);
  } finally {
    await portal.close();
    await removeSessionContainers();
    console.log("\nsession containers cleaned up (anchor, Forgejo and Keycloak untouched).");
  }

  if (failures > 0) {
    console.log(`\nRESULT: ${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nRESULT: all assertions are green.");
}

await main();
