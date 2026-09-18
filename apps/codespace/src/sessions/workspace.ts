/**
 * Amorçage de l'espace de travail `<vol>/work` : un clone du dépôt de transit,
 * avec `origin` pointé sur le canal Git du portail.
 *
 * **Le moment compte.** Cette fonction s'exécute *avant* le `podman run` :
 * après lui, l'option `:U` a donné `work/` à la plage d'UID que
 * `--userns=auto` a tirée pour le conteneur, et le portail (uid `codespace`)
 * ne peut plus y créer ni y modifier un fichier — en particulier pas
 * `work/.git/config`. C'est la même contrainte que celle décrite dans
 * `shadow.ts`, vue du côté écriture.
 *
 * Conséquence portée par `manager.ts` : l'identifiant de session est **stable
 * pour la vie du volume**, parce que le remote `origin` écrit ici le contient
 * et qu'il ne sera jamais réécrit.
 *
 * Trois états sont distingués, et c'est le correctif du 2026-09-17 :
 *
 *  - `work/.git` absent → amorçage complet depuis le dépôt de transit ;
 *  - `work/.git` présent mais **sans aucun commit** (le cas d'une session dont
 *    le dépôt de transit était vide au premier démarrage, faute de jeton pour
 *    récupérer le dépôt privé de l'étudiant) → on complète : fetch, branche
 *    locale sur la branche par défaut, suivi de `origin/<branche>`. Les
 *    fichiers non suivis que l'étudiant a déjà créés sont conservés —
 *    `checkout -B` depuis une branche non née ne les touche pas ;
 *  - même cas, mais `work/` appartient déjà au conteneur : l'achèvement est
 *    impossible depuis l'hôte et `manager.ts` le fait par `engine.exec` après
 *    le démarrage (`completionScript`).
 *
 * Un dépôt qui porte déjà au moins un commit n'est **jamais** retouché :
 * l'étudiant est maître de son dépôt.
 */
import { access, constants } from "node:fs/promises";
import { join } from "node:path";

import { git, stagingHeadBranch, type StagingPaths } from "../git/index.js";

const IDENTITY = {
  GIT_AUTHOR_NAME: "codespace-portal",
  GIT_AUTHOR_EMAIL: "portal@codespace.local",
  GIT_COMMITTER_NAME: "codespace-portal",
  GIT_COMMITTER_EMAIL: "portal@codespace.local",
} as const;

/**
 * Identité git de l'étudiant, telle que la table `users` la connaît
 * (`display_name`, `email`). Elle n'est pas un secret : c'est le nom et
 * l'adresse académique que l'étudiant lit déjà dans classroom.
 */
export interface GitIdentity {
  name: string;
  email: string;
}

export interface WorkspaceOptions {
  paths: StagingPaths;
  sessionId: string;
  /** `portal.internal` : le nom que `--add-host` donne à la passerelle. */
  gitRemoteHost: string;
  gitRemotePort: number;
  /**
   * Identité à écrire dans `work/.git/config` si elle n'y est pas déjà. Les
   * variables `GIT_AUTHOR_*` / `GIT_COMMITTER_*` du conteneur suffisent à
   * `git commit`, mais l'étudiant qui tape `git config user.name` doit lire
   * quelque chose, et une identité posée par l'étudiant lui-même n'est
   * jamais écrasée.
   */
  identity?: GitIdentity;
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

/**
 * `work/` appartient à la plage d'UID du conteneur dès le premier `:U`, et le
 * portail n'y écrit plus. On le mesure plutôt que de le déduire de l'état de
 * la session : un `podman run` avorté laisse un répertoire encore à nous.
 */
async function writable(path: string): Promise<boolean> {
  return access(path, constants.W_OK | constants.X_OK).then(
    () => true,
    () => false,
  );
}

/**
 * `safe.directory` : après le premier `:U`, `work/` n'appartient plus au
 * portail et git refuse d'y travailler (« detected dubious ownership »).
 * `HOME` étant déjà neutralisé par `gitRunner`, il n'existe aucune
 * configuration globale où poser l'exception : elle se pose à l'appel.
 */
function gitWork(workDir: string, args: string[]): Promise<string> {
  return git(["-c", `safe.directory=${workDir}`, "-C", workDir, ...args], { env: IDENTITY });
}

export interface WorkspaceState {
  /** `work/.git` existe. */
  present: boolean;
  /** Le portail peut encore y écrire (avant le premier `:U`). */
  writable: boolean;
  /** `HEAD` pointe sur un commit. Faux pour une branche non née. */
  born: boolean;
  /** Branche courante, même non née. */
  branch: string | null;
  /** `@{upstream}` résolu, `null` si la branche n'a aucun suivi. */
  upstream: string | null;
}

/** Ce que le portail sait lire de `work/` sans y écrire. */
export async function inspectWorkspace(workDir: string): Promise<WorkspaceState> {
  const present = await exists(join(workDir, ".git"));
  const canWrite = await writable(workDir);
  if (!present) {
    return { present: false, writable: canWrite, born: false, branch: null, upstream: null };
  }
  const head = (
    await gitWork(workDir, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "")
  ).trim();
  const branch = (await gitWork(workDir, ["branch", "--show-current"]).catch(() => "")).trim();
  const upstream = (
    await gitWork(workDir, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]).catch(() => "")
  ).trim();
  return {
    present: true,
    writable: canWrite,
    born: head !== "",
    branch: branch === "" ? null : branch,
    upstream: upstream === "" ? null : upstream,
  };
}

