/**
 * Connexion OIDC réelle (invariant 4 de CLAUDE.md) : code d'autorisation +
 * PKCE, `state`, `nonce`, validation du jeton d'identité par `openid-client`.
 * L'IdP est le Keycloak de `infra/compose.dev.yml` en développement, Switch
 * edu-ID en production ; le code est le même, comme dans heig-classroom.
 *
 * Il n'existe aucune autre voie d'authentification : ni variable
 * d'environnement « utilisateur courant », ni en-tête de développement.
 */
import * as oidc from "openid-client";

import type { AppConfig } from "./config.js";

/** Rôle du portail. Le rôle par défaut est le moins puissant. */
export type Role = "student" | "teacher";

export interface OidcClaims {
  sub: string;
  /** `preferred_username` : l'identifiant institutionnel, qui nomme le volume. */
  login: string;
  email: string;
  displayName: string;
  role: Role;
  raw: Record<string, unknown>;
}

/**
 * Le rôle vient du realm : le mappeur `codespace-roles` du realm dev place
 * les rôles de realm de l'utilisateur dans la revendication
 * `codespace_roles` du jeton d'identité. `realm_access.roles` sert de repli
 * pour un realm configuré autrement (portée `roles` standard de Keycloak).
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
 * `preferred_username` nomme un répertoire de volume et un chemin de dépôt de
 * transit : il doit passer le `SAFE_ID` de `git/staging.ts`. Un IdP qui
 * renvoie autre chose (une adresse complète, par exemple) est normalisé ici
 * plutôt que de faire échouer la session au premier `mkdir`.
 */
export function safeLogin(raw: string): string {
  const base = raw.trim().toLowerCase().split("@")[0] ?? "";
  const cleaned = base.replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "");
  if (cleaned.length === 0) throw new Error(`Identifiant utilisateur inutilisable : ${raw}`);
  return cleaned.slice(0, 64);
}

export class OidcProvider {
  private config: oidc.Configuration | null = null;

  constructor(
    private readonly app: AppConfig,
    private readonly log?: { warn: (obj: unknown, msg: string) => void },
  ) {}

  /** Découverte paresseuse : un IdP injoignable au démarrage ne doit pas
   *  empêcher le portail (et `/healthz`) de démarrer. */
  private async configuration(): Promise<oidc.Configuration> {
    if (this.config) return this.config;
    // Keycloak de développement est en clair ; en production l'émetteur est
    // en HTTPS et cette dérogation n'est pas posée.
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
    if (!idClaims) throw new Error("Jeton d'identité sans revendications");
    // `userinfo` complète, sans jamais pouvoir refuser une session que le
    // jeton d'identité suffit à établir.
    let userinfo: Record<string, unknown> = {};
    try {
      userinfo = (await oidc.fetchUserInfo(
        config,
        tokens.access_token,
        idClaims.sub,
      )) as unknown as Record<string, unknown>;
    } catch (err) {
      this.log?.warn({ err }, "userinfo OIDC indisponible, on s'en tient au jeton d'identité");
    }
    // Le jeton d'identité l'emporte : il est signé et lié au `nonce`.
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
