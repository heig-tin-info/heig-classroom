/**
 * Client GitHub App (GH-01..03) : authentification par JWT signé avec la clé
 * privée PEM, résolution des installations par organisation. Initialisation
 * paresseuse — l'App non configurée ne bloque ni le boot ni /healthz.
 */
import { existsSync, readFileSync } from "node:fs";

import { App } from "octokit";

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

/** GET /orgs/{org}/installation — null si l'App n'y est pas installée. */
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
