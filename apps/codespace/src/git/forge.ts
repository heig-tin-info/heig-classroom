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

/**
 * Ce que la forge GitHub demande à octokit, et rien de plus. L'interface
 * existe pour que les tests unitaires puissent la remplacer : sans elle,
 * vérifier la résolution par organisation, le cache et l'expiration
 * demanderait une vraie App et un vrai réseau.
 */
export interface GithubAppApi {
  /** `GET /orgs/{org}/installation` ; `null` = App non installée sur l'org. */
  installationIdFor(org: string): Promise<number | null>;
  /** Jeton d'installation, avec sa date d'expiration en millisecondes. */
  installationToken(installationId: number): Promise<{ token: string; expiresAt: number }>;
}

export interface GithubOptions {
  appId: string | number;
  /** Clé privée PEM de la GitHub App. Lue depuis le disque au démarrage, en mémoire ensuite. */
  privateKey: string;
  /** GitHub Enterprise ; github.com par défaut. */
  baseUrl?: string;
  /** Remplacement d'octokit, pour les tests. */
  api?: GithubAppApi;
  now?: () => number;
}

/** Marge de renouvellement : un push commencé ne doit pas survivre à son jeton. */
export const TOKEN_RENEWAL_MARGIN_MS = 60_000;
/** Durée nominale d'un jeton d'installation GitHub, quand l'API ne la donne pas. */
export const INSTALLATION_TOKEN_TTL_MS = 3_600_000;

/** Implémentation réelle : octokit, chargé paresseusement. */
function octokitApi(opts: Pick<GithubOptions, "appId" | "privateKey" | "baseUrl">): GithubAppApi {
  let app: import("octokit").App | null = null;
  async function theApp(): Promise<import("octokit").App> {
    if (app) return app;
    const { App } = await import("octokit");
    app = new App({ appId: opts.appId, privateKey: opts.privateKey });
    return app;
  }
  return {
    async installationIdFor(org) {
      try {
        const { data } = await (await theApp()).octokit.request("GET /orgs/{org}/installation", {
          org,
        });
        return data.id;
      } catch (err) {
        if ((err as { status?: number }).status === 404) return null;
        throw err;
      }
    },
    async installationToken(installationId) {
      const octokit = await (await theApp()).getInstallationOctokit(installationId);
      const auth = (await octokit.auth({ type: "installation" })) as {
        token: string;
        expiresAt?: string;
      };
      return {
        token: auth.token,
        expiresAt: auth.expiresAt
          ? Date.parse(auth.expiresAt)
          : Date.now() + INSTALLATION_TOKEN_TTL_MS,
      };
    },
  };
}

/**
 * GitHub par jeton d'installation d'App, la **même App que heig-classroom**
 * (`apps/server/src/github/app.ts`, dont ce module reprend le geste sans rien
 * lui importer : la règle d'import du monorepo l'interdit).
 *
 * L'installation n'est pas un réglage : elle est résolue par **organisation**,
 * celle du `owner` du dépôt, parce qu'un portail sert plusieurs classes et que
 * chacune vit dans son organisation GitHub. Le jeton qui en sort vaut une
 * heure ; il est mis en cache par installation et renouvelé une minute avant
 * son expiration.
 *
 * Une organisation où l'App n'est pas installée est une erreur de
 * **configuration**, pas une panne : `ForgeUnconfiguredError` laisse la ligne
 * de relais `pending` et fait refuser l'amorçage d'une session avec une cause
 * nommée, plutôt que d'ouvrir un espace de travail vide.
 */
export function createGithubForge(opts: GithubOptions): Forge {
  const host = (opts.baseUrl ?? "https://github.com").replace(/\/+$/, "");
  const api = opts.api ?? octokitApi(opts);
  const now = opts.now ?? Date.now;
  const installations = new Map<string, number>();
  const tokens = new Map<number, { token: string; expiresAt: number }>();

  async function installationFor(org: string): Promise<number> {
    const known = installations.get(org);
    if (known !== undefined) return known;
    const resolved = await api.installationIdFor(org);
    if (resolved === null) {
      throw new ForgeUnconfiguredError(
        `GitHub App non installée sur l'organisation ${org} : le portail ne peut ni lire ` +
          `ni écrire ses dépôts. Installez l'App sur cette organisation.`,
      );
    }
    installations.set(org, resolved);
    return resolved;
  }

  async function installationToken(org: string): Promise<string> {
    const installationId = await installationFor(org);
    const cached = tokens.get(installationId);
    if (cached && cached.expiresAt - TOKEN_RENEWAL_MARGIN_MS > now()) return cached.token;
    const fresh = await api.installationToken(installationId);
    tokens.set(installationId, fresh);
    return fresh.token;
  }

  return {
    kind: "github",
    pushUrl: (repo) => `${host}/${repo.owner}/${repo.name}.git`,
    /**
     * **`Basic`, pas `Bearer`.** Le transport git de github.com refuse un
     * jeton d'installation présenté en `Bearer` (« remote: invalid
     * credentials », mesuré sur la VM le 2026-09-17) ; il attend l'authent
     * HTTP de base avec `x-access-token` pour identifiant et le jeton pour
     * mot de passe. heig-classroom fait la même chose en glissant le couple
     * dans l'URL (`github/git.ts`, `authUrl`) ; ici il reste dans un en-tête,
     * donc hors de argv et hors des journaux de git.
     */
    authorization: async (repo) =>
      `Basic ${Buffer.from(`x-access-token:${await installationToken(repo.owner)}`).toString("base64")}`,
    async ensureRepo() {
      // Les dépôts sont provisionnés par heig-classroom (analyse.md D3) ; le
      // portail ne fait que pousser dans ce qui existe déjà.
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
 *
 * Ce qui **ne** fonctionne plus, en revanche, c'est l'amorçage d'un dépôt de
 * transit depuis un dépôt privé : la session est alors refusée avec une cause
 * nommée plutôt qu'ouverte sur un espace de travail vide (docs/deploy.md § 5).
 */
export const UNCONFIGURED_GITHUB_MESSAGE =
  "GitHub App non configurée : GITHUB_APP_ID et GITHUB_APP_PRIVATE_KEY_PATH sont absents " +
  "de /etc/codespace/env. Seuls les dépôts publics sont accessibles.";

export function createUnconfiguredGithubForge(opts: { baseUrl?: string } = {}): Forge {
  const host = (opts.baseUrl ?? "https://github.com").replace(/\/+$/, "");
  return {
    kind: "github",
    pushUrl: (repo) => `${host}/${repo.owner}/${repo.name}.git`,
    async authorization() {
      throw new ForgeUnconfiguredError(UNCONFIGURED_GITHUB_MESSAGE);
    },
    async ensureRepo() {
      // Les dépôts sont provisionnés par heig-classroom (analyse.md D3).
    },
  };
}
