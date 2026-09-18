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
        throw new Error(`forgejo: GET /repos answered ${head.status}`);
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
          `forgejo: creation of ${repo.owner}/${repo.name} refused (${created.status})`,
        );
      }
    },
  };
}

/**
 * What the GitHub forge asks of octokit, and nothing more. The interface
 * exists so that unit tests can replace it: without it, checking the
 * per-organisation resolution, the cache and the expiry would take a real
 * App and a real network.
 */
export interface GithubAppApi {
  /** `GET /orgs/{org}/installation`; `null` = App not installed on the org. */
  installationIdFor(org: string): Promise<number | null>;
  /** Installation token, with its expiry date in milliseconds. */
  installationToken(installationId: number): Promise<{ token: string; expiresAt: number }>;
}

export interface GithubOptions {
  appId: string | number;
  /** PEM private key of the GitHub App. Read from disk at startup, in memory afterwards. */
  privateKey: string;
  /** GitHub Enterprise; github.com by default. */
  baseUrl?: string;
  /** Replacement for octokit, for tests. */
  api?: GithubAppApi;
  now?: () => number;
}

/** Renewal margin: a push that has started must not outlive its token. */
export const TOKEN_RENEWAL_MARGIN_MS = 60_000;
/** Nominal lifetime of a GitHub installation token, when the API does not give it. */
export const INSTALLATION_TOKEN_TTL_MS = 3_600_000;

/** Real implementation: octokit, loaded lazily. */
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
 * GitHub through an App installation token, the **same App as
 * heig-classroom** (`apps/server/src/github/app.ts`, whose gesture this
 * module repeats without importing anything from it: the monorepo's import
 * rule forbids that).
 *
 * The installation is not a setting: it is resolved per **organisation**, the
 * one of the repository `owner`, because a portal serves several classes and
 * each of them lives in its own GitHub organisation. The token it yields is
 * valid for an hour; it is cached per installation and renewed one minute
 * before it expires.
 *
 * An organisation where the App is not installed is a **configuration**
 * error, not an outage: `ForgeUnconfiguredError` leaves the relay row
 * `pending` and makes session bootstrap fail with a named cause, rather than
 * opening an empty workspace.
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
        `GitHub App not installed on organisation ${org}: the portal can neither read ` +
          `nor write its repositories. Install the App on this organisation.`,
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
     * **`Basic`, not `Bearer`.** The git transport of github.com refuses an
     * installation token presented as `Bearer` ("remote: invalid
     * credentials", measured on the VM on 2026-09-17); it expects HTTP basic
     * authentication with `x-access-token` as the user name and the token as
     * the password. heig-classroom does the same by slipping the pair into
     * the URL (`github/git.ts`, `authUrl`); here it stays in a header, so out
     * of argv and out of git's logs.
     */
    authorization: async (repo) =>
      `Basic ${Buffer.from(`x-access-token:${await installationToken(repo.owner)}`).toString("base64")}`,
    async ensureRepo() {
      // Repositories are provisioned by heig-classroom (analyse.md D3); the
      // portal only pushes into what already exists.
    },
  };
}

/**
 * A relay **configuration** error, as opposed to a forge outage. `relay.ts`
 * tells them apart: a forge that is down eventually exhausts the attempt
 * budget and the row turns `failed`; a forge that is not configured is not an
 * outage, the row must stay `pending` until the operator installs the
 * credentials, and the relay will resume on its own.
 */
export class ForgeUnconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForgeUnconfiguredError";
  }
}

/**
 * GitHub **without** App credentials: everything that does not need a token
 * works (the clone URL of a public repository, from which the staging
 * repository bootstraps in lab-work mode), and the relay refuses explicitly.
 *
 * This is the state of a deployment that has not received its GitHub App yet:
 * the portal starts, sessions open, the `PushEvent`s are written (invariant 7)
 * and stay `pending` with the message below in `last_error`. Nothing is lost;
 * setting `GITHUB_APP_*` is enough to drain the queue.
 *
 * What does **not** work any more, on the other hand, is bootstrapping a
 * staging repository from a private repository: the session is then refused
 * with a named cause rather than opened on an empty workspace
 * (docs/deploy.md § 5).
 */
export const UNCONFIGURED_GITHUB_MESSAGE =
  "GitHub App not configured: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH are missing " +
  "from /etc/codespace/env. Only public repositories are reachable.";

export function createUnconfiguredGithubForge(opts: { baseUrl?: string } = {}): Forge {
  const host = (opts.baseUrl ?? "https://github.com").replace(/\/+$/, "");
  return {
    kind: "github",
    pushUrl: (repo) => `${host}/${repo.owner}/${repo.name}.git`,
    async authorization() {
      throw new ForgeUnconfiguredError(UNCONFIGURED_GITHUB_MESSAGE);
    },
    async ensureRepo() {
      // Repositories are provisioned by heig-classroom (analyse.md D3).
    },
  };
}
