/**
 * GitHub App client (GH-01..03): authentication via a JWT signed with the
 * PEM private key, resolution of installations per organization. Lazy
 * initialization; an unconfigured App blocks neither boot nor /healthz.
 */
import { existsSync, readFileSync } from "node:fs";

import { App, Octokit } from "octokit";

import type { AppConfig } from "../config.js";

let cached: App | null | undefined;

export function githubApp(config: AppConfig): App | null {
  if (cached !== undefined) return cached;
  if (!config.GITHUB_APP_ID || !existsSync(config.GITHUB_APP_PRIVATE_KEY_PATH)) {
    cached = null;
    return cached;
  }
  cached = new App({
    appId: config.GITHUB_APP_ID,
    privateKey: readFileSync(config.GITHUB_APP_PRIVATE_KEY_PATH, "utf8"),
  });
  return cached;
}

export interface OrgInstallation {
  installationId: number;
  githubOrgId: number;
}

export interface InstallationClient {
  octokit: Octokit;
  token: string;
}

/** Octokit authenticated on an installation + token for git operations. */
export async function installationClient(
  config: AppConfig,
  installationId: number,
): Promise<InstallationClient> {
  const app = githubApp(config);
  if (!app) throw new Error("GitHub App is not configured (missing app id or PEM file)");
  const octokit = await app.getInstallationOctokit(installationId);
  const { token } = (await octokit.auth({ type: "installation" })) as { token: string };
  return { octokit, token };
}

/** Organizations where the App is installed (classroom creation dropdown). */
export async function listInstalledOrgs(config: AppConfig): Promise<string[]> {
  const app = githubApp(config);
  if (!app) return [];
  const logins: string[] = [];
  for await (const { installation } of app.eachInstallation.iterator()) {
    const account = installation.account as { login?: string; type?: string } | null;
    if (account?.login && account.type === "Organization") logins.push(account.login);
  }
  return logins.sort();
}

/** Does the organization exist on GitHub? Authenticated through the App
 *  JWT when configured (the anonymous quota is 60 req/h and exhausts fast);
 *  `null` = indeterminate (rate limit, network): let it through. */
export async function orgExistsOnGithub(
  login: string,
  config?: AppConfig,
): Promise<boolean | null> {
  const app = config ? githubApp(config) : null;
  if (app) {
    try {
      await app.octokit.request("GET /orgs/{org}", { org: login, request: { retries: 0 } });
      return true;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) return false;
      // fall through to the anonymous lookup
    }
  }
  try {
    const res = await fetch(`https://api.github.com/orgs/${encodeURIComponent(login)}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "hgc-server" },
    });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * Billing plan of an installed organization (`free`, `team`, …). GitHub only
 * serves the `plan` field of GET /orgs/{org} to callers holding the App's
 * org Plan permission — i.e. the installation client, not the App JWT.
 * Null = indeterminate (permission not granted, API error): never warn on it.
 */
export async function fetchOrgPlan(
  config: AppConfig,
  installationId: number,
  orgLogin: string,
): Promise<string | null> {
  try {
    const { octokit } = await installationClient(config, installationId);
    const { data } = await octokit.request("GET /orgs/{org}", { org: orgLogin });
    const plan = (data as { plan?: { name?: string } }).plan?.name;
    return plan ? plan.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Presence of the ANTHROPIC_API_KEY organization secret: without it the LLM
 * review tier dies at every deadline/milestone ("Could not resolve
 * authentication method", seen live 2026-07-14). Requires the App's org
 * Secrets read permission; null = indeterminate (permission not granted
 * yet, API error) — never warn on it. Presence only: the value's validity
 * still shows up at the first review run.
 */
export async function fetchOrgLlmSecret(
  config: AppConfig,
  installationId: number,
  orgLogin: string,
): Promise<"ok" | "missing" | null> {
  try {
    const { octokit } = await installationClient(config, installationId);
    await octokit.request("GET /orgs/{org}/actions/secrets/{secret_name}", {
      org: orgLogin,
      secret_name: "ANTHROPIC_API_KEY",
      request: { retries: 0 },
    });
    return "ok";
  } catch (err) {
    return (err as { status?: number }).status === 404 ? "missing" : null;
  }
}

/** GET /orgs/{org}/installation; null if the App is not installed there. */
export async function resolveOrgInstallation(
  config: AppConfig,
  orgLogin: string,
): Promise<OrgInstallation | null> {
  const app = githubApp(config);
  if (!app) return null;
  try {
    const { data } = await app.octokit.request("GET /orgs/{org}/installation", {
      org: orgLogin,
    });
    return {
      installationId: data.id,
      githubOrgId: (data.account as { id: number }).id,
    };
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}
