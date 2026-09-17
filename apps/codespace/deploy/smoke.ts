/**
 * Preuve fonctionnelle du portail déployé, depuis le poste, en HTTPS.
 *
 *   CODESPACE_LAUNCH_SECRET="$(ssh root@code.chevallier.io \
 *       sed -n 's/^CODESPACE_LAUNCH_SECRET=//p' /etc/codespace/env)" \
 *     pnpm --filter @hgc/codespace exec tsx deploy/smoke.ts
 *
 * Ce que le script démontre, et rien d'autre : qu'un jeton de lancement émis
 * par classroom ouvre une session réelle sur la VM, que l'éditeur est servi à
 * travers Caddy en TLS, et qu'une **vraie** mise à niveau websocket (101 et
 * `Sec-WebSocket-Accept` recalculé) traverse le frontal — c'est ce dont
 * code-server dépend entièrement, et ce qu'un `curl /healthz` ne dit pas.
 *
 * Il joue le rôle de classroom : il signe lui-même ses deux jetons avec
 * `signHs256` et le secret partagé, exactement comme `scripts/e2e.ts` § 9.
 * Aucune connexion OIDC n'est nécessaire — c'est le point de l'intégration
 * (docs/integration-classroom.md § 1).
 *
 * Il ne nettoie pas derrière lui : la session, le devoir et l'utilisateur de
 * fumée restent en base. La fermeture de session et le ménage sont décrits
 * dans docs/deploy.md, § « nettoyage après une passe de fumée ».
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import https from "node:https";

import { signHs256 } from "@hgc/domain";

// --- réglages ---------------------------------------------------------------

const BASE = process.env["SMOKE_BASE"] ?? "https://code.chevallier.io";
const SECRET = process.env["CODESPACE_LAUNCH_SECRET"] ?? "";
/**
 * Dépôt GitHub **public** minimal en C de l'organisation du cours (7 Ko,
 * branche `main`). Il sert deux fois : comme `sourceRepo` du devoir et comme
 * dépôt de l'étudiant porté par le jeton. En mode travaux pratiques, c'est le
 * second qui amorce le dépôt de transit (`stagingSourceFor`, mode `lab`), donc
 * les deux doivent être clonables sans jeton — ce qui est le cas d'un dépôt
 * public, et c'est délibéré : aucun secret ne transite par là (docs/v1.md
 * D-V1-8).
 */
const REPO = process.env["SMOKE_REPO"] ?? "heig-tin-info/example-priority-queue";
const BRANCH = process.env["SMOKE_BRANCH"] ?? "main";
const STUDENT = process.env["SMOKE_STUDENT"] ?? "smoke";
const TEACHER = "smoke-teacher";
const ASSIGNMENT =
  process.env["SMOKE_ASSIGNMENT"] ?? `smoke-${new Date().toISOString().slice(0, 10)}`;

if (SECRET.length < 32) {
  console.error(
    "CODESPACE_LAUNCH_SECRET absent ou trop court. Le lire sur la VM :\n" +
      "  ssh root@<vm> sed -n 's/^CODESPACE_LAUNCH_SECRET=//p' /etc/codespace/env",
  );
  process.exit(2);
}

// --- journal ----------------------------------------------------------------

let failures = 0;
const measures: Array<[string, string]> = [];
const step = (t: string): void => console.log(`\n=== ${t}`);
const measure = (name: string, value: string): void => {
  measures.push([name, value]);
  console.log(`  MESURE  ${name} = ${value}`);
};
function check(condition: boolean, what: string, detail = ""): boolean {
  if (condition) console.log(`  PASS  ${what}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${what} — ${detail || "condition fausse"}`);
  }
  return condition;
}

// --- jetons, comme classroom les émet ---------------------------------------

const nowSec = (): number => Math.floor(Date.now() / 1000);

const serviceToken = (): Promise<string> =>
  signHs256(
    { iss: "heig-classroom", aud: "heig-codespace-api", iat: nowSec(), exp: nowSec() + 300 },
    SECRET,
  );

