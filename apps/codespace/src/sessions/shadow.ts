/**
 * Dépôt fantôme côté hôte (analyse.md § 3.3, filet E15).
 *
 * `git --git-dir=<vol>/shadow.git --work-tree=<vol>/work add -A && commit`,
 * toutes les trois minutes et une dernière fois à la fermeture de la session.
 * Il capture l'arbre de travail y compris ce que l'étudiant n'a pas commité,
 * sans jamais toucher à son dépôt ni apparaître dans le conteneur.
 *
 * `.git` est exclu par `info/exclude` : sans cela, `git add -A` verrait le
 * dépôt de l'étudiant dans `work/.git` et l'enregistrerait comme lien de
 * sous-module, ce qui ne capture rien.
 *
 * ## La question des permissions, et ce qui est fait ici
 *
 * Le volume est monté `:U` (analyse.md D6) : Podman rechown `work/` vers la
 * plage d'UID que `--userns=auto` a tirée pour ce conteneur, par exemple
 * 2147484647. Le portail tourne en uid 1000. **Mesuré sur ce poste** : les
 * modes sont conservés par le chown, l'umask du conteneur est 022, donc les
 * fichiers restent en 644 et les répertoires en 755 — uid 1000 les lit, et
 * l'instantané fonctionne.
 *
 * Ce qui ne fonctionne pas : un `chmod 600` de l'étudiant. Le fichier devient
 * illisible pour le portail, `git add -A` répond
 * `error: open("x"): Permission denied` et sort en 128. `--ignore-errors`
 * transforme l'échec total en instantané partiel, et c'est ce que fait ce
 * module, en journalisant chaque fichier perdu.
 *
 * Ce n'est **pas** une solution, c'est une atténuation. La solution de
 * production, à instruire au jalon 1, est l'une des deux :
 *
 *  - `--uidmap` fixe par session au lieu de `--userns=auto` : le portail
 *    connaît alors l'UID hôte du conteneur et peut poser un ACL
 *    (`setfacl -R -m u:1000:rX`) hérité par défaut sur `work/` ;
 *  - un temporisateur systemd **root** sur l'hôte qui prend l'instantané, le
 *    portail ne faisant que lui signaler les volumes actifs.
 *
 * Ce qu'il ne faut surtout pas faire, et qui n'est pas fait : retirer `:U`.
 * Sans lui l'étudiant n'écrit plus dans son propre volume.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { git, gitBare } from "../git/index.js";

export interface ShadowResult {
  /** Sha du commit créé, ou null si l'arbre n'avait pas bougé. */
  sha: string | null;
  /** Chemins que le portail n'a pas pu lire (voir l'en-tête du module). */
  unreadable: string[];
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "codespace-portal",
  GIT_AUTHOR_EMAIL: "portal@codespace.local",
  GIT_COMMITTER_NAME: "codespace-portal",
  GIT_COMMITTER_EMAIL: "portal@codespace.local",
} as const;

/** `<vol>/shadow.git`, créé si besoin, avec son exclusion de `.git`. */
export async function ensureShadowRepo(volumeDir: string): Promise<string> {
  const gitDir = join(volumeDir, "shadow.git");
  try {
    await gitBare(gitDir, ["rev-parse", "--git-dir"]);
  } catch {
    await mkdir(gitDir, { recursive: true });
    await git(["init", "--bare", "--initial-branch=main", gitDir]);
  }
  await mkdir(join(gitDir, "info"), { recursive: true });
  // Le dépôt de l'étudiant, et rien d'autre : l'instantané doit porter ses
  // fichiers, pas une copie de son historique.
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
 * Un instantané. Idempotent : sans changement, rien n'est commité et `sha`
 * vaut null.
 */
export async function snapshot(volumeDir: string): Promise<ShadowResult> {
  const gitDir = await ensureShadowRepo(volumeDir);
  const workTree = join(volumeDir, "work");
  const common = ["--git-dir", gitDir, "--work-tree", workTree];

  let unreadable: string[] = [];
  try {
    await git([...common, "add", "-A", "--ignore-errors"], { env: IDENTITY });
  } catch (err) {
    // `--ignore-errors` indexe ce qu'il peut puis sort en 1 : l'instantané
    // partiel est meilleur que pas d'instantané du tout.
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
    [...common, "commit", "--allow-empty", "-q", "-m", `instantané ${new Date().toISOString()}`],
    { env: IDENTITY },
  );
  const sha = (await gitBare(gitDir, ["rev-parse", "HEAD"])).trim();
  return { sha, unreadable };
}