/** Une valeur quelconque, rendue inoffensive pour `sh -lc`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Pose `user.name` / `user.email` dans `work/.git/config`, **sans jamais
 * écraser** ce qui s'y trouve déjà : si l'étudiant a posé la sienne, elle
 * reste. Appelée depuis l'hôte, donc seulement tant que `work/` nous
 * appartient (avant le premier `:U`).
 */
async function writeIdentity(workDir: string, identity: GitIdentity): Promise<void> {
  const present = async (key: string): Promise<boolean> =>
    (await gitWork(workDir, ["config", "--local", "--get", key]).catch(() => "")).trim() !== "";
  if (!(await present("user.name"))) {
    await gitWork(workDir, ["config", "--local", "user.name", identity.name]);
  }
  if (!(await present("user.email"))) {
    await gitWork(workDir, ["config", "--local", "user.email", identity.email]);
  }
}

/**
 * Même chose, jouée **dans le conteneur** quand `work/` ne nous appartient
 * plus. Aucun secret n'y entre : un nom et une adresse académique.
 *
 * Le script sort sans rien faire quand `/work` n'est pas un dépôt — c'est le
 * cas d'un devoir sans dépôt de transit — et ne touche à rien quand l'étudiant
 * a déjà posé son identité.
 */
export function identityScript(identity: GitIdentity): string {
  const name = shellQuote(identity.name);
  const email = shellQuote(identity.email);
  return [
    "set -e",
    "cd /work",
    "git rev-parse --git-dir >/dev/null 2>&1 || exit 0",
    `git config --local --get user.name >/dev/null 2>&1 || git config --local user.name ${name}`,
    `git config --local --get user.email >/dev/null 2>&1 || git config --local user.email ${email}`,
    "git config --local --get user.name",
    "git config --local --get user.email",
  ].join("\n");
}

/**
 * Script d'achèvement, joué **dans le conteneur** quand `work/` ne nous
 * appartient plus. Il fait ce que `ensureWorkspace` fait depuis l'hôte, avec
 * les mêmes garanties :
 *
 *  - `fetch origin` passe par `http://portal.internal:9418/git/<session>`, que
 *    l'adresse IP source authentifie : **aucun secret n'entre dans le
 *    conteneur** (invariant 1) ;
 *  - `checkout -B` depuis une branche non née conserve les fichiers non suivis
 *    que l'étudiant a déjà écrits ; il refuse plutôt que d'écraser un fichier
 *    non suivi qu'apporte le dépôt, et le message le dit ;
 *  - `--set-upstream-to` rend `git pull` et `git push` sans argument corrects.
 */
export function completionScript(branch: string): string {
  return [
    "set -e",
    "cd /work",
    "git fetch -q origin '+refs/heads/*:refs/remotes/origin/*'",
    `git checkout -q -B '${branch}' 'origin/${branch}'`,
    `git branch -q --set-upstream-to='origin/${branch}' '${branch}'`,
    "git --no-pager log --oneline -1",
  ].join("\n");
}

