/**
 * Reprise d'une session existante sur le portail déployé, depuis le poste.
 *
 * Il n'y a pas de « bouton Démarrer » en production : `OIDC_ISSUER` est vide et
 * l'étudiant arrive toujours par `GET /launch?token=…` (docs/deploy.md § 4).
 * Ce script joue donc le rôle de classroom — il signe lui-même un jeton de
 * lancement avec le secret partagé, comme `deploy/smoke.ts` et `scripts/e2e.ts`
 * § 9 — mais pour une session **qui existe déjà** : même `sub`, même devoir,
 * même dépôt que ceux qui sont en base.
 *
 * À quoi ça sert : reprendre une session dont l'espace de travail n'a pas pu
 * être amorcé (dépôt de transit sans référence), après avoir posé la GitHub
 * App. Le portail réamorce alors et complète `work/` (docs/deploy.md § 5).
 *
 *   CODESPACE_LAUNCH_SECRET="$(ssh root@code.chevallier.io \
 *       sed -n 's/^CODESPACE_LAUNCH_SECRET=//p' /etc/codespace/env)" \
 *     pnpm --filter @hgc/codespace exec tsx deploy/resume.ts \
 *       --student <sub classroom> --assignment <id> \
 *       --repo <owner/nom> --branch <branche par défaut>
 *
 * Les quatre valeurs se lisent en base sur la VM (table `sessions`, colonnes
 * `student`, `assignment_id`, `target_repo`). Le script ne crée rien qui
 * n'existe pas : si le couple (étudiant, devoir) n'a pas de session, le portail
 * en ouvre une neuve, ce qui est le comportement normal de `/launch`.
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
    "usage : CODESPACE_LAUNCH_SECRET=… tsx deploy/resume.ts " +
      "--student <sub> --assignment <id> --repo <owner/nom> [--branch <b>] [--email <a>]",
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
console.log(`statut     : ${res.status}`);
console.log(`redirection: ${location ?? "(aucune)"}`);
console.log(`durée      : ${((Date.now() - started) / 1000).toFixed(2)} s`);
if (res.status !== 303) {
  // Une page de refus est en français et tient en quelques lignes : on la rend
  // lisible plutôt que de la recracher telle quelle.
  const text = body
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  console.log(`page       : ${text.slice(0, 400)}`);
  process.exit(1);
}
console.log(`session    : ${/\/s\/([^/]+)\//.exec(location ?? "")?.[1] ?? "?"}`);
