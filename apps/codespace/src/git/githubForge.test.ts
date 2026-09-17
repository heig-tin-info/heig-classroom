/**
 * La forge GitHub par App : résolution de l'installation **par organisation**,
 * cache du jeton, renouvellement avant expiration, et refus nommé quand l'App
 * n'est pas installée.
 *
 * Octokit est remplacé par `GithubAppApi` : ce qui est vérifié ici est la
 * logique du portail, pas la bibliothèque. Le branchement réel est éprouvé sur
 * la VM (docs/deploy.md § 5).
 */
import { describe, expect, it } from "vitest";

import {
  createGithubForge,
  createUnconfiguredGithubForge,
  ForgeUnconfiguredError,
  INSTALLATION_TOKEN_TTL_MS,
  type GithubAppApi,
} from "./forge.js";

interface Spy extends GithubAppApi {
  orgCalls: string[];
  tokenCalls: number[];
}

/** Ce que github.com attend du transport git : `Basic x-access-token:<jeton>`. */
const basic = (token: string): string =>
  `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

function fakeApi(
  installations: Record<string, number>,
  tokenAt: (n: number) => { token: string; expiresAt: number },
): Spy {
  const spy: Spy = {
    orgCalls: [],
    tokenCalls: [],
    async installationIdFor(org) {
      spy.orgCalls.push(org);
      return installations[org] ?? null;
    },
    async installationToken(installationId) {
      spy.tokenCalls.push(installationId);
      return tokenAt(spy.tokenCalls.length);
    },
  };
  return spy;
}

describe("createGithubForge", () => {
  it("résout l'installation par l'organisation du dépôt, et met le jeton en cache", async () => {
    let now = 1_000_000;
    const api = fakeApi({ "heig-test-classroom2": 77 }, (n) => ({
      token: `ghs_jeton${n}`,
      expiresAt: now + INSTALLATION_TOKEN_TTL_MS,
    }));
    const forge = createGithubForge({
      appId: "4284518",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\nfaux\n-----END RSA PRIVATE KEY-----\n",
      api,
      now: () => now,
    });
    const repo = { owner: "heig-test-classroom2", name: "labo-02-quadratic-yves-chevallier" };

    expect(await forge.authorization(repo)).toBe(basic("ghs_jeton1"));
    // Deuxième appel une minute plus tard : ni installation, ni jeton neufs.
    now += 60_000;
    expect(await forge.authorization(repo)).toBe(basic("ghs_jeton1"));
    expect(api.orgCalls).toEqual(["heig-test-classroom2"]);
    expect(api.tokenCalls).toEqual([77]);
    // L'URL de clonage ne porte jamais le jeton (invariant du module).
    expect(forge.pushUrl(repo)).toBe(
      "https://github.com/heig-test-classroom2/labo-02-quadratic-yves-chevallier.git",
    );
  });

  it("renouvelle le jeton une minute avant son expiration, jamais après", async () => {
    let now = 0;
    const api = fakeApi({ org: 12 }, (n) => ({
      token: `ghs_${n}`,
      expiresAt: now + INSTALLATION_TOKEN_TTL_MS,
    }));
    const forge = createGithubForge({ appId: 1, privateKey: "pem", api, now: () => now });
    const repo = { owner: "org", name: "depot" };

    expect(await forge.authorization(repo)).toBe(basic("ghs_1"));
    // 59 minutes : le jeton vaut encore, il reste plus d'une minute.
    now = INSTALLATION_TOKEN_TTL_MS - 61_000;
    expect(await forge.authorization(repo)).toBe(basic("ghs_1"));
    expect(api.tokenCalls).toEqual([12]);
    // Moins d'une minute avant l'expiration : un push commencé ne doit pas
    // survivre à son jeton.
    now = INSTALLATION_TOKEN_TTL_MS - 59_000;
    expect(await forge.authorization(repo)).toBe(basic("ghs_2"));
    expect(api.tokenCalls).toEqual([12, 12]);
  });

  it("un jeton par organisation : deux classes, deux installations", async () => {
    const api = fakeApi({ "org-a": 1, "org-b": 2 }, (n) => ({
      token: `ghs_${n}`,
      expiresAt: Date.now() + INSTALLATION_TOKEN_TTL_MS,
    }));
    const forge = createGithubForge({ appId: 1, privateKey: "pem", api });

    expect(await forge.authorization({ owner: "org-a", name: "d" })).toBe(basic("ghs_1"));
    expect(await forge.authorization({ owner: "org-b", name: "d" })).toBe(basic("ghs_2"));
    expect(await forge.authorization({ owner: "org-a", name: "autre" })).toBe(basic("ghs_1"));
    expect(api.orgCalls).toEqual(["org-a", "org-b"]);
    expect(api.tokenCalls).toEqual([1, 2]);
  });

  it("App non installée sur l'organisation : erreur de configuration, pas de panne", async () => {
    const api = fakeApi({}, () => ({ token: "x", expiresAt: 0 }));
    const forge = createGithubForge({ appId: 1, privateKey: "pem", api });
    await expect(forge.authorization({ owner: "inconnue", name: "d" })).rejects.toBeInstanceOf(
      ForgeUnconfiguredError,
    );
    // Le message nomme l'organisation : c'est ce que l'exploitant doit lire.
    await expect(forge.authorization({ owner: "inconnue", name: "d" })).rejects.toThrow(/inconnue/);
  });
});

describe("createUnconfiguredGithubForge", () => {
  it("sert l'URL publique et refuse toute autorisation, sans appel réseau", async () => {
    const forge = createUnconfiguredGithubForge();
    expect(forge.pushUrl({ owner: "o", name: "d" })).toBe("https://github.com/o/d.git");
    await expect(forge.authorization({ owner: "o", name: "d" })).rejects.toBeInstanceOf(
      ForgeUnconfiguredError,
    );
    await expect(forge.authorization({ owner: "o", name: "d" })).rejects.toThrow(
      /GITHUB_APP_PRIVATE_KEY_PATH/,
    );
  });
});
