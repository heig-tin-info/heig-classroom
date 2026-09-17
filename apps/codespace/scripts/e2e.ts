/**
 * Test d'acceptation de bout en bout du portail v0 (docs/jalon-0.md § V1).
 *
 * Il fait, pour de vrai et dans cet ordre :
 *
 *   1. connexion Keycloak en `student` — vrai flux OIDC, code + PKCE ;
 *   2. clic Démarrer, chargement du poste de travail, **mise à niveau
 *      websocket réellement vérifiée** à travers le proxy ;
 *   3. dans le conteneur : `hello.c`, `make`, `gdb -batch`, `git push` ;
 *      `PushEvent` en base et commit dans Forgejo ;
 *   4. `podman kill` puis rechargement : relance sur le même volume ;
 *   5. plus de battement, grâce écoulée : conteneur détruit, volume et
 *      `shadow.git` intacts ;
 *   6. redémarrage du portail avec une session active : même conteneur ;
 *   7. `/s/<sid>/` sans cookie : refusé, et le tableau enseignant n'est servi
 *      qu'à un compte porteur du rôle de realm `teacher` ;
 *   8. examen : `/exam/<id>/start` refusé sans `X-Dev-SEB`, accepté avec, puis
 *      `/s/<sid>/` refusé depuis une autre adresse ;
 *   9. lancement depuis classroom : devoir poussé par `PUT /api/assignments/<id>`
 *      avec un jeton de service, session ouverte par `GET /launch?token=…` sans
 *      seconde connexion, push relayé vers le dépôt **du jeton**, rejeu du
 *      jeton refusé, quota de l'enseignant opposé à un second étudiant.
 *
 * ## Pourquoi pas Playwright
 *
 * Le navigateur n'apporterait ici que le rendu du poste de travail, que le
 * script vérifie déjà par la configuration `vscode-workbench-web-configuration`
 * servie et par une **vraie** mise à niveau websocket (`101` et
 * `Sec-WebSocket-Accept` recalculé). Le reste du parcours — cookies, refus,
 * adresses — se pilote plus sûrement en HTTP, et un binaire Chromium de plus
 * ne serait qu'un point de panne supplémentaire sur un poste WSL.
 *
 * Une seule concession au navigateur est nécessaire : Keycloak pose ses
 * cookies d'état en `Secure` même en clair, ce qu'un vrai navigateur accepte
 * sur `http://localhost` (origine réputée sûre) et que la bibliothèque
 * standard refuserait. Le bocal à cookies ci-dessous fait donc ce que fait le
 * navigateur sur localhost, et rien de plus.
 *
 * ## Le terminal
 *
 * jalon-0 dit « dans le terminal de code-server ». Sans navigateur il n'y a
 * pas de terminal ; les commandes passent donc par `podman exec`, dans le même
 * conteneur, sous le même utilisateur `student`, avec le même durcissement.
 * C'est le même shell, ouvert par une autre porte.
 *
 * Lancement :  pnpm --filter @hgc/codespace e2e
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

// --- configuration du banc d'essai ------------------------------------------
// Base et volumes dédiés : le test est rejouable et ne touche pas au
// développement courant. La grâce est raccourcie pour que l'assertion du
// ramasse-miettes tienne en quelques secondes plutôt qu'en dix minutes ;
// c'est le seul réglage assoupli, et il est explicite.
const E2E_ROOT = join(REPO_ROOT, "var/e2e");
process.env["DATABASE_PATH"] = join(E2E_ROOT, "codespace.sqlite");
process.env["VOLUMES_ROOT"] = join(E2E_ROOT, "volumes");
process.env["SESSION_GRACE_MS"] = process.env["E2E_GRACE_MS"] ?? "8000";
process.env["SESSION_GC_INTERVAL_MS"] = "2000";
process.env["SHADOW_INTERVAL_MS"] = process.env["E2E_SHADOW_MS"] ?? "5000";
process.env["LOG_LEVEL"] = process.env["E2E_LOG_LEVEL"] ?? "warn";
process.env["SEB_VERIFIER"] = "simulated";
// Développement uniquement : rend `request.ip` contrôlable par
// `X-Forwarded-For`, ce qui est la seule façon de simuler un second poste
// sans second poste. `loadConfig()` refuse ce réglage en production.
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

// --- journal ----------------------------------------------------------------
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
  else fail(what, detail || "condition fausse");
  return condition;
}
function measure(name: string, value: string): void {
  measures.push([name, value]);
  console.log(`  MESURE  ${name} = ${value}`);
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
/** `podman exec` avec le shell du conteneur ; rend stdout même en cas d'échec. */
async function inSession(sessionId: string, script: string): Promise<{ out: string; code: number }> {
  try {
    const out = await podman(["exec", containerNameFor(sessionId), "/bin/sh", "-lc", script]);
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.code ?? 1 };
  }
}

