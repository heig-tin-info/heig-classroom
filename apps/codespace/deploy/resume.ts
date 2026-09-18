/**
 * Resuming an existing session on the deployed portal, from the workstation.
 *
 * There is no "Start" button in production: `OIDC_ISSUER` is empty and the
 * student always arrives through `GET /launch?token=…` (docs/deploy.md § 4).
 * So this script plays classroom's part — it signs a launch token itself with
 * the shared secret, like `deploy/smoke.ts` and `scripts/e2e.ts` § 9 — but
 * for a session that **already exists**: same `sub`, same assignment, same
 * repository as the ones held in the database.
 *
 * What it is for: resuming a session whose workspace could not be bootstrapped
 * (staging repository with no reference), after the GitHub App has been put
 * in place. The portal then bootstraps again and fills `work/` (docs/deploy.md § 5).
 *
 *   CODESPACE_LAUNCH_SECRET="$(ssh root@code.chevallier.io \
 *       sed -n 's/^CODESPACE_LAUNCH_SECRET=//p' /etc/codespace/env)" \
 *     pnpm --filter @hgc/codespace exec tsx deploy/resume.ts \
 *       --student <classroom sub> --assignment <id> \
 *       --repo <owner/name> --branch <default branch>
 *
 * The four values are read from the database on the VM (table `sessions`,
 * columns `student`, `assignment_id`, `target_repo`). The script creates
 * nothing that does not exist: if the (student, assignment) pair has no
 * session, the portal opens a fresh one, the normal behaviour of `/launch`.
 */
import { randomBytes } from "node:crypto";

import { signHs256 } from "@hgc/domain";

const BASE = process.env["CODESPACE_BASE"] ?? "https://code.chevallier.io";
const SECRET = process.env["CODESPACE_LAUNCH_SECRET"] ?? "";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const student = arg("student") ?? "";
const assignment = arg("assignment") ?? "";
const repo = arg("repo") ?? "";
const branch = arg("branch") ?? "main";
const email = arg("email") ?? `${student}@heig-vd.ch`;

if (SECRET.length < 32 || !student || !assignment || !repo) {
  console.error(
    "usage: CODESPACE_LAUNCH_SECRET=… tsx deploy/resume.ts " +
      "--student <sub> --assignment <id> --repo <owner/name> [--branch <b>] [--email <a>]",
  );
  process.exit(2);
}

const nowSec = Math.floor(Date.now() / 1000);
const token = await signHs256(
  {
    iss: "heig-classroom",
    aud: "heig-codespace",
    iat: nowSec,
    exp: nowSec + 300,
    jti: randomBytes(16).toString("hex"),
    sub: student,
    email,
    displayName: student,
    githubLogin: null,
    assignmentId: assignment,
    repo: { fullName: repo, defaultBranch: branch },
  },
  SECRET,
);

const started = Date.now();
const res = await fetch(`${BASE}/launch?token=${token}`, { redirect: "manual" });
const body = await res.text();
const location = res.headers.get("location");
console.log(`status     : ${res.status}`);
console.log(`redirect   : ${location ?? "(none)"}`);
console.log(`duration   : ${((Date.now() - started) / 1000).toFixed(2)} s`);
if (res.status !== 303) {
  // A refusal page is in French and only a few lines long: we make it
  // readable instead of spitting it back out as is.
  const text = body
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  console.log(`page       : ${text.slice(0, 400)}`);
  process.exit(1);
}
console.log(`session    : ${/\/s\/([^/]+)\//.exec(location ?? "")?.[1] ?? "?"}`);
