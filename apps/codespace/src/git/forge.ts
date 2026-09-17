/**
 * The forge the staging repository is relayed to. Two implementations:
 * Forgejo with a personal access token (development, and any self-hosted
 * deployment), GitHub with an App installation token (production, shared
 * with heig-classroom's GitHub App).
 *
 * A `Forge` never hands out a URL with a credential in it. The token leaves
 * this module only as an `Authorization` header value, which relay.ts passes
 * to `git` through the environment — never in argv, never on disk
 * (jalon-0 P3).
 */
import type { RepoRef } from "./types.js";

export interface Forge {
  readonly kind: "forgejo" | "github";
  /** Credential-free HTTPS remote. */
  pushUrl(repo: RepoRef): string;
  /**
   * Fresh `Authorization` header value. GitHub installation tokens expire
   * after an hour, so this is called per relay attempt, not cached by the
   * caller.
   */
  authorization(repo: RepoRef): Promise<string>;
  /** Creates the repository if it does not exist yet. */
  ensureRepo(repo: RepoRef): Promise<void>;
}

export interface ForgejoOptions {
  /** e.g. `http://localhost:3300` */
  baseUrl: string;
  /** Personal access token. Stays in memory. */
  token: string;
  fetchImpl?: typeof fetch;
}

export function createForgejoForge(opts: ForgejoOptions): Forge {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const api = (path: string, init: RequestInit = {}) =>
    doFetch(`${base}/api/v1${path}`, {
      ...init,
      headers: {
        Authorization: `token ${opts.token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

  return {
    kind: "forgejo",
    pushUrl: (repo) => `${base}/${repo.owner}/${repo.name}.git`,
    authorization: async () => `token ${opts.token}`,
    async ensureRepo(repo) {
      const head = await api(`/repos/${repo.owner}/${repo.name}`);
      if (head.ok) return;
      if (head.status !== 404) {
        throw new Error(`forgejo: GET /repos a répondu ${head.status}`);
      }
      // `/user/repos` creates under the token's owner; `/orgs/<o>/repos`
      // under an organisation. Try the first, fall back to the second.
      const body = JSON.stringify({ name: repo.name, private: true, auto_init: false });
      let created = await api("/user/repos", { method: "POST", body });
      if (!created.ok && created.status !== 409) {
        created = await api(`/orgs/${repo.owner}/repos`, { method: "POST", body });
      }
      if (!created.ok && created.status !== 409) {
        throw new Error(
          `forgejo: création de ${repo.owner}/${repo.name} refusée (${created.status})`,
        );
      }
    },
  };
}

export interface GithubOptions {
  appId: string | number;
  /** PEM private key of the GitHub App. Read from the environment, in memory. */
  privateKey: string;
  installationId: number;
  /** GitHub Enterprise; defaults to github.com. */
  baseUrl?: string;
}

/**
 * GitHub via an App installation token, the same App as heig-classroom.
 *
 * Not covered by the integration tests (they run against the development
 * Forgejo): typed and wired, exercised for real at V1 when the portal gets
 * its App credentials. TODO(verify): installation-token relay against the
 * real App before jalon 1.
 */
export function createGithubForge(opts: GithubOptions): Forge {
  const host = (opts.baseUrl ?? "https://github.com").replace(/\/+$/, "");
  let cached: { token: string; expiresAt: number } | null = null;

  async function installationToken(): Promise<string> {
    // Renew a minute early: the relay's own push must not outlive the token.
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    const { App } = await import("octokit");
    const app = new App({ appId: opts.appId, privateKey: opts.privateKey });
    const octokit = await app.getInstallationOctokit(opts.installationId);
    const auth = (await octokit.auth({ type: "installation" })) as {
      token: string;
      expiresAt?: string;
    };
    cached = {
      token: auth.token,
      expiresAt: auth.expiresAt ? Date.parse(auth.expiresAt) : Date.now() + 3_600_000,
    };
    return cached.token;
  }

  return {
    kind: "github",
    pushUrl: (repo) => `${host}/${repo.owner}/${repo.name}.git`,
    authorization: async () => `Bearer ${await installationToken()}`,
    async ensureRepo() {
      // Repositories are provisioned by heig-classroom (analyse.md D3); the
      // portal only pushes to what already exists.
    },
  };
}

/**
 * Erreur de **configuration** du relais, par opposition à une panne de la
 * forge. `relay.ts` la distingue : une forge en panne finit par épuiser le
 * budget de tentatives et la ligne passe `failed` ; une forge non configurée
 * n'est pas une panne, la ligne doit rester `pending` jusqu'à ce que
 * l'exploitant pose les identifiants, et le relais reprendra tout seul.
 */
export class ForgeUnconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForgeUnconfiguredError";
  }
}

/**
 * GitHub **sans** identifiants d'App : tout ce qui ne demande pas de jeton
 * fonctionne (l'URL de clonage d'un dépôt public, dont le dépôt de transit
 * s'amorce en mode travaux pratiques), et le relais refuse explicitement.
 *
 * C'est l'état d'un déploiement qui n'a pas encore reçu sa GitHub App : le
 * portail démarre, les sessions s'ouvrent, les `PushEvent` sont écrits
 * (invariant 7) et restent `pending` avec le message ci-dessous dans
 * `last_error`. Rien n'est perdu ; poser `GITHUB_APP_*` suffit à vider la
 * file.
 */
export function createUnconfiguredGithubForge(opts: { baseUrl?: string } = {}): Forge {
  const host = (opts.baseUrl ?? "https://github.com").replace(/\/+$/, "");
  return {
    kind: "github",
    pushUrl: (repo) => `${host}/${repo.owner}/${repo.name}.git`,
    async authorization() {
      throw new ForgeUnconfiguredError(
        "GitHub App non configurée : GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY et " +
          "GITHUB_APP_INSTALLATION_ID sont absents. Le rendu est enregistré et reste en attente de relais.",
      );
    },
    async ensureRepo() {
      // Les dépôts sont provisionnés par heig-classroom (analyse.md D3).
    },
  };
}
