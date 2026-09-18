/**
 * Development seed: reads `seed/assignments.yaml`, creates the repositories on
 * the forge, pushes the templates to them, writes the `users` and `assignments`
 * rows.
 *
 * It lives here rather than in `scripts/` because the repository root has no
 * `node_modules` (pnpm workspace): `scripts/seed.ts` is only a wrapper that
 * calls `runSeed`.
 *
 * Idempotent: replayable. Existing repositories are kept, assignments are
 * updated, the exam salt is **never** regenerated — changing it would
 * invalidate the Config Key of the `.seb` files already handed out.
 */
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { parse } from "yaml";
import { z } from "zod";

import type { AppConfig } from "../auth/config.js";
import { buildPushEnv, git } from "../git/index.js";
import { newExamKeySalt, renderSebFile, sebStartPath } from "../seb/index.js";

import { openDb, type Db } from "./client.js";
import { assignments, users, type AssignmentSebConfig } from "./schema.js";

const UserSpec = z.object({
  login: z.string(),
  displayName: z.string(),
  email: z.string(),
  role: z.enum(["student", "teacher"]).default("student"),
});

const AssignmentSpec = z.object({
  id: z.string(),
  title: z.string(),
  mode: z.enum(["lab", "exam"]).default("lab"),
  image: z.string(),
  uploadPack: z.boolean().default(true),
  template: z.string(),
  modelRepo: z.string(),
  targetRepoPattern: z.string().optional(),
  targetRepo: z.string().optional(),
  seedTargetFromTemplate: z.boolean().default(true),
  opensAt: z.string().optional(),
  closesAt: z.string().optional(),
  beks: z.array(z.string()).default([]),
});

export const SeedSpec = z.object({
  users: z.array(UserSpec),
  assignments: z.array(AssignmentSpec),
});

export type SeedFile = z.infer<typeof SeedSpec>;

interface Forge {
  /**
   * Creates the repository if it is missing. **Public**: the staging repository
   * of a lab assignment is a mirror of the target repository, read by a
   * `git fetch` without a token (`git/staging.ts` takes none). Nothing
   * confidential lives in the development forge.
   */
  ensure(owner: string, name: string): Promise<void>;
  cloneUrl(owner: string, name: string): string;
  authorization(): string;
}

export function forgejoSeedForge(baseUrl: string, token: string): Forge {
  const base = baseUrl.replace(/\/+$/, "");
  const api = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}/api/v1${path}`, {
      ...init,
      headers: {
        Authorization: `token ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  return {
    cloneUrl: (owner, name) => `${base}/${owner}/${name}.git`,
    authorization: () => `token ${token}`,
    async ensure(owner, name) {
      const head = await api(`/repos/${owner}/${name}`);
      if (head.ok) return;
      if (head.status !== 404) throw new Error(`forge: GET /repos answered ${head.status}`);
      const body = JSON.stringify({ name, private: false, auto_init: false });
      let created = await api("/user/repos", { method: "POST", body });
      if (!created.ok && created.status !== 409) {
        created = await api(`/orgs/${owner}/repos`, { method: "POST", body });
      }
      if (!created.ok && created.status !== 409) {
        throw new Error(`forge: creation of ${owner}/${name} refused (${created.status})`);
      }
    },
  };
}

function splitRepo(full: string): { owner: string; name: string } {
  const slash = full.indexOf("/");
  if (slash <= 0 || slash === full.length - 1) throw new Error(`malformed repository: ${full}`);
  return { owner: full.slice(0, slash), name: full.slice(slash + 1) };
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "codespace-seed",
  GIT_AUTHOR_EMAIL: "seed@codespace.local",
  GIT_COMMITTER_NAME: "codespace-seed",
  GIT_COMMITTER_EMAIL: "seed@codespace.local",
} as const;

