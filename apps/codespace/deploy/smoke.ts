/**
 * Functional proof of the deployed portal, from the workstation, over HTTPS.
 *
 *   CODESPACE_LAUNCH_SECRET="$(ssh root@code.chevallier.io \
 *       sed -n 's/^CODESPACE_LAUNCH_SECRET=//p' /etc/codespace/env)" \
 *     pnpm --filter @hgc/codespace exec tsx deploy/smoke.ts
 *
 * What the script demonstrates, and nothing else: that a launch token issued
 * by classroom opens a real session on the VM, that the editor is served
 * through Caddy over TLS, and that a **real** websocket upgrade (101 and a
 * recomputed `Sec-WebSocket-Accept`) crosses the front end — which is what
 * code-server depends on entirely, and what a `curl /healthz` does not say.
 *
 * It plays classroom's part: it signs both of its tokens itself with
 * `signHs256` and the shared secret, exactly like `scripts/e2e.ts` § 9.
 * No OIDC sign-in is needed — that is the whole point of the integration
 * (docs/integration-classroom.md § 1).
 *
 * It does not clean up behind itself: the smoke session, assignment and user
 * stay in the database. Closing the session and the tidy-up are described in
 * docs/deploy.md, § "Cleaning up after a smoke pass".
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import https from "node:https";

import { signHs256 } from "@hgc/domain";

// --- settings ---------------------------------------------------------------

const BASE = process.env["SMOKE_BASE"] ?? "https://code.chevallier.io";
const SECRET = process.env["CODESPACE_LAUNCH_SECRET"] ?? "";
/**
 * Minimal **public** GitHub repository in C from the course organisation (7 kB,
 * branch `main`). It serves twice: as the assignment's `sourceRepo` and as the
 * student repository carried by the token. In lab mode it is the second one
 * that bootstraps the staging repository (`stagingSourceFor`, `lab` mode), so
 * both must be clonable without a token — which is the case for a public
 * repository, and it is deliberate: no secret travels that way (docs/v1.md
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
    "CODESPACE_LAUNCH_SECRET missing or too short. Read it on the VM:\n" +
      "  ssh root@<vm> sed -n 's/^CODESPACE_LAUNCH_SECRET=//p' /etc/codespace/env",
  );
  process.exit(2);
}

// --- log --------------------------------------------------------------------

let failures = 0;
const measures: Array<[string, string]> = [];
const step = (t: string): void => console.log(`\n=== ${t}`);
const measure = (name: string, value: string): void => {
  measures.push([name, value]);
  console.log(`  MEASURE ${name} = ${value}`);
};
function check(condition: boolean, what: string, detail = ""): boolean {
  if (condition) console.log(`  PASS  ${what}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${what} — ${detail || "false condition"}`);
  }
  return condition;
}

// --- tokens, as classroom issues them ---------------------------------------

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
      displayName: "Smoke student",
      githubLogin: null,
      assignmentId: ASSIGNMENT,
      repo: { fullName: REPO, defaultBranch: BRANCH },
      ...over,
    },
    SECRET,
  );

// --- HTTP, with a minimal cookie jar ----------------------------------------

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

// --- websocket upgrade, over TLS, through Caddy ------------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** A real upgrade: 101 **and** a recomputed `Sec-WebSocket-Accept`. */
function upgradeWebSocket(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; upgraded: boolean; acceptValid: boolean }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // Standard base64, not base64url: the key is validated against
    // /^[+/0-9A-Za-z]{22}==$/ and a `-` or a `_` would be refused.
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
      reject(new Error("websocket upgrade: timed out"));
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

// --- the pass ---------------------------------------------------------------

console.log(`heig-codespace — smoke on ${BASE}`);
console.log(`  assignment ${ASSIGNMENT}, student ${STUDENT}, repository ${REPO}#${BRANCH}`);

step("0. the portal answers over TLS");
const health = await req(`${BASE}/healthz`, { noCookies: true });
check(health.status === 200 && health.body === '{"ok":true}', "/healthz", health.body);

step("1. PUT of the assignment, with a service token (what classroom does)");
const unauthorised = await req(`${BASE}/api/assignments/${ASSIGNMENT}`, {
  method: "PUT",
  noCookies: true,
  headers: { "content-type": "application/json" },
  body: "{}",
});
check(unauthorised.status === 401, "PUT refused without a service token", String(unauthorised.status));

const body = {
  id: ASSIGNMENT,
  slug: ASSIGNMENT,
  name: "Smoke — priority queue",
  classroomId: "smoke-classroom",
  classroomName: "Smoke class",
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
check(synced.status === 200, "assignment synchronised", `${synced.status} ${synced.body.slice(0, 120)}`);
check(
  JSON.parse(synced.body || "{}").configKey === null,
  "no Config Key in online mode (only exam mode has one)",
);

step("2. GET /launch: the student arrives without signing in");
const t0 = Date.now();
const token = await launchToken();
const launched = await req(`${BASE}/launch?token=${token}`);
check(
  launched.status === 303,
  "/launch opens the session",
  `${launched.status} ${launched.location ?? ""}`,
);
const sid = /\/s\/([^/]+)\//.exec(launched.location ?? "")?.[1] ?? "";
check(sid !== "", "session id received", sid);
check(
  jar.get("cs_session")?.startsWith(`${sid}.`) === true,
  "cs_session cookie set by /launch (no second sign-in)",
);
check(jar.get("cs_auth") === undefined, "no OIDC cookie is required or set");

step("3. the workbench, through Caddy");
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
check(page.status === 200, "page served", String(page.status));
check(
  page.body.includes("vscode-workbench-web-configuration"),
  "it really is the code-server workbench",
);
measure("launch token → workbench page (HTTPS)", `${(tWorkbench / 1000).toFixed(2)} s`);

step("4. websocket upgrade through Caddy");
const wsUrl =
  `${BASE}/s/${sid}/?reconnectionToken=${randomUUID()}` +
  `&reconnection=false&skipWebSocketFrames=false`;
const tWs0 = Date.now();
const ws = await upgradeWebSocket(wsUrl, { Cookie: cookieHeader() });
check(ws.upgraded, "101 Switching Protocols", `status ${ws.status}`);
check(ws.acceptValid, "Sec-WebSocket-Accept recomputed and correct");
measure("websocket upgrade alone", `${Date.now() - tWs0} ms`);
measure("launch token → websocket established", `${((Date.now() - t0) / 1000).toFixed(2)} s`);

const wsNoCookie = await upgradeWebSocket(wsUrl, {});
check(
  !wsNoCookie.upgraded && wsNoCookie.status === 403,
  "websocket refused without a session cookie",
  `status ${wsNoCookie.status}`,
);

step("5. single use of the token");
const replayed = await req(`${BASE}/launch?token=${token}`, { noCookies: true });
check(
  replayed.status === 403 && replayed.body.includes("déjà servi"),
  "the same token is refused on replay",
  String(replayed.status),
);

step("6. no standalone sign-in, and that is intended");
const login = await req(`${BASE}/auth/login`, { noCookies: true });
check(login.status === 404, "/auth/login answers 404 (OIDC_ISSUER empty)", String(login.status));
const home = await req(`${BASE}/`, { noCookies: true });
check(home.status === 503, "the home page names the missing IdP", String(home.status));

step("summary");
for (const [name, value] of measures) console.log(`  ${name} : ${value}`);
console.log(`\n  session opened: ${sid}`);
console.log(`  smoke assignment: ${ASSIGNMENT} (stays in the database, no route deletes it)`);
console.log(failures === 0 ? "\n  SMOKE GREEN\n" : `\n  ${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