export interface EnsureWorkspaceResult {
  /** `work/.git` a été créé par cet appel. */
  created: boolean;
  /** Un dépôt existant, sans commit, a été rempli par cet appel. */
  completed: boolean;
  /** Branche locale posée, avec suivi. `null` : le dépôt de transit est vide. */
  branch: string | null;
  /**
   * L'achèvement reste à faire et ne peut pas l'être depuis l'hôte : `work/`
   * appartient déjà au conteneur. `manager.ts` le reprend par `engine.exec`
   * après le démarrage.
   */
  needsContainer: boolean;
  /**
   * L'identité git reste à poser et ne peut pas l'être depuis l'hôte, pour la
   * même raison. `manager.ts` joue alors `identityScript` par `engine.exec`.
   */
  needsIdentity: boolean;
}

export async function ensureWorkspace(opts: WorkspaceOptions): Promise<EnsureWorkspaceResult> {
  const work = opts.paths.workDir;
  const origin = remoteUrl(opts.gitRemoteHost, opts.gitRemotePort, opts.sessionId);
  const state = await inspectWorkspace(work);

  // L'identité se pose sur un dépôt qui existe déjà ; pour un dépôt créé plus
  // bas, elle est écrite juste après l'`init`. Elle ne dépend ni des commits
  // ni de la branche : un étudiant dont l'espace de travail est complet doit
  // pouvoir commiter, et c'est précisément le cas observé en production.
  let needsIdentity = false;
  if (opts.identity && state.present) {
    if (state.writable) await writeIdentity(work, opts.identity);
    else needsIdentity = true;
  }

  // Un dépôt qui porte des commits appartient à l'étudiant : on n'y touche pas.
  if (state.present && state.born) {
    return {
      created: false,
      completed: false,
      branch: state.branch,
      needsContainer: false,
      needsIdentity,
    };
  }

  const branch = await stagingHeadBranch(opts.paths.gitDir);
  if (state.present && branch === null) {
    // Dépôt de transit toujours sans référence (dépôt cible vide en mode TP) :
    // rien à poser, l'espace de travail reste celui de l'étudiant.
    return { created: false, completed: false, branch: null, needsContainer: false, needsIdentity };
  }
  if (state.present && !state.writable) {
    // Reprise d'une session déjà démarrée : `:U` a donné `work/` au conteneur.
    return { created: false, completed: false, branch, needsContainer: true, needsIdentity };
  }

  if (!state.present) {
    await git(["init", "-q", "--initial-branch=main", work], { env: IDENTITY });
    await git(["-C", work, "remote", "add", "origin", origin], { env: IDENTITY });
    if (opts.identity) await writeIdentity(work, opts.identity);
  }
  // Le contenu vient du dépôt de transit par le chemin local : le portail n'a
  // pas à passer par son propre serveur HTTP pour se parler à lui-même.
  await gitWork(work, [
    "fetch",
    "-q",
    opts.paths.gitDir,
    "+refs/heads/*:refs/remotes/origin/*",
  ]).catch(() => "");
  const branches = (
    await gitWork(work, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/remotes/origin/",
    ]).catch(() => "")
  )
    .split("\n")
    .filter(Boolean);
  // La branche par défaut du dépôt de transit d'abord — c'est celle du dépôt
  // de l'étudiant, `master` aussi souvent que `main` —, puis `origin/main`,
  // puis la première venue.
  const preferred =
    branch && branches.includes(`origin/${branch}`)
      ? `origin/${branch}`
      : branches.includes("origin/main")
        ? "origin/main"
        : branches[0];
  let local: string | null = null;
  if (preferred) {
    local = preferred.replace(/^origin\//, "");
    await gitWork(work, ["checkout", "-q", "-B", local, preferred]);
    // Le suivi est ce qui rend `git pull` et `git push` sans argument corrects
    // dans le conteneur ; sans lui, l'étudiant doit nommer son remote et sa
    // branche à chaque fois.
    await gitWork(work, ["branch", "-q", `--set-upstream-to=${preferred}`, local]).catch(() => "");
  }
  opts.log?.info(
    { sessionId: opts.sessionId, origin, branch: local, completed: state.present },
    state.present ? "espace de travail complété" : "espace de travail amorcé",
  );
  return {
    created: !state.present,
    completed: state.present,
    branch: local,
    needsContainer: false,
    needsIdentity,
  };
}