// --- bocal à cookies --------------------------------------------------------
interface Cookie {
  name: string;
  value: string;
  path: string;
}
class Jar {
  private readonly jar: Cookie[] = [];

  absorb(headers: Headers): void {
    // `getSetCookie` rend chaque en-tête séparément : indispensable, Keycloak
    // en pose trois d'un coup.
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
  /** Chemin suivi par `follow`, pour que le diagnostic d'un échec soit lisible. */
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

/** Suit les redirections internes au portail, en gardant les cookies. */
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
  throw new Error(`trop de redirections depuis ${url}`);
}

// --- connexion OIDC ---------------------------------------------------------
async function login(jar: Jar, username: string, password: string): Promise<void> {
  // 1. le portail renvoie vers Keycloak
  const start = await request(jar, `${BASE}/auth/login`);
  if (start.status !== 303 || !start.location) {
    throw new Error(`/auth/login n'a pas redirigé (${start.status})`);
  }
  // 2. formulaire de Keycloak
  const form = await fetch(start.location, { redirect: "manual" });
  const kcJar = new Jar();
  kcJar.absorb(form.headers);
  const html = await form.text();
  const action = /id="kc-form-login"[^>]*action="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
  if (!action) throw new Error("formulaire de connexion Keycloak introuvable");
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
    throw new Error(`Keycloak n'a pas redirigé vers le portail (${posted.status})`);
  }
  // 3. retour sur /auth/callback : le portail échange le code et pose son cookie
  const done = await request(jar, callback);
  if (done.status !== 303) throw new Error(`/auth/callback a répondu ${done.status}`);
}

// --- mise à niveau websocket -------------------------------------------------
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Une vraie mise à niveau : 101 **et** `Sec-WebSocket-Accept` recalculé depuis
 * la clé envoyée. Un 200 ou un 403 n'est pas une mise à niveau.
 */
function upgradeWebSocket(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; upgraded: boolean; acceptValid: boolean }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const u = new URL(url);
    // Base64 standard, pas base64url : `ws` valide la clé sur
    // /^[+/0-9A-Za-z]{22}==$/ et refuserait un `-` ou un `_`.
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
      rejectPromise(new Error("mise à niveau websocket : délai dépassé"));
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

// --- utilitaires -------------------------------------------------------------
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
  throw new Error(`délai dépassé en attendant ${what}`);
}

/**
 * Le volume est chown vers la plage d'UID du conteneur par `:U` : uid 1000 ne
 * peut pas le supprimer. On passe donc par un conteneur, comme le ferait
 * l'exploitation.
 */
