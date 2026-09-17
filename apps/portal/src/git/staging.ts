/**
 * The staging repository (analyse.md 3.1): one bare repo per (student,
 * assignment) pair, next to the student's volume, that decouples the
 * submission from the availability of the forge. The student's push lands
 * here in milliseconds and *is* the timestamped proof; the relay comes after.
 *
 * Layout (analyse.md D6):
 *
 *     <VOLUMES_ROOT>/<student>/<assignment>/
 *       work/         bind-mounted into the container
 *       staging.git/  this module; invisible from the container
 *       shadow.git/   snapshots (V1, not here)
 */
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { gitBare, git } from "./gitRunner.js";

/**
 * Where the staging repository is seeded from. The distinction is invariant
 * 6, not a convenience: in exam mode the source is the teacher's template
 * and never the student's own repository, which is the simplest way around
 * the whole apparatus (analyse.md 4.2).
 */
export type StagingSource =
  /** Lab: mirror of the student's target repository, re-synced on demand. */
  | { mode: "lab"; mirrorFrom: string }
  /** Exam: the teacher's template only. Later pushes on it propagate here. */
  | { mode: "exam"; templateFrom: string }
  /** No source at all: an empty repository the student fills. */
  | { mode: "empty" };

export interface StagingOptions {
  volumesRoot: string;
  student: string;
  assignment: string;
  source: StagingSource;
  /** `http.uploadpack`; true by default (analyse.md 3.2). */
  uploadPack?: boolean;
  /** Default branch of a fresh repository. */
  defaultBranch?: string;
}

export interface StagingPaths {
  /** `<VOLUMES_ROOT>/<student>/<assignment>` */
  dir: string;
  /** `<dir>/staging.git` */
  gitDir: string;
  /** `<dir>/work`, the only part the container ever sees. */
  workDir: string;
}

/**
 * A student or assignment identifier must not be able to walk out of
 * `VOLUMES_ROOT` (`..`, an absolute path, a NUL). The identifiers come from
 * the IdP and the assignment file, so this is a belt on top of braces.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function stagingPaths(volumesRoot: string, student: string, assignment: string): StagingPaths {
  for (const [label, value] of [
    ["student", student],
    ["assignment", assignment],
  ] as const) {
    if (!SAFE_ID.test(value) || value === "." || value === "..") {
      throw new Error(`identifiant ${label} invalide pour un chemin : ${JSON.stringify(value)}`);
    }
  }
  const dir = join(volumesRoot, student, assignment);
  return { dir, gitDir: join(dir, "staging.git"), workDir: join(dir, "work") };
}

const REFSPECS = ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"];

async function isBareRepo(gitDir: string): Promise<boolean> {
  try {
    const entries = await readdir(gitDir);
    return entries.includes("HEAD") && entries.includes("objects");
  } catch {
    return false;
  }
}

/** First branch that exists, so `clone` checks something out. */
async function pickHead(gitDir: string, preferred: string): Promise<void> {
  const out = await gitBare(gitDir, ["for-each-ref", "--format=%(refname)", "refs/heads/"]);
  const branches = out.split("\n").filter(Boolean);
  if (branches.length === 0) return;
  const target = branches.includes(`refs/heads/${preferred}`)
    ? `refs/heads/${preferred}`
    : (branches[0] as string);
  await gitBare(gitDir, ["symbolic-ref", "HEAD", target]);
}

/**
 * Creates the staging repository if needed and (re-)seeds it from its
 * source. Idempotent: called at every session start, and again when the
 * teacher pushes a fix to the exam template.
 *
 * `http.receivepack` is always true — the student must be able to push even
 * when the forge is down. `http.uploadpack` follows the assignment, and is
 * also enforced per request in httpBackend.ts, because the repository config
 * is not the authority on a policy that can change mid-session.
 */
export async function ensureStagingRepo(
  opts: StagingOptions,
): Promise<StagingPaths & { created: boolean }> {
  const paths = stagingPaths(opts.volumesRoot, opts.student, opts.assignment);
  const defaultBranch = opts.defaultBranch ?? "main";
  await mkdir(paths.workDir, { recursive: true });

  const existed = await isBareRepo(paths.gitDir);
  if (!existed) {
    await mkdir(paths.gitDir, { recursive: true });
    await git(["init", "--bare", `--initial-branch=${defaultBranch}`, paths.gitDir]);
  }
  await gitBare(paths.gitDir, ["config", "http.receivepack", "true"]);
  await gitBare(paths.gitDir, [
    "config",
    "http.uploadpack",
    String(opts.uploadPack ?? true),
  ]);
  // The relay reads the reflog to bound its work; a bare repo has none by
  // default and `for-each-ref` snapshots would be the only history.
  await gitBare(paths.gitDir, ["config", "core.logAllRefUpdates", "true"]);

  const from = sourceUrl(opts.source);
  if (from) {
    await gitBare(paths.gitDir, ["fetch", "--prune", "--no-tags", from, ...REFSPECS]);
  }
  await pickHead(paths.gitDir, defaultBranch);
  return { ...paths, created: !existed };
}

/**
 * The single point where the exam invariant is enforced: an exam staging
 * repository is only ever fetched from the template.
 */
function sourceUrl(source: StagingSource): string | null {
  switch (source.mode) {
    case "lab":
      return source.mirrorFrom;
    case "exam":
      return source.templateFrom;
    case "empty":
      return null;
  }
}

/** `refs/heads/main` → sha, for every ref. Used before/after receive-pack. */
export async function refSnapshot(gitDir: string): Promise<Map<string, string>> {
  const out = await gitBare(gitDir, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  const refs = new Map<string, string>();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const sp = line.indexOf(" ");
    if (sp > 0) refs.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return refs;
}
