/**
 * The GitHub forge through an App: resolving the installation **per
 * organisation**, caching the token, renewing it before it expires, and a
 * named refusal when the App is not installed.
 *
 * Octokit is replaced by `GithubAppApi`: what is checked here is the portal's
 * logic, not the library. The real wiring is exercised on the VM
 * (docs/deploy.md § 5).
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

/** What github.com expects from the git transport: `Basic x-access-token:<token>`. */
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
  it("resolves the installation from the repository organisation, and caches the token", async () => {
    let now = 1_000_000;
    const api = fakeApi({ "heig-test-classroom2": 77 }, (n) => ({
      token: `ghs_token${n}`,
      expiresAt: now + INSTALLATION_TOKEN_TTL_MS,
    }));
    const forge = createGithubForge({
      appId: "4284518",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
      api,
      now: () => now,
    });
    const repo = { owner: "heig-test-classroom2", name: "labo-02-quadratic-yves-chevallier" };

    expect(await forge.authorization(repo)).toBe(basic("ghs_token1"));
    // Second call one minute later: neither a fresh installation nor a fresh token.
    now += 60_000;
    expect(await forge.authorization(repo)).toBe(basic("ghs_token1"));
    expect(api.orgCalls).toEqual(["heig-test-classroom2"]);
    expect(api.tokenCalls).toEqual([77]);
    // The clone URL never carries the token (invariant of the module).
    expect(forge.pushUrl(repo)).toBe(
      "https://github.com/heig-test-classroom2/labo-02-quadratic-yves-chevallier.git",
    );
  });

  it("renews the token one minute before it expires, never after", async () => {
    let now = 0;
    const api = fakeApi({ org: 12 }, (n) => ({
      token: `ghs_${n}`,
      expiresAt: now + INSTALLATION_TOKEN_TTL_MS,
    }));
    const forge = createGithubForge({ appId: 1, privateKey: "pem", api, now: () => now });
    const repo = { owner: "org", name: "repo" };

    expect(await forge.authorization(repo)).toBe(basic("ghs_1"));
    // 59 minutes: the token is still valid, more than a minute is left.
    now = INSTALLATION_TOKEN_TTL_MS - 61_000;
    expect(await forge.authorization(repo)).toBe(basic("ghs_1"));
    expect(api.tokenCalls).toEqual([12]);
    // Less than a minute before expiry: a push that has started must not
    // outlive its token.
    now = INSTALLATION_TOKEN_TTL_MS - 59_000;
    expect(await forge.authorization(repo)).toBe(basic("ghs_2"));
    expect(api.tokenCalls).toEqual([12, 12]);
  });

  it("one token per organisation: two classes, two installations", async () => {
    const api = fakeApi({ "org-a": 1, "org-b": 2 }, (n) => ({
      token: `ghs_${n}`,
      expiresAt: Date.now() + INSTALLATION_TOKEN_TTL_MS,
    }));
    const forge = createGithubForge({ appId: 1, privateKey: "pem", api });

    expect(await forge.authorization({ owner: "org-a", name: "d" })).toBe(basic("ghs_1"));
    expect(await forge.authorization({ owner: "org-b", name: "d" })).toBe(basic("ghs_2"));
    expect(await forge.authorization({ owner: "org-a", name: "other" })).toBe(basic("ghs_1"));
    expect(api.orgCalls).toEqual(["org-a", "org-b"]);
    expect(api.tokenCalls).toEqual([1, 2]);
  });

  it("App not installed on the organisation: a configuration error, not an outage", async () => {
    const api = fakeApi({}, () => ({ token: "x", expiresAt: 0 }));
    const forge = createGithubForge({ appId: 1, privateKey: "pem", api });
    await expect(forge.authorization({ owner: "unknown-org", name: "d" })).rejects.toBeInstanceOf(
      ForgeUnconfiguredError,
    );
    // The message names the organisation: that is what the operator has to read.
    await expect(forge.authorization({ owner: "unknown-org", name: "d" })).rejects.toThrow(
      /unknown-org/,
    );
  });
});

describe("createUnconfiguredGithubForge", () => {
  it("serves the public URL and refuses any authorization, with no network call", async () => {
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