async function wipeE2eRoot(): Promise<void> {
  // Le montage créerait le répertoire s'il manquait, en root : on ne monte que
  // ce qui existe déjà.
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

// --- le test -----------------------------------------------------------------
type Portal = Awaited<ReturnType<typeof buildPortal>>;

async function startPortal(): Promise<Portal> {
  const portal = await buildPortal();
  await portal.app.listen({ port: config.PORT, host: config.HOST });
  return portal;
}

async function main(): Promise<void> {
  step("préalables");
  check(await podmanOk(["version"]), "socket Podman rootful joignable", config.PODMAN_URL);
  const anchor = await podman(["inspect", "codespace-anchor", "--format", "{{.State.Status}}"]).catch(
    () => "",
  );
  check(anchor.trim() === "running", "conteneur d'ancrage en marche (jamais touché par le test)");
  check(
    await podmanOk(["image", "exists", config.CODESPACE_IMAGE]),
    "image étudiante présente",
    config.CODESPACE_IMAGE,
  );
  check(
    await fetch(`${config.FORGE_URL}/api/v1/version`, { signal: AbortSignal.timeout(3000) }).then(
      (r) => r.ok,
      () => false,
    ),
    "Forgejo joignable",
    config.FORGE_URL,
  );
  check(
    await fetch(`${config.OIDC_ISSUER}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(3000),
    }).then(
      (r) => r.ok,
      () => false,
    ),
    "Keycloak joignable",
    config.OIDC_ISSUER,
  );
  check(
    config.CODESPACE_LAUNCH_SECRET.length >= 32,
    "secret de lancement partagé présent dans .env (CODESPACE_LAUNCH_SECRET)",
    `${config.CODESPACE_LAUNCH_SECRET.length} caractères`,
  );
  if (failures > 0) throw new Error("préalables non réunis");

  step("banc d'essai neuf");
  await removeSessionContainers();
  await wipeE2eRoot();
  await runSeed({ config, seedDir: join(REPO_ROOT, "seed"), log: () => undefined });
  ok("graine posée dans une base et des volumes dédiés", E2E_ROOT);

  let portal = await startPortal();
  const jar = new Jar();

  try {
    // --- 1. connexion ------------------------------------------------------
    step("1. connexion OIDC réelle (Keycloak, code + PKCE)");
    await login(jar, "student", "student");
    const home = await follow(jar, `${BASE}/`);
    check(home.status === 200, "page d'accueil servie après connexion");
    check(home.body.includes("Sacha Student"), "l'identité vient bien de l'IdP");
    check(home.body.includes("tp-pointeurs"), "le devoir de travaux pratiques est listé");
    check(
      !home.body.includes('action="/assignments/exam-c/start"'),
      "le devoir d'examen n'a pas de bouton Démarrer (invariant 5)",
    );

    // --- 2. démarrage ------------------------------------------------------
    step("2. clic Démarrer, poste de travail, websocket");
    const clicked = Date.now();
    const started = await request(jar, `${BASE}/assignments/tp-pointeurs/start`, {
      method: "POST",
    });
    check(started.status === 303, "Démarrer redirige", `${started.status} ${started.location}`);
    const sid = /\/s\/([^/]+)\//.exec(started.location ?? "")?.[1] ?? "";
    check(sid.length > 0, "identifiant de session reçu", sid);
    check(jar.get("cs_session")?.startsWith(`${sid}.`) === true, "cookie de session posé");

    const workbench = await follow(jar, new URL(started.location as string, BASE).href);
    const tWorkbench = Date.now() - clicked;
    check(workbench.status === 200, "poste de travail servi à travers le proxy");
    check(
      workbench.body.includes("vscode-workbench-web-configuration"),
      "la page est bien le workbench de code-server",
    );
    measure("clic Démarrer → page workbench", `${(tWorkbench / 1000).toFixed(2)} s`);

    const wsUrl = `${BASE}/s/${sid}/?reconnectionToken=11111111-1111-1111-1111-111111111111&reconnection=false&skipWebSocketFrames=false`;
    const wsStarted = Date.now();
    const ws = await upgradeWebSocket(wsUrl, {
      Cookie: jar.header(`${BASE}/s/${sid}/`) ?? "",
    });
    const tWs = Date.now() - wsStarted;
    check(ws.upgraded, "mise à niveau websocket à travers le proxy", `statut ${ws.status}`);
    check(ws.acceptValid, "Sec-WebSocket-Accept recalculé et conforme");
    measure("clic Démarrer → websocket établi", `${((Date.now() - clicked) / 1000).toFixed(2)} s`);
    measure("mise à niveau websocket seule", `${tWs} ms`);

    const wsNoCookie = await upgradeWebSocket(wsUrl, {});
    check(
      !wsNoCookie.upgraded && wsNoCookie.status === 403,
      "websocket refusé sans cookie de session",
      `statut ${wsNoCookie.status}`,
    );

    // --- 3. compilation, débogage, push ------------------------------------
    step("3. dans le conteneur : hello.c, make, gdb, git push");
    const listing = await inSession(sid, "ls -a /work && git -C /work remote -v");
    check(listing.out.includes("Makefile"), "le modèle est dans l'espace de travail");
    check(
      listing.out.includes(".vscode"),
      "la configuration de lancement gdb est fournie par le dépôt modèle",
    );
    check(
      listing.out.includes("portal.internal:9418/git/"),
      "le remote origin est le canal Git du portail",
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
    check(build.code === 0, "make + gdb -batch dans le conteneur", build.out.slice(-200));
    check(build.out.includes("reponse 42"), "le programme compilé s'exécute");
    check(
      /exited normally|\[Inferior .* exited normally\]/.test(build.out),
      "gdb a exécuté le programme sans « Operation not permitted »",
    );
    check(
      /disable-randomization.*is on|randomization.*\bon\b/i.test(build.out),
      "gdb désactive bien l'ASLR (profil seccomp du projet)",
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
    check(pushed.code === 0 && sha !== "", "git push depuis le conteneur", pushed.out.slice(-200));

    const events = await waitFor("le PushEvent", async () => {
      const rows = await portal.store.bySession(sid);
      return rows.some((r) => r.sha === sha) ? rows : null;
    });
    check(
      events.some((r) => r.sha === sha && r.ref === "refs/heads/main"),
      "PushEvent en base avec le bon sha",
      sha.slice(0, 12),
    );

    const relayStarted = Date.now();
    await waitFor(
      "le commit dans Forgejo",
      async () =>
        fetch(
          `${config.FORGE_URL}/api/v1/repos/codespace/tp-pointeurs-student/git/commits/${sha}`,
          { headers: { Authorization: `token ${config.FORGE_TOKEN}` } },
        ).then((r) => r.ok),
      30_000,
    );
    ok("commit relayé dans Forgejo");
    measure("push → commit dans Forgejo", `${((Date.now() - relayStarted) / 1000).toFixed(2)} s`);

    // --- 4. podman kill puis rechargement ----------------------------------
    step("4. podman kill puis rechargement de la page");
    const beforeKill = (
      await podman(["inspect", containerNameFor(sid), "--format", "{{.Id}}"])
    ).trim();
    await podman(["kill", containerNameFor(sid)]);
    await waitFor(
      "l'arrêt du conteneur",
      async () =>
        (await podman(["inspect", containerNameFor(sid), "--format", "{{.State.Status}}"]))
          .trim() !== "running",
    );
    ok("conteneur tué");
    const reloadStarted = Date.now();
    const reloaded = await follow(jar, `${BASE}/s/${sid}/`);
    check(
      reloaded.status === 200,
      "rechargement servi",
      `${reloaded.status} · ${reloaded.hops.join(" | ")}`,
    );
    check(
      reloaded.body.includes("vscode-workbench-web-configuration"),
      "le poste de travail est de nouveau là",
      reloaded.body.slice(0, 160).replace(/\s+/g, " "),
    );
    const afterKill = (
      await podman(["inspect", containerNameFor(sid), "--format", "{{.Id}}"])
    ).trim();
    check(afterKill !== beforeKill, "un nouveau conteneur a été lancé");
    measure("rechargement après kill → workbench", `${((Date.now() - reloadStarted) / 1000).toFixed(2)} s`);
    const survived = await inSession(sid, "cat /work/hello.c");
    check(survived.out.includes("reponse %d"), "le fichier est là : même volume");

    // --- 5. grâce -----------------------------------------------------------
    step("5. plus de battement : grâce, puis destruction du conteneur");
    const volumeDir = join(config.volumesRoot, "student", "tp-pointeurs");
    await waitFor(
      "la destruction du conteneur après la grâce",
      async () => !(await podmanOk(["inspect", containerNameFor(sid)])),
      Number(process.env["SESSION_GRACE_MS"]) + 20_000,
    );
    ok("conteneur détruit après la grâce", `${process.env["SESSION_GRACE_MS"]} ms`);
    check(await exists(join(volumeDir, "work")), "le volume de travail est conservé");
    check(await exists(join(volumeDir, "staging.git")), "le dépôt de transit est conservé");
    check(await exists(join(volumeDir, "shadow.git")), "le dépôt fantôme existe");
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
      "shadow.git porte au moins un instantané",
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
    check(shadowFiles.includes("hello.c"), "l'instantané porte le travail de l'étudiant");
    check(
      !shadowFiles.includes(".git/"),
      "l'instantané exclut le dépôt de l'étudiant",
    );

    // --- 6. redémarrage du portail avec une session active -----------------
    step("6. redémarrage du portail avec une session active");
    const restarted = await request(jar, `${BASE}/assignments/tp-pointeurs/start`, {
      method: "POST",
    });
    const sid2 = /\/s\/([^/]+)\//.exec(restarted.location ?? "")?.[1] ?? "";
    check(sid2 === sid, "la session du couple (étudiant, devoir) est reprise, pas dupliquée", sid2);
    await follow(jar, `${BASE}/s/${sid}/`);
    const liveBefore = (
      await podman(["inspect", containerNameFor(sid), "--format", "{{.Id}}"])
    ).trim();

    await portal.close();
    portal = await startPortal();
    ok("portail redémarré");
    const afterRestart = await follow(jar, `${BASE}/s/${sid}/`);
    check(
      afterRestart.status === 200,
      "la session reste accessible après redémarrage",
      `${afterRestart.status} ${afterRestart.body.slice(0, 160).replace(/\s+/g, " ")}`,
    );
    const liveAfter = (
      await podman(["inspect", containerNameFor(sid), "--format", "{{.Id}}"])
    ).trim();
    check(liveAfter === liveBefore, "le conteneur n'a pas été recréé", liveAfter.slice(0, 12));

    // --- 7. refus sans cookie ----------------------------------------------
    step("7. refus d'accès sans cookie de session");
    const naked = await request(jar, `${BASE}/s/${sid}/`, { noCookies: true });
    check(naked.status === 403, "403 sans cookie", String(naked.status));
    check(naked.body.includes("Session non autorisée"), "page de refus explicite");

    // --- 7 bis. rôle enseignant --------------------------------------------
    step("7 bis. rôle enseignant, déduit du realm");
    const teacherJar = new Jar();
    await login(teacherJar, "teacher", "teacher");
    const board = await follow(teacherJar, `${BASE}/teacher/sessions`);
    check(board.status === 200, "le tableau des sessions est servi à l'enseignant");
    check(board.body.includes("Sacha Student"), "la session de l'étudiant y figure");
    check(board.body.includes("tp-pointeurs") || board.body.includes("TP 3"), "le devoir y figure");
    check(board.body.includes("Fermer"), "le bouton Fermer est proposé");
    const studentBoard = await follow(jar, `${BASE}/teacher/sessions`);
    check(
      studentBoard.status === 403,
      "le même tableau est refusé à l'étudiant",
      String(studentBoard.status),
    );

    // --- 8. mode examen -----------------------------------------------------
    step("8. mode examen : vérification SEB, puis provenance");
    const examJar = new Jar();
    await login(examJar, "student2", "student2");
    const refused = await request(examJar, `${BASE}/exam/exam-c/start`);
    check(refused.status === 403, "démarrage d'examen refusé sans en-tête SEB", String(refused.status));
    check(
      refused.body.includes("Safe Exam Browser"),
      "la page de refus est celle du volet examen",
    );

    const accepted = await request(examJar, `${BASE}/exam/exam-c/start`, {
      headers: { "x-dev-seb": "ok" },
    });
    check(accepted.status === 303, "démarrage accepté avec X-Dev-SEB", String(accepted.status));
    const examSid = /\/s\/([^/]+)\//.exec(accepted.location ?? "")?.[1] ?? "";
    check(examSid !== "", "session d'examen créée", examSid);
    check(examJar.get("exam_session") !== undefined, "cookie exam_session posé");
    check(examJar.get("cs_session")?.startsWith(`${examSid}.`) === true, "cookie de session posé");

    const examPage = await follow(examJar, `${BASE}/s/${examSid}/`);
    check(
      examPage.status === 200,
      "l'épreuve s'ouvre depuis le même poste",
      `${examPage.status} ${examPage.body.slice(0, 160).replace(/\s+/g, " ")}`,
    );
    const examWork = await inSession(examSid, "ls /work && git -C /work log --oneline | head -1");
    check(
      examWork.out.includes("Makefile"),
      "l'espace d'examen est amorcé depuis le modèle de l'enseignant (invariant 6)",
    );

    const elsewhere = await request(examJar, `${BASE}/s/${examSid}/`, {
      headers: { "x-forwarded-for": "192.0.2.7" },
    });
    check(
      elsewhere.status === 403,
      "l'épreuve est refusée depuis une autre adresse client",
      String(elsewhere.status),
    );
    check(
      elsewhere.body.includes("autre poste") || elsewhere.body.includes("Safe Exam Browser"),
      "page « session hors SEB »",
    );

    // Invariant 5, affirmé : le proxy ne regarde aucun en-tête SEB. Une
    // requête *avec* les en-têtes SEB mais sans cookie reste refusée.
    const headersOnly = await request(examJar, `${BASE}/s/${examSid}/`, {
      noCookies: true,
      headers: { "x-dev-seb": "ok", "x-safeexambrowser-configkeyhash": "0".repeat(64) },
    });
    check(
      headersOnly.status === 403,
      "le proxy ne se laisse pas convaincre par un en-tête SEB (invariant 5)",
      String(headersOnly.status),
    );

    // --- 9. lancement depuis classroom -------------------------------------
    step("9. lancement depuis classroom : PUT du devoir, puis /launch");

    const nowSec = (): number => Math.floor(Date.now() / 1000);
    const SECRET = config.CODESPACE_LAUNCH_SECRET;
    const CLASSROOM_ASSIGNMENT = "classroom-lab";
    const CLASSROOM_STUDENT = "e2e-classroom";
    const CLASSROOM_TEACHER = "t-e2e";
    const CLASSROOM_REPO = `${config.FORGE_USER}/classroom-launch-e2e`;
    /** Marqueur de l'exécution courante, pour que le rendu diffère du précédent. */
    const runTag = `${Date.now()}-${randomBytes(4).toString("hex")}`;

    /** Jeton de service : serveur à serveur, audience `heig-codespace-api`. */
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

    /** Jeton de lancement : ce que classroom émet au clic sur Démarrer. */
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
          displayName: "Élève de classroom",
          githubLogin: "e2e-gh",
          assignmentId: CLASSROOM_ASSIGNMENT,
          repo: { fullName: CLASSROOM_REPO, defaultBranch: "main" },
          ...over,
        },
        SECRET,
      );

    // Le dépôt de l'étudiant, tel que classroom l'aurait provisionné. Public,
    // comme ceux de la graine : le miroir du dépôt de transit est lu par un
    // `git fetch` sans jeton, à dessein (docs/v1.md D-V1-8).
    const seedForge = forgejoSeedForge(config.FORGE_URL, config.FORGE_TOKEN);
    const [repoOwner, repoName] = CLASSROOM_REPO.split("/") as [string, string];
    await seedForge.ensure(repoOwner, repoName);
    ok("dépôt de l'étudiant créé dans la forge", CLASSROOM_REPO);

    const syncBody = (quota: number): unknown => ({
      id: CLASSROOM_ASSIGNMENT,
      slug: "tp-classroom",
      name: "TP lancé depuis classroom",
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
    check(unauthorised.status === 401, "PUT refusé sans jeton de service", String(unauthorised.status));

    const synced = await putAssignment(2);
    check(synced.status === 200, "devoir synchronisé depuis classroom", String(synced.status));
    const syncedBody = JSON.parse(synced.body) as { id: string; configKey: string | null };
    check(
      syncedBody.id === CLASSROOM_ASSIGNMENT && syncedBody.configKey === null,
      "réponse du PUT : identifiant, pas de Config Key en mode en ligne",
    );
    const again = await putAssignment(2);
    check(again.status === 200 && again.body === synced.body, "le PUT est idempotent");

    // L'étudiant arrive **sans se reconnecter** : pas de cookie OIDC dans ce
    // bocal, seulement le jeton dans l'URL.
    const launchJar = new Jar();
    const launchToken = await makeLaunchToken();
    const launchStarted = Date.now();
    const launched = await request(launchJar, `${BASE}/launch?token=${launchToken}`);
    check(launched.status === 303, "/launch ouvre la session", `${launched.status} ${launched.location}`);
    const csid = /\/s\/([^/]+)\//.exec(launched.location ?? "")?.[1] ?? "";
    check(csid !== "", "identifiant de session reçu", csid);
    check(
      launchJar.get("cs_session")?.startsWith(`${csid}.`) === true,
      "cookie de session du portail posé par /launch (aucune seconde connexion)",
    );
    check(launchJar.get("cs_auth") === undefined, "aucun cookie de connexion OIDC n'est requis");

    const classroomWorkbench = await follow(launchJar, new URL(launched.location as string, BASE).href);
    check(
      classroomWorkbench.status === 200 &&
        classroomWorkbench.body.includes("vscode-workbench-web-configuration"),
      "l'éditeur s'ouvre pour la session lancée depuis classroom",
      `${classroomWorkbench.status}`,
    );
    measure(
      "jeton de lancement → page workbench",
      `${((Date.now() - launchStarted) / 1000).toFixed(2)} s`,
    );

    const replayed = await request(new Jar(), `${BASE}/launch?token=${launchToken}`);
    check(replayed.status === 403, "usage unique : le même jeton est refusé", String(replayed.status));
    check(replayed.body.includes("déjà servi"), "page de refus explicite sur le rejeu");

    const unknownAssignment = await request(
      new Jar(),
      `${BASE}/launch?token=${await makeLaunchToken({ assignmentId: "jamais-synchronise" })}`,
    );
    check(
      unknownAssignment.status === 403 &&
        unknownAssignment.body.includes("non synchronisé depuis classroom"),
      "devoir inconnu : refus nommé",
    );

    // Le push part vers le dépôt **du jeton**, pas vers une convention du devoir.
    const classroomPush = await inSession(
      csid,
      [
        "set -e",
        "cd /work",
        "git config user.name etudiant",
        "git config user.email etudiant@codespace.local",
        // Contenu unique : le dépôt de l'étudiant survit d'une exécution à
        // l'autre (seul `var/e2e/` est balayé), et le miroir du dépôt de
        // transit rapporte donc le rendu précédent. Sans cela, `git commit`
        // n'aurait rien à écrire à la seconde exécution.
        `echo 'depuis classroom ${runTag}' > rendu.txt`,
        "git add -A",
        "git commit -q -m 'rendu lancé depuis classroom'",
        "git push -q origin HEAD:main",
        'echo "SHA=$(git rev-parse HEAD)"',
      ].join("\n"),
    );
    const classroomSha = /SHA=([0-9a-f]{40})/.exec(classroomPush.out)?.[1] ?? "";
    check(
      classroomPush.code === 0 && classroomSha !== "",
      "git push depuis le conteneur lancé par jeton",
      classroomPush.out.slice(-200),
    );
    await waitFor(
      "le commit dans le dépôt du jeton",
      async () =>
        fetch(`${config.FORGE_URL}/api/v1/repos/${CLASSROOM_REPO}/git/commits/${classroomSha}`, {
          headers: { Authorization: `token ${config.FORGE_TOKEN}` },
        }).then((r) => r.ok),
      30_000,
    );
    ok("push relayé vers le dépôt porté par le jeton", CLASSROOM_REPO);

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
      "le tableau des sessions est rendu à classroom avec son propre identifiant d'utilisateur",
      `${summaries.status} · ${rows.length} ligne(s)`,
    );
    check(
      rows.find((r) => r.sessionId === csid)?.lastPushAt !== null,
      "le résumé porte la date du dernier push",
    );

    // Quota par enseignant : une session vivante, quota ramené à un, un second
    // étudiant du même enseignant est refusé — et la reprise du premier, non.
    check((await putAssignment(1)).status === 200, "quota de l'enseignant ramené à une session");
    const overQuota = await request(
      new Jar(),
      `${BASE}/launch?token=${await makeLaunchToken({ sub: "e2e-classroom2", email: "e2e2@heig-vd.ch" })}`,
    );
    check(overQuota.status === 429, "second étudiant refusé : quota atteint", String(overQuota.status));
    check(overQuota.body.includes("Quota atteint"), "page 429 explicite");
    const resumed = await request(new Jar(), `${BASE}/launch?token=${await makeLaunchToken()}`);
    check(
      resumed.status === 303,
      "la reprise de sa propre session ne consomme pas de quota",
      String(resumed.status),
    );

    step("récapitulatif");
    for (const [name, value] of measures) console.log(`  ${name} : ${value}`);
    const volumes = await readdir(config.volumesRoot).catch(() => []);
    console.log(`  volumes conservés : ${volumes.join(", ")}`);
  } finally {
    await portal.close();
    await removeSessionContainers();
    console.log("\nconteneurs de session nettoyés (ancrage, Forgejo et Keycloak intacts).");
  }

  if (failures > 0) {
    console.log(`\nRÉSULTAT : ${failures} assertion(s) en échec.`);
    process.exit(1);
  }
  console.log("\nRÉSULTAT : toutes les assertions sont vertes.");
}

await main();
