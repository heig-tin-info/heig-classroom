/**
 * Spike S2 — Provisionnement via GitHub App (docs/03, section Spikes).
 *
 * Prouve la chaîne complète sur l'organisation sandbox :
 *   token d'installation → création de dépôt privé → push git réel
 *   (x-access-token, y compris .github/workflows/ → permission Workflows)
 *   → ruleset anti force-push → ruleset lock/unlock (deadline GH-41)
 *   → invitation (si S2_STUDENT_LOGIN) → idempotence du rejeu → cleanup.
 *
 * Usage :
 *   pnpm --filter @hgc/server exec tsx spikes/s2-provisioning.ts
 * Variables (lues dans le .env à la racine du repo) :
 *   S2_ORG (défaut heig-test-classroom), S2_COUNT (défaut 30),
 *   S2_KEEP=1 pour garder les dépôts, S2_STUDENT_LOGIN (optionnel).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { App, Octokit } from "octokit";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// --- .env minimal (le spike ne dépend pas du serveur) ---
const env: Record<string, string> = {};
for (const line of readFileSync(join(repoRoot, ".env"), "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]!] = m[2]!;
}
const ORG = process.env.S2_ORG ?? "heig-test-classroom";
const COUNT = Number(process.env.S2_COUNT ?? 30);
const KEEP = process.env.S2_KEEP === "1";
const STUDENT = process.env.S2_STUDENT_LOGIN ?? "";
const PREFIX = "hgc-spike-s2";

const app = new App({
  appId: env.GITHUB_APP_ID!,
  privateKey: readFileSync(resolve(repoRoot, env.GITHUB_APP_PRIVATE_KEY_PATH!), "utf8"),
});

function git(cwd: string, ...args: string[]) {
  return (
    execFileSync("git", ["-C", cwd, ...args], {
      stdio: process.env.S2_GIT_DEBUG === "1" ? ["ignore", "inherit", "inherit"] : "pipe",
    })?.toString() ?? ""
  );
}

interface Timing {
  repo: string;
  ms: number;
  steps: Record<string, number>;
}

async function main() {
  console.log(`# Spike S2 — org=${ORG} count=${COUNT} keep=${KEEP}`);

  // 1. Résolution d'installation + token
  let t = Date.now();
  const { data: inst } = await app.octokit.request("GET /orgs/{org}/installation", {
    org: ORG,
  });
  const octo: Octokit = await app.getInstallationOctokit(inst.id);
  const { token } = (await octo.auth({ type: "installation" })) as { token: string };
  console.log(`installation ${inst.id} résolue et token obtenu en ${Date.now() - t} ms`);

  // 2. « Squashed source » local : contenu type d'un assignment
  const work = mkdtempSync(join(tmpdir(), "s2-src-"));
  writeFileSync(join(work, "README.md"), "# Assignment spike S2\n\nContenu d'énoncé.\n");
  writeFileSync(join(work, "criteria.yml"), "points_max: 6\n");
  mkdirSync(join(work, ".github/workflows"), { recursive: true });
  writeFileSync(
    join(work, ".github/workflows/grading.yml"),
    [
      "name: grading",
      "on: [push]",
      "jobs:",
      "  grade:",
      "    if: github.actor != 'hgc-dev[bot]'",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo '::notice title=GRADE::4.5/6'",
    ].join("\n") + "\n",
  );
  git(work, "init", "-q", "-b", "main");
  git(work, "-c", "user.name=hgc-spike", "-c", "user.email=spike@hgc.local", "add", ".");
  git(
    work,
    "-c", "user.name=hgc-spike", "-c", "user.email=spike@hgc.local",
    "commit", "-q", "-m", "Initial squashed commit",
  );

  // 3. Provisionnement idempotent d'un dépôt étudiant
  async function provision(name: string): Promise<Timing> {
    const steps: Record<string, number> = {};
    const t0 = Date.now();

    // create (idempotent : 422 name already exists → étape déjà faite)
    let t = Date.now();
    let created = true;
    try {
      await octo.request("POST /orgs/{org}/repos", {
        org: ORG,
        name,
        private: true,
        has_issues: false,
        has_wiki: false,
        auto_init: false,
      });
    } catch (err) {
      if ((err as { status?: number }).status !== 422) throw err;
      created = false;
    }
    // Un push immédiat sur un dépôt tout juste créé attend l'initialisation
    // du backend git de GitHub (observé : 15-40 s). Une courte pause évite
    // de payer ce délai dans la connexion git.
    if (created && process.env.S2_NO_GRACE !== "1") {
      await new Promise((r) => setTimeout(r, Number(process.env.S2_GRACE_MS ?? 3000)));
    }
    steps.create = Date.now() - t;

    // push réel (skippé si la ref existe déjà — idempotence). On ne liste les
    // refs que d'un dépôt préexistant : sur un dépôt vide l'appel répond 409
    // et le plugin retry d'Octokit transformerait ce 409 en ~40 s de backoff.
    t = Date.now();
    let needPush = true;
    if (!created) {
      try {
        const res = await octo.request("GET /repos/{owner}/{repo}/git/matching-refs/{ref}", {
          owner: ORG,
          repo: name,
          ref: "heads/main",
          request: { retries: 0 },
        });
        needPush = res.data.length === 0;
      } catch (err) {
        if ((err as { status?: number }).status !== 409) throw err;
      }
    }
    if (needPush) {
      // --ipv4 : sous WSL2, la résolution IPv6 de github.com peut coûter
      // ~40 s de timeout par push ; sans incidence ailleurs.
      git(work, "push", "-q", "--ipv4", `https://x-access-token:${token}@github.com/${ORG}/${name}.git`, "main:main");
    }
    steps.push = Date.now() - t;

    // ruleset anti force-push + anti suppression (GH-21)
    t = Date.now();
    const { data: rulesets } = await octo.request("GET /repos/{owner}/{repo}/rulesets", {
      owner: ORG,
      repo: name,
    });
    if (!rulesets.some((r: { name: string }) => r.name === "hgc-protect")) {
      await octo.request("POST /repos/{owner}/{repo}/rulesets", {
        owner: ORG,
        repo: name,
        name: "hgc-protect",
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        rules: [{ type: "non_fast_forward" }, { type: "deletion" }],
      });
    }
    steps.ruleset = Date.now() - t;

    // invitation (optionnelle sans second compte)
    if (STUDENT) {
      t = Date.now();
      await octo.request("PUT /repos/{owner}/{repo}/collaborators/{username}", {
        owner: ORG,
        repo: name,
        username: STUDENT,
        permission: "push",
      });
      steps.invite = Date.now() - t;
    }

    return { repo: name, ms: Date.now() - t0, steps: { ...steps, created: created ? 1 : 0 } };
  }

  // 4. Lock/unlock (mécanique deadline GH-41)
  async function lockUnlock(name: string) {
    const { data: rs } = await octo.request("POST /repos/{owner}/{repo}/rulesets", {
      owner: ORG,
      repo: name,
      name: "hgc-deadline-lock",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
      rules: [{ type: "update" }, { type: "creation" }, { type: "deletion" }],
    });
    // le push doit être refusé maintenant
    let pushRefused = false;
    try {
      writeFileSync(join(work, "after-deadline.txt"), "trop tard\n");
      git(work, "-c", "user.name=x", "-c", "user.email=x@x", "add", ".");
      git(work, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-m", "late");
      git(work, "push", "-q", `https://x-access-token:${token}@github.com/${ORG}/${name}.git`, "main:main");
    } catch {
      pushRefused = true;
      git(work, "reset", "-q", "--hard", "HEAD~1");
    }
    await octo.request("DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
      owner: ORG,
      repo: name,
      ruleset_id: rs.id,
    });
    return pushRefused;
  }

  // --- Exécution ---
  const timings: Timing[] = [];
  for (let i = 1; i <= COUNT; i++) {
    const name = `${PREFIX}-${String(i).padStart(2, "0")}`;
    const timing = await provision(name);
    timings.push(timing);
    console.log(
      `${timing.repo}: ${timing.ms} ms (create ${timing.steps.create}, push ${timing.steps.push}, ruleset ${timing.steps.ruleset})`,
    );
  }

  // idempotence : rejouer le premier
  const replay = await provision(`${PREFIX}-01`);
  console.log(`rejeu ${PREFIX}-01: ${replay.ms} ms, created=${replay.steps.created} (attendu 0)`);

  // lock deadline : sur le premier
  const pushRefused = await lockUnlock(`${PREFIX}-01`);
  console.log(`lock deadline: push refusé pendant le lock = ${pushRefused} ; ruleset retiré`);

  // quota API restant
  const { data: rate } = await octo.request("GET /rate_limit");
  console.log(`quota API restant: ${rate.resources.core!.remaining}/${rate.resources.core!.limit}`);

  // --- Bilan ---
  const times = timings.map((x) => x.ms).sort((a, b) => a - b);
  const total = times.reduce((a, b) => a + b, 0);
  const summary = {
    count: COUNT,
    total_ms: total,
    mean_ms: Math.round(total / COUNT),
    p50_ms: times[Math.floor(COUNT / 2)],
    max_ms: times[COUNT - 1],
    all_under_60s: times[COUNT - 1]! < 60_000,
    replay_created: replay.steps.created,
    lock_push_refused: pushRefused,
    rate_remaining: rate.resources.core!.remaining,
  };
  console.log("SUMMARY " + JSON.stringify(summary));

  // --- Nettoyage ---
  if (!KEEP) {
    for (const { repo } of timings) {
      try {
        await octo.request("DELETE /repos/{owner}/{repo}", { owner: ORG, repo });
      } catch (err) {
        console.log(`suppression ${repo} impossible (${(err as { status?: number }).status}) — à nettoyer à la main`);
      }
    }
    console.log("dépôts de spike supprimés");
  }
  rmSync(work, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
