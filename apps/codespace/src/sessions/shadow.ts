/**
 * Host-side shadow repository (analyse.md § 3.3, safety net E15).
 *
 * `git --git-dir=<vol>/shadow.git --work-tree=<vol>/work add -A && commit`,
 * every three minutes and one last time when the session closes.
 * It captures the working tree including what the student has not committed,
 * without ever touching their repository or showing up in the container.
 *
 * `.git` is excluded through `info/exclude`: without that, `git add -A` would
 * see the student's repository in `work/.git` and record it as a submodule
 * link, which captures nothing.
 *
 * ## The permissions question, and what is done about it here
 *
 * The volume is mounted `:U` (analyse.md D6): Podman rechowns `work/` to the
 * UID range that `--userns=auto` drew for this container, for example
 * 2147484647. The portal runs as uid 1000. **Measured on this machine**: the
 * modes are preserved by the chown, the container's umask is 022, so files
 * stay at 644 and directories at 755 — uid 1000 can read them, and the
 * snapshot works.
 *
 * What does not work: a `chmod 600` by the student. The file becomes
 * unreadable for the portal, `git add -A` answers
 * `error: open("x"): Permission denied` and exits with 128. `--ignore-errors`
 * turns the total failure into a partial snapshot, and that is what this
 * module does, logging every file lost.
 *
 * This is **not** a solution, it is a mitigation. The production solution, to
 * be worked out at milestone 1, is one of these two:
 *
 *  - a per-session fixed `--uidmap` instead of `--userns=auto`: the portal then
 *    knows the container's host UID and can set an ACL
 *    (`setfacl -R -m u:1000:rX`) inherited by default on `work/`;
 *  - a **root** systemd timer on the host that takes the snapshot, the portal
 *    only telling it which volumes are active.
 *
 * What must above all not be done, and is not done: removing `:U`. Without it
 * the student can no longer write into their own volume.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { git, gitBare } from "../git/index.js";

export interface ShadowResult {
  /** Sha of the commit created, or null if the tree had not moved. */
  sha: string | null;
  /** Paths the portal could not read (see the module header). */
  unreadable: string[];
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "codespace-portal",
  GIT_AUTHOR_EMAIL: "portal@codespace.local",
  GIT_COMMITTER_NAME: "codespace-portal",
  GIT_COMMITTER_EMAIL: "portal@codespace.local",
} as const;

/** `<vol>/shadow.git`, created if needed, with its `.git` exclusion. */
export async function ensureShadowRepo(volumeDir: string): Promise<string> {
  const gitDir = join(volumeDir, "shadow.git");
  try {
    await gitBare(gitDir, ["rev-parse", "--git-dir"]);
  } catch {
    await mkdir(gitDir, { recursive: true });
    await git(["init", "--bare", "--initial-branch=main", gitDir]);
  }
  await mkdir(join(gitDir, "info"), { recursive: true });
  // The student's repository, and nothing else: the snapshot must carry their
  // files, not a copy of their history.
  await writeFile(join(gitDir, "info", "exclude"), ".git\n", "utf8");
  return gitDir;
}

const UNREADABLE = /(?:error: open\("([^"]+)"\)|warning: could not open directory '([^']+)')/g;

function unreadablePaths(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(UNREADABLE)) {
    const path = m[1] ?? m[2];
    if (path) found.add(path);
  }
  return [...found];
}

/**
 * One snapshot. Idempotent: with no change, nothing is committed and `sha` is
 * null.
 */
export async function snapshot(volumeDir: string): Promise<ShadowResult> {
  const gitDir = await ensureShadowRepo(volumeDir);
  const workTree = join(volumeDir, "work");
  const common = ["--git-dir", gitDir, "--work-tree", workTree];

  let unreadable: string[] = [];
  try {
    await git([...common, "add", "-A", "--ignore-errors"], { env: IDENTITY });
  } catch (err) {
    // `--ignore-errors` indexes what it can then exits with 1: a partial
    // snapshot is better than no snapshot at all.
    const message = String((err as Error).message ?? err);
    unreadable = unreadablePaths(message);
    if (unreadable.length === 0) throw err;
  }

  const status = await git([...common, "status", "--porcelain=v1"], { env: IDENTITY }).catch(
    () => "",
  );
  const staged = (
    await git([...common, "diff", "--cached", "--name-only"], { env: IDENTITY }).catch(() => "")
  ).trim();
  const hasHead = await gitBare(gitDir, ["rev-parse", "--verify", "HEAD"]).then(
    () => true,
    () => false,
  );
  if (staged === "" && hasHead) return { sha: null, unreadable };
  if (staged === "" && !hasHead && status.trim() === "") return { sha: null, unreadable };

  await git(
    [...common, "commit", "--allow-empty", "-q", "-m", `snapshot ${new Date().toISOString()}`],
    { env: IDENTITY },
  );
  const sha = (await gitBare(gitDir, ["rev-parse", "HEAD"])).trim();
  return { sha, unreadable };
}
