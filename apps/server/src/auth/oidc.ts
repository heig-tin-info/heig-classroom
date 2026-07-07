/**
 * Login plateforme OIDC (AU-01..05) : Authorization Code + PKCE avec `state`
 * et `nonce`, via openid-client (certifié). L'IdP est Switch edu-ID en
 * production, Keycloak local en développement — le code est identique.
 */
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";

import * as oidc from "openid-client";

import type { AppConfig } from "../config.js";

export interface OidcClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  givenName: string;
  familyName: string;
  swissEduId: string | null;
  /** Claim OIDC `picture` (URL), si l'IdP la fournit. */
  picture: string | null;
}

export class OidcProvider {
  private config: oidc.Configuration | null = null;

  constructor(private readonly app: AppConfig) {}

  /** Découverte paresseuse et mise en cache : un IdP injoignable au boot ne
   *  doit pas empêcher le serveur (et /healthz) de démarrer. */
  private async configuration(): Promise<oidc.Configuration> {
    if (this.config) return this.config;
    const execute =
      this.app.NODE_ENV === "production" ? [] : [oidc.allowInsecureRequests];
    // `private_key_jwt` (SWITCH edu-ID) quand une clé est fournie, sinon
    // client_secret (Keycloak de dev) — même flux dans les deux cas.
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
    // AU-09/NFR-02 : les tokens ne sont ni persistés ni retournés — seules les
    // claims d'identité sortent d'ici.
    const idClaims = tokens.claims();
    if (!idClaims) throw new Error("ID token sans claims");
    // Selon la configuration de l'IdP (edu-ID notamment), les attributs
    // peuvent n'être délivrés que par l'endpoint userinfo : repli si l'ID
    // token ne porte pas l'e-mail.
    let claims: Record<string, unknown> = idClaims;
    if (typeof claims.email !== "string") {
      const userinfo = await oidc.fetchUserInfo(config, tokens.access_token, idClaims.sub);
      claims = { ...userinfo, ...idClaims, email: userinfo.email, email_verified: userinfo.email_verified, given_name: userinfo.given_name, family_name: userinfo.family_name };
    }
    const email = typeof claims.email === "string" ? claims.email : "";
    if (!email) throw new Error("Claim email absente (ID token et userinfo)");
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
    };
  }
}
