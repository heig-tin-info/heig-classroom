/**
 * Amorçage de l'espace de travail `<vol>/work` : un clone du dépôt de transit,
 * avec `origin` pointé sur le canal Git du portail.
 *
 * **Le moment compte.** Cette fonction s'exécute *avant* le `podman run` :
 * après lui, l'option `:U` a donné `work/` à la plage d'UID que
 * `--userns=auto` a tirée pour le conteneur, et le portail (uid 1000) ne peut
 * plus y créer ni y modifier un fichier — en particulier pas
 * `work/.git/config`. C'est la même contrainte que celle décrite dans
 * `shadow.ts`, vue du côté écriture.
 *
 * Conséquence portée par `manager.ts` : l'identifiant de session est **stable
 * pour la vie du volume**, parce que le remote `origin` écrit ici le contient
 * et qu'il ne sera jamais réécrit.
 *
 * Idempotent : si `work/.git` existe, on ne touche à rien. L'étudiant est
 * maître de son dépôt.
 */
import { access } from "node:fs/promises";
import { join } from "node:path";

import { git, type StagingPaths } from "../git/index.js";

const IDENTITY = {
  GIT_AUTHOR_NAME: "codespace-portal",
  GIT_AUTHOR_EMAIL: "portal@codespace.local",
  GIT_COMMITTER_NAME: "codespace-portal",
  GIT_COMMITTER_EMAIL: "portal@codespace.local",
} as const;

export interface WorkspaceOptions {
  paths: StagingPaths;
  sessionId: string;
  /** `portal.internal` : le nom que `--add-host` donne à la passerelle. */
  gitRemoteHost: string;
  gitRemotePort: number;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

export function remoteUrl(host: string, port: number, sessionId: string): string {
  return `http://${host}:${port}/git/${sessionId}`;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export async function ensureWorkspace(opts: WorkspaceOptions): Promise<{ created: boolean }> {
  const work = opts.paths.workDir;
  if (await exists(join(work, ".git"))) return { created: false };

  const origin = remoteUrl(opts.gitRemoteHost, opts.gitRemotePort, opts.sessionId);
  await git(["init", "-q", "--initial-branch=main", work], { env: IDENTITY });
  await git(["-C", work, "remote", "add", "origin", origin], { env: IDENTITY });
  // Le contenu vient du dépôt de transit par le chemin local : le portail n'a
  // pas à passer par son propre serveur HTTP pour se parler à lui-même.
  await git(
    ["-C", work, "fetch", "-q", opts.paths.gitDir, "+refs/heads/*:refs/remotes/origin/*"],
    { env: IDENTITY },
  ).catch(() => "");
  const branches = (
    await git(["-C", work, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/"], {
      env: IDENTITY,
    }).catch(() => "")
  )
    .split("\n")
    .filter(Boolean);
  const preferred = branches.includes("origin/main") ? "origin/main" : branches[0];
  if (preferred) {
    const local = preferred.replace(/^origin\//, "");
    await git(["-C", work, "checkout", "-q", "-B", local, preferred], { env: IDENTITY });
    await git(["-C", work, "branch", `--set-upstream-to=${preferred}`, local], {
      env: IDENTITY,
    }).catch(() => "");
  }
  opts.log?.info({ sessionId: opts.sessionId, origin }, "espace de travail amorcé");
  return { created: true };
}
