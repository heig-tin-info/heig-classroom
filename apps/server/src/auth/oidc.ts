/**
 * Platform OIDC login (AU-01..05): Authorization Code + PKCE with `state`
 * and `nonce`, via openid-client (certified). The IdP is Switch edu-ID in
 * production, a local Keycloak in development; the code is identical.
 */
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";

import * as oidc from "openid-client";

import type { AppConfig } from "../config.js";

/**
 * Switch edu-ID publishes ALL of its attributes behind this single scope —
 * the e-mail addresses of the institutional affiliations in particular
 * (GH-11) — and the older `.../authz/User.Read` is deprecated. Asking for an
 * unknown scope makes an IdP answer `invalid_scope`, so it is only added
 * when the issuer is edu-ID itself; the dev Keycloak keeps the plain set.
 */
const EDUID_SCOPE = "https://eduid.ch/scope/userinfo.read";

/** Scope string for an issuer. Exported for the tests. */
export function scopeFor(issuer: string): string {
  const base = "openid profile email";
  let host: string;
  try {
    host = new URL(issuer).hostname;
  } catch {
    return base;
  }
  return host === "eduid.ch" || host.endsWith(".eduid.ch") ? `${base} ${EDUID_SCOPE}` : base;
}

export interface OidcClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  givenName: string;
  familyName: string;
  swissEduId: string | null;
  /** OIDC `picture` claim (URL), if the IdP provides it. */
  picture: string | null;
  /** Everything the IdP released, ID token and userinfo merged (GH-11). */
  raw: Record<string, unknown>;
}

export class OidcProvider {
  private config: oidc.Configuration | null = null;

  constructor(
    private readonly app: AppConfig,
    private readonly log?: { warn: (obj: unknown, msg: string) => void },
  ) {}

  /** Lazy discovery with caching: an IdP unreachable at boot must not
   *  prevent the server (and /healthz) from starting. */
  private async configuration(): Promise<oidc.Configuration> {
    if (this.config) return this.config;
    const execute =
      this.app.NODE_ENV === "production" ? [] : [oidc.allowInsecureRequests];
    // `private_key_jwt` (SWITCH edu-ID) when a key is provided, otherwise
    // client_secret (dev Keycloak); the flow is the same in both cases.
    let clientAuth: oidc.ClientAuth;
    if (this.app.OIDC_PRIVATE_KEY_PATH) {
      const der = createPrivateKey(readFileSync(this.app.OIDC_PRIVATE_KEY_PATH)).export({
        type: "pkcs8",
        format: "der",
      });
      const key = await crypto.subtle.importKey(
        "pkcs8",
        der,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
      clientAuth = oidc.PrivateKeyJwt({ key, kid: this.app.OIDC_PRIVATE_KEY_KID });
    } else {
      clientAuth = oidc.ClientSecretBasic(this.app.OIDC_CLIENT_SECRET);
    }
    this.config = await oidc.discovery(
      new URL(this.app.OIDC_ISSUER),
      this.app.OIDC_CLIENT_ID,
      undefined,
      clientAuth,
      { execute },
    );
    return this.config;
  }

  get redirectUri(): string {
    return new URL("/app/auth/callback", this.app.PUBLIC_URL).href;
  }

  async beginLogin() {
    const config = await this.configuration();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri,
      scope: scopeFor(this.app.OIDC_ISSUER),
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return { url: url.href, codeVerifier, state, nonce };
  }

  async completeLogin(
    callbackUrl: URL,
    stash: { codeVerifier: string; state: string; nonce: string },
  ): Promise<OidcClaims> {
    const config = await this.configuration();
    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: stash.codeVerifier,
      expectedState: stash.state,
      expectedNonce: stash.nonce,
    });
    // AU-09/NFR-02: the tokens are neither persisted nor returned; only the
    // identity claims leave this function.
    const idClaims = tokens.claims();
    if (!idClaims) throw new Error("ID token has no claims");
    // edu-ID releases its claims on the userinfo endpoint by DEFAULT (only
    // the ID token content is configurable in the Resource Registry), so
    // userinfo is queried on every login instead of only as a fallback
    // (GH-11). A failure there must not deny a session the ID token is
    // otherwise enough for: the extra attributes are a bonus, the login is
    // not.
    let userinfo: Record<string, unknown> = {};
    try {
      userinfo = (await oidc.fetchUserInfo(
        config,
        tokens.access_token,
        idClaims.sub,
      )) as unknown as Record<string, unknown>;
    } catch (err) {
      this.log?.warn({ err }, "OIDC userinfo unavailable, falling back to the ID token");
    }
    // The ID token wins on the claims it carries (it is signed and bound to
    // the nonce); userinfo fills in the rest.
    const claims: Record<string, unknown> = { ...userinfo, ...idClaims };
    const email = typeof claims.email === "string" ? claims.email : "";
    if (!email) throw new Error("No email claim (neither in the ID token nor in userinfo)");
    return {
      sub: idClaims.sub,
      email: email.trim().toLowerCase(),
      emailVerified: claims.email_verified === true,
      givenName: typeof claims.given_name === "string" ? claims.given_name : "",
      familyName: typeof claims.family_name === "string" ? claims.family_name : "",
      swissEduId:
        typeof claims.swissEduPersonUniqueID === "string"
          ? claims.swissEduPersonUniqueID
          : null,
      picture: typeof claims.picture === "string" ? claims.picture : null,
      raw: claims,
    };
  }
}