/** Pushes the content of a template directory into a repository on the forge. */
async function pushTemplate(forge: Forge, full: string, templateDir: string): Promise<string> {
  const { owner, name } = splitRepo(full);
  await forge.ensure(owner, name);
  const work = await mkdtemp(join(tmpdir(), "codespace-seed-"));
  try {
    await git(["init", "-q", "--initial-branch=main", work], { env: IDENTITY });
    await cp(templateDir, work, { recursive: true });
    await git(["-C", work, "add", "-A"], { env: IDENTITY });
    await git(["-C", work, "commit", "-q", "-m", `template ${name}`], { env: IDENTITY });
    // The token goes through the environment, never in argv nor on disk
    // (jalon-0 § P3): same mechanism as `git/relay.ts`.
    await git(
      ["-C", work, "push", "--force", forge.cloneUrl(owner, name), "HEAD:refs/heads/main"],
      { env: { ...IDENTITY, ...buildPushEnv(forge.authorization()) } },
    );
    return forge.cloneUrl(owner, name);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export interface SeedOptions {
  config: AppConfig;
  /** The repository's `seed/` directory. */
  seedDir: string;
  /** Database already open (tests); otherwise `DATABASE_PATH`. */
  db?: Db;
  log?: (line: string) => void;
}

export interface SeedReport {
  users: number;
  assignments: string[];
  repos: string[];
  configKeys: Record<string, string>;
}

export async function runSeed(opts: SeedOptions): Promise<SeedReport> {
  const { config } = opts;
  const log = opts.log ?? ((line: string) => console.log(line));
  if (!config.FORGE_TOKEN) {
    throw new Error("FORGE_TOKEN missing: see src/git/README.md");
  }
  const spec = SeedSpec.parse(
    parse(await readFile(join(opts.seedDir, "assignments.yaml"), "utf8")),
  );
  const forge = forgejoSeedForge(config.FORGE_URL, config.FORGE_TOKEN);
  const handle = opts.db ? null : openDb(config.databasePath);
  const db = opts.db ?? handle!.db;
  const now = new Date();
  const report: SeedReport = { users: 0, assignments: [], repos: [], configKeys: {} };

  log(`database: ${config.databasePath}`);
  log(`forge: ${config.FORGE_URL}`);

  // --- users ---------------------------------------------------------------
  // Pre-registration only: `oidc_sub` stays `pending:<login>` until the first
  // login, and `auth/plugin.ts` then adopts the row by its `login`. No session
  // is born from here (invariant 4).
  for (const u of spec.users) {
    const existing = db.select().from(users).where(eq(users.login, u.login)).get();
    if (existing) {
      db.update(users)
        .set({ displayName: u.displayName, email: u.email })
        .where(eq(users.id, existing.id))
        .run();
    } else {
      db.insert(users)
        .values({
          id: `seed-${u.login}`,
          oidcSub: `pending:${u.login}`,
          login: u.login,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          createdAt: now,
        })
        .run();
    }
    report.users += 1;
    log(`  user: ${u.login} (${u.role})`);
  }
  const students = spec.users.filter((u) => u.role === "student");

  // --- assignments ---------------------------------------------------------
  const publicOrigin = config.SEB_PUBLIC_ORIGIN || config.PUBLIC_URL;
  for (const a of spec.assignments) {
    log(`assignment ${a.id} (${a.mode})`);
    const templateDir = join(opts.seedDir, a.template);
    const modelUrl = await pushTemplate(forge, a.modelRepo, templateDir);
    report.repos.push(a.modelRepo);
    log(`  template repository: ${a.modelRepo}`);

    for (const s of students) {
      const full = (a.targetRepo ?? a.targetRepoPattern ?? "").replace(/\{student\}/g, s.login);
      if (!full) continue;
      if (a.seedTargetFromTemplate) {
        await pushTemplate(forge, full, templateDir);
      } else {
        // Invariant 6: created, but **empty**. The exam's staging repository is
        // seeded from the template, never from the student's repository.
        const { owner, name } = splitRepo(full);
        await forge.ensure(owner, name);
      }
      report.repos.push(full);
      log(`  target repository: ${full}${a.seedTargetFromTemplate ? "" : " (empty)"}`);
    }

    let configKey: string | null = null;
    let sebConfig: AssignmentSebConfig | null = null;
    if (a.mode === "exam") {
      if (a.beks.length === 0) {
        throw new Error(`assignment ${a.id} in exam mode without a BEK: refused (seb/README.md, decision 3)`);
      }
      const previous = db.select().from(assignments).where(eq(assignments.id, a.id)).get();
      const examKeySalt = previous?.sebConfig?.examKeySalt ?? newExamKeySalt();
      const quitUrl = new URL("/", publicOrigin).href;
      const file = renderSebFile({
        startUrl: new URL(sebStartPath(a.id), publicOrigin).href,
        quitUrl,
        examKeySalt,
      });
      configKey = file.configKey;
      sebConfig = { examKeySalt, quitUrl };
      report.configKeys[a.id] = configKey;
      log(`  Config Key: ${configKey}`);
    }

    const row = {
      id: a.id,
      title: a.title,
      mode: a.mode,
      image: a.image,
      uploadPack: a.uploadPack,
      templateRepo: modelUrl,
      targetRepo: a.targetRepo ?? null,
      targetRepoPattern: a.targetRepoPattern ?? null,
      opensAt: a.opensAt ? new Date(a.opensAt) : null,
      closesAt: a.closesAt ? new Date(a.closesAt) : null,
      configKey,
      beks: a.beks,
      sebConfig,
      createdAt: now,
    };
    const { createdAt: _ignored, ...updatable } = row;
    db.insert(assignments)
      .values(row)
      .onConflictDoUpdate({ target: assignments.id, set: updatable })
      .run();
    report.assignments.push(a.id);
  }

  handle?.close();
  log("seed applied.");
  return report;
}
