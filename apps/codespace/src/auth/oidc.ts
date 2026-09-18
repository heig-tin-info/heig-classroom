/**
 * Real OIDC login (invariant 4 of CLAUDE.md): authorization code + PKCE,
 * `state`, `nonce`, validation of the identity token by `openid-client`. The
 * IdP is the Keycloak of `infra/compose.dev.yml` in development, Switch edu-ID
 * in production; the code is the same, as in heig-classroom.
 *
 * There is no other authentication path: no "current user" environment
 * variable, no development header.
 */
import * as oidc from "openid-client";

import type { AppConfig } from "./config.js";

/** Portal role. The default role is the least powerful one. */
export type Role = "student" | "teacher";

export interface OidcClaims {
  sub: string;
  /** `preferred_username`: the institutional login, which names the volume. */
  login: string;
  email: string;
  displayName: string;
  role: Role;
  raw: Record<string, unknown>;
}

/**
 * The role comes from the realm: the `codespace-roles` mapper of the dev realm
 * puts the user's realm roles into the `codespace_roles` claim of the identity
 * token. `realm_access.roles` serves as a fallback for a realm configured
 * otherwise (Keycloak's standard `roles` scope).
 */
export function roleFromClaims(
  claims: Record<string, unknown>,
  claimName: string,
  teacherRole: string,
): Role {
  const direct = claims[claimName];
  const realmAccess = claims["realm_access"];
  const nested =
    typeof realmAccess === "object" && realmAccess !== null
      ? (realmAccess as Record<string, unknown>)["roles"]
      : undefined;
  for (const candidate of [direct, nested]) {
    if (Array.isArray(candidate) && candidate.includes(teacherRole)) return "teacher";
    if (typeof candidate === "string" && candidate === teacherRole) return "teacher";
  }
  return "student";
}

/**
 * `preferred_username` names a volume directory and a staging repository path:
 * it has to pass the `SAFE_ID` of `git/staging.ts`. An IdP that returns
 * something else (a full address, for instance) is normalized here rather than
 * making the session fail at the first `mkdir`.
 */
export function safeLogin(raw: string): string {
  const base = raw.trim().toLowerCase().split("@")[0] ?? "";
  const cleaned = base.replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "");
  if (cleaned.length === 0) throw new Error(`Unusable user login: ${raw}`);
  return cleaned.slice(0, 64);
}

export class OidcProvider {
  private config: oidc.Configuration | null = null;

  constructor(
    private readonly app: AppConfig,
    private readonly log?: { warn: (obj: unknown, msg: string) => void },
  ) {}

  /** Lazy discovery: an IdP unreachable at startup must not prevent the
   *  portal (and `/healthz`) from starting. */
  private async configuration(): Promise<oidc.Configuration> {
    if (this.config) return this.config;
    // The development Keycloak is served in the clear; in production the
    // issuer is over HTTPS and this exemption is not granted.
    const execute = this.app.NODE_ENV === "production" ? [] : [oidc.allowInsecureRequests];
    this.config = await oidc.discovery(
      new URL(this.app.OIDC_ISSUER),
      this.app.OIDC_CLIENT_ID,
      undefined,
      oidc.ClientSecretPost(this.app.OIDC_CLIENT_SECRET),
      { execute },
    );
    return this.config;
  }

  get redirectUri(): string {
    return new URL("/auth/callback", this.app.PUBLIC_URL).href;
  }

  async beginLogin(): Promise<{
    url: string;
    codeVerifier: string;
    state: string;
    nonce: string;
  }> {
    const config = await this.configuration();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri,
      scope: "openid profile email",
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
    const idClaims = tokens.claims();
    if (!idClaims) throw new Error("Identity token without claims");
    // `userinfo` completes, without ever being able to refuse a session that
    // the identity token is enough to establish.
    let userinfo: Record<string, unknown> = {};
    try {
      userinfo = (await oidc.fetchUserInfo(
        config,
        tokens.access_token,
        idClaims.sub,
      )) as unknown as Record<string, unknown>;
    } catch (err) {
      this.log?.warn({ err }, "OIDC userinfo unavailable, sticking to the identity token");
    }
    // The identity token wins: it is signed and bound to the `nonce`.
    const claims: Record<string, unknown> = { ...userinfo, ...idClaims };
    const preferred =
      typeof claims["preferred_username"] === "string"
        ? claims["preferred_username"]
        : typeof claims["email"] === "string"
          ? claims["email"]
          : idClaims.sub;
    const email = typeof claims["email"] === "string" ? claims["email"].toLowerCase() : "";
    const given = typeof claims["given_name"] === "string" ? claims["given_name"] : "";
    const family = typeof claims["family_name"] === "string" ? claims["family_name"] : "";
    const name = typeof claims["name"] === "string" ? claims["name"] : "";
    return {
      sub: idClaims.sub,
      login: safeLogin(preferred),
      email,
      displayName: name || `${given} ${family}`.trim() || preferred,
      role: roleFromClaims(claims, this.app.OIDC_ROLES_CLAIM, this.app.OIDC_TEACHER_ROLE),
      raw: claims,
    };
  }
}
