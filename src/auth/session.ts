/**
 * Session de connexion au portail : jeton autoporteur signé en HMAC-SHA256,
 * pas de table.
 *
 * Choix assumé, et c'est pourquoi le cadrage compte quatre entités et non
 * cinq : ce que porte le cookie (identifiant interne, identifiant
 * institutionnel, rôle, échéance) est déjà connu du navigateur, et la
 * révocation immédiate d'une connexion n'est pas une exigence de v0. La
 * session *de codespace*, elle, est bien une ligne en base (`sessions`),
 * parce qu'elle a un conteneur, un volume et un cycle de vie.
 *
 * Le format est celui de `seb/examSession.ts`, volontairement : un seul
 * format de jeton signé à relire dans tout le portail.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { Role } from "./oidc.js";

export const AUTH_COOKIE = "cs_auth";

export interface AuthClaims {
  readonly userId: string;
  readonly login: string;
  readonly role: Role;
  /** Échéance en millisecondes depuis l'époque. */
  readonly expiresAt: number;
}

export type AuthRefusal = "missing" | "malformed" | "bad-signature" | "expired";

export type AuthVerdict =
  | { readonly ok: true; readonly claims: AuthClaims }
  | { readonly ok: false; readonly reason: AuthRefusal };

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function issueAuthCookie(claims: AuthClaims, secret: string): string {
  if (secret.length < 16) throw new Error("COOKIE_SECRET trop court");
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyAuthCookie(
  cookie: string | undefined,
  secret: string,
  now: number = Date.now(),
): AuthVerdict {
  if (cookie === undefined || cookie === "") return { ok: false, reason: "missing" };
  const dot = cookie.indexOf(".");
  if (dot <= 0 || dot === cookie.length - 1) return { ok: false, reason: "malformed" };
  const payload = cookie.slice(0, dot);
  if (!equal(sign(payload, secret), cookie.slice(dot + 1))) {
    return { ok: false, reason: "bad-signature" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "malformed" };
  const c = parsed as Record<string, unknown>;
  if (
    typeof c["userId"] !== "string" ||
    typeof c["login"] !== "string" ||
    (c["role"] !== "student" && c["role"] !== "teacher") ||
    typeof c["expiresAt"] !== "number" ||
    !Number.isFinite(c["expiresAt"])
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (c["expiresAt"] <= now) return { ok: false, reason: "expired" };
  return {
    ok: true,
    claims: {
      userId: c["userId"],
      login: c["login"],
      role: c["role"],
      expiresAt: c["expiresAt"],
    },
  };
}