const launchToken = (over: Record<string, unknown> = {}): Promise<string> =>
  signHs256(
    {
      iss: "heig-classroom",
      aud: "heig-codespace",
      iat: nowSec(),
      exp: nowSec() + 300,
      jti: randomBytes(16).toString("hex"),
      sub: STUDENT,
      email: `${STUDENT}@heig-vd.ch`,
      displayName: "Étudiant de fumée",
      githubLogin: null,
      assignmentId: ASSIGNMENT,
      repo: { fullName: REPO, defaultBranch: BRANCH },
      ...over,
    },
    SECRET,
  );

// --- HTTP, avec un bocal à cookies minimal ----------------------------------

const jar = new Map<string, string>();

function absorb(headers: Headers): void {
  for (const raw of headers.getSetCookie()) {
    const pair = raw.split(";", 1)[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

const cookieHeader = (): string => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

async function req(
  url: string,
  init: RequestInit & { noCookies?: boolean } = {},
): Promise<{ status: number; location: string | null; body: string }> {
  const res = await fetch(url, {
    ...init,
    redirect: "manual",
    headers: {
      accept: "text/html,application/xhtml+xml",
      ...(init.noCookies || jar.size === 0 ? {} : { cookie: cookieHeader() }),
      ...(init.headers ?? {}),
    },
  });
  if (!init.noCookies) absorb(res.headers);
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

// --- mise à niveau websocket, en TLS, à travers Caddy ------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Une vraie mise à niveau : 101 **et** `Sec-WebSocket-Accept` recalculé. */
function upgradeWebSocket(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; upgraded: boolean; acceptValid: boolean }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // Base64 standard, pas base64url : la clé est validée sur
    // /^[+/0-9A-Za-z]{22}==$/ et un `-` ou un `_` serait refusé.
    const key = randomBytes(16).toString("base64");
    const request = https.request({
      host: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: "GET",
      servername: u.hostname,
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
      request.destroy();
      reject(new Error("mise à niveau websocket : délai dépassé"));
    }, 20_000);
    request.on("upgrade", (res, socket) => {
      clearTimeout(timer);
      const expected = createHash("sha1").update(key + WS_GUID).digest("base64");
      socket.destroy();
      resolve({
        status: 101,
        upgraded: true,
        acceptValid: res.headers["sec-websocket-accept"] === expected,
      });
    });
    request.on("response", (res) => {
      clearTimeout(timer);
      res.resume();
      resolve({ status: res.statusCode ?? 0, upgraded: false, acceptValid: false });
    });
    request.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    request.end();
  });
}

// --- la passe ---------------------------------------------------------------

console.log(`heig-codespace — fumée sur ${BASE}`);
console.log(`  devoir ${ASSIGNMENT}, étudiant ${STUDENT}, dépôt ${REPO}#${BRANCH}`);

step("0. le portail répond en TLS");
const health = await req(`${BASE}/healthz`, { noCookies: true });
check(health.status === 200 && health.body === '{"ok":true}', "/healthz", health.body);

step("1. PUT du devoir, avec un jeton de service (ce que fait classroom)");
const unauthorised = await req(`${BASE}/api/assignments/${ASSIGNMENT}`, {
  method: "PUT",
  noCookies: true,
  headers: { "content-type": "application/json" },
  body: "{}",
});
check(unauthorised.status === 401, "PUT refusé sans jeton de service", String(unauthorised.status));

const body = {
  id: ASSIGNMENT,
  slug: ASSIGNMENT,
  name: "Fumée — file de priorité",
  classroomId: "smoke-classroom",
  classroomName: "Classe de fumée",
  mode: "online",
  image: null,
  sourceRepo: { fullName: REPO, defaultBranch: BRANCH },
  browserExamKeys: [],
  teacher: { id: TEACHER, email: "smoke-teacher@heig-vd.ch" },
  quota: { maxActiveSessions: 2 },
  startAt: new Date(Date.now() - 3_600_000).toISOString(),
  deadlineAt: null,
};
const synced = await req(`${BASE}/api/assignments/${ASSIGNMENT}`, {
  method: "PUT",
  noCookies: true,
  headers: {
    authorization: `Bearer ${await serviceToken()}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(body),
});
check(synced.status === 200, "devoir synchronisé", `${synced.status} ${synced.body.slice(0, 120)}`);
check(
  JSON.parse(synced.body || "{}").configKey === null,
  "pas de Config Key en mode en ligne (le mode examen seul en a une)",
);

step("2. GET /launch : l'étudiant arrive sans se connecter");
const t0 = Date.now();
const token = await launchToken();
const launched = await req(`${BASE}/launch?token=${token}`);
check(
  launched.status === 303,
  "/launch ouvre la session",
  `${launched.status} ${launched.location ?? ""}`,
);
const sid = /\/s\/([^/]+)\//.exec(launched.location ?? "")?.[1] ?? "";
check(sid !== "", "identifiant de session reçu", sid);
check(
  jar.get("cs_session")?.startsWith(`${sid}.`) === true,
  "cookie cs_session posé par /launch (aucune seconde connexion)",
);
check(jar.get("cs_auth") === undefined, "aucun cookie OIDC n'est requis ni posé");

step("3. le poste de travail, à travers Caddy");
let page = { status: 0, location: null as string | null, body: "" };
let url = new URL(launched.location ?? "/", BASE).href;
for (let i = 0; i < 6; i++) {
  page = await req(url);
  if (page.status >= 300 && page.status < 400 && page.location) {
    url = new URL(page.location, url).href;
    continue;
  }
  break;
}
const tWorkbench = Date.now() - t0;
check(page.status === 200, "page servie", String(page.status));
check(
  page.body.includes("vscode-workbench-web-configuration"),
  "c'est bien le workbench de code-server",
);
measure("jeton de lancement → page workbench (HTTPS)", `${(tWorkbench / 1000).toFixed(2)} s`);

step("4. mise à niveau websocket à travers Caddy");
const wsUrl =
  `${BASE}/s/${sid}/?reconnectionToken=${randomUUID()}` +
  `&reconnection=false&skipWebSocketFrames=false`;
const tWs0 = Date.now();
const ws = await upgradeWebSocket(wsUrl, { Cookie: cookieHeader() });
check(ws.upgraded, "101 Switching Protocols", `statut ${ws.status}`);
check(ws.acceptValid, "Sec-WebSocket-Accept recalculé et conforme");
measure("mise à niveau websocket seule", `${Date.now() - tWs0} ms`);
measure("jeton de lancement → websocket établi", `${((Date.now() - t0) / 1000).toFixed(2)} s`);

const wsNoCookie = await upgradeWebSocket(wsUrl, {});
check(
  !wsNoCookie.upgraded && wsNoCookie.status === 403,
  "websocket refusé sans cookie de session",
  `statut ${wsNoCookie.status}`,
);

step("5. usage unique du jeton");
const replayed = await req(`${BASE}/launch?token=${token}`, { noCookies: true });
check(
  replayed.status === 403 && replayed.body.includes("déjà servi"),
  "le même jeton est refusé au rejeu",
  String(replayed.status),
);

step("6. connexion autonome absente, et c'est voulu");
const login = await req(`${BASE}/auth/login`, { noCookies: true });
check(login.status === 404, "/auth/login répond 404 (OIDC_ISSUER vide)", String(login.status));
const home = await req(`${BASE}/`, { noCookies: true });
check(home.status === 503, "la page d'accueil nomme l'absence d'IdP", String(home.status));

step("récapitulatif");
for (const [name, value] of measures) console.log(`  ${name} : ${value}`);
console.log(`\n  session ouverte : ${sid}`);
console.log(`  devoir de fumée : ${ASSIGNMENT} (reste en base, aucune route ne le supprime)`);
console.log(failures === 0 ? "\n  FUMÉE VERTE\n" : `\n  ${failures} ÉCHEC(S)\n`);
process.exit(failures === 0 ? 0 : 1);
