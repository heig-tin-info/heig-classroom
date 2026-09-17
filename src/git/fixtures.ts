/**
 * Repository fixtures shared by the P3 tests.
 *
 * Not a `*.test.ts` file on purpose: vitest would demand test cases in it,
 * and tsconfig only excludes `*.test.ts`, so this stays type-checked with
 * the rest of the module. It imports no test framework.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { git } from "./gitRunner.js";

/** Deterministic identity: the tests assert on shas, not on who signed. */
export const FIXTURE_ENV = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@codespace.local",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@codespace.local",
} as const;

export async function tempDir(prefix = "p3-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * A bare repository holding one commit, usable as a `mirrorFrom` or
 * `templateFrom` source.
 */
export async function makeSourceRepo(opts: {
  dir: string;
  branch?: string;
  files: Record<string, string>;
  message?: string;
}): Promise<{ gitDir: string; sha: string }> {
  const branch = opts.branch ?? "main";
  const work = join(opts.dir, "work");
  await git(["init", `--initial-branch=${branch}`, work], { env: FIXTURE_ENV });
  for (const [name, content] of Object.entries(opts.files)) {
    await writeFile(join(work, name), content, "utf8");
  }
  await git(["-C", work, "add", "-A"], { env: FIXTURE_ENV });
  await git(["-C", work, "commit", "-m", opts.message ?? "fixture"], { env: FIXTURE_ENV });
  const bare = join(opts.dir, "source.git");
  await git(["clone", "--bare", work, bare], { env: FIXTURE_ENV });
  const sha = (await git(["-C", work, "rev-parse", "HEAD"], { env: FIXTURE_ENV })).trim();
  return { gitDir: bare, sha };
}
