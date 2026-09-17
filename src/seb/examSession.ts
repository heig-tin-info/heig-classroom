/**
 * Cookie d'examen : la seule preuve que le proxy vers code-server accepte.
 *
 * Invariant 5 de CLAUDE.md : « Le proxy vers code-server ne lit jamais d'en-tête
 * SEB. Il ne connaît que le cookie de session lié à l'adresse client. La
 * vérification SEB se fait une fois, sur la route de démarrage d'examen. »
 * D'où ce module : la vérification SEB de verify.ts produit un jeton signé,
 * et `verifyExamCookie` est la seule chose que le proxy appellera.
 *
 * Motivation, analyse.md § 4.5 : rien ne garantit que SEB ajoute ses en-têtes
 * aux mises à niveau websocket ni aux requêtes de service worker ; un proxy qui
 * les exigerait casserait l'éditeur. Et analyse.md D5 : en mode examen, une
 * requête venue d'une adresse différente de celle de la vérification initiale
 * est refusée.
 *
 * Le jeton est autoporteur et signé (HMAC-SHA256), pas opaque : le proxy le
 * valide sans toucher la base à chaque trame websocket. Il ne contient aucun
 * secret — surtout pas un BEK — et n'est pas chiffré ; tout ce qu'il porte est
 * déjà connu du client.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const EXAM_COOKIE = "exam_session";

/** Ce que le cookie transporte. Aucune de ces valeurs n'est un secret. */
export interface ExamClaims {
  readonly assignmentId: string;
  readonly sessionId: string;
  /** Adresse du client au moment de la vérification SEB. */
  readonly clientAddress: string;
  /** Instant d'émission, en millisecondes depuis l'époque. */
  readonly issuedAt: number;
}

export type ExamCookieRefusal =
  | "missing"
  | "malformed"
  | "bad-signature"
  | "expired"
  | "address-mismatch"
  | "assignment-mismatch";

export type ExamCookieVerdict =
  | { readonly ok: true; readonly claims: ExamClaims }
  | { readonly ok: false; readonly reason: ExamCookieRefusal };

export interface ExamCookieOptions {
  readonly secret: string;
  /** Durée de validité. Par défaut quatre heures, la durée d'une séance. */
  readonly maxAgeMs?: number;
}

const DEFAULT_MAX_AGE_MS = 4 * 60 * 60 * 1000;

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

/**
 * Émet le jeton. Format : `<payload en base64url>.<HMAC en base64url>`, sans
 * caractère à échapper dans un cookie.
 */
export function issueExamCookie(claims: ExamClaims, options: ExamCookieOptions): string {
  if (options.secret.length < 16) {
    throw new Error("Le secret de signature du cookie d'examen est trop court");
  }
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(payload, options.secret)}`;
}

function signaturesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function parseClaims(json: string): ExamClaims | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Record<string, unknown>;
  if (
    typeof c["assignmentId"] !== "string" ||
    typeof c["sessionId"] !== "string" ||
    typeof c["clientAddress"] !== "string" ||
    typeof c["issuedAt"] !== "number" ||
    !Number.isFinite(c["issuedAt"])
  ) {
    return null;
  }
  return {
    assignmentId: c["assignmentId"],
    sessionId: c["sessionId"],
    clientAddress: c["clientAddress"],
    issuedAt: c["issuedAt"],
  };
}

export interface ExamCookieCheck extends ExamCookieOptions {
  /** Adresse de la requête courante ; doit être celle de la vérification SEB. */
  readonly clientAddress: string;
  /** Si fourni, le cookie doit porter ce devoir. */
  readonly assignmentId?: string;
  readonly now?: number;
}

/**
 * Vérifie le jeton. C'est la fonction que le proxy `/s/<session>/*` appellera :
 * cookie valide **et** adresse client identique, sinon refus explicite avec
 * une raison.
 */
export function verifyExamCookie(
  cookie: string | undefined,
  check: ExamCookieCheck,
): ExamCookieVerdict {
  if (cookie === undefined || cookie === "") return { ok: false, reason: "missing" };
  const dot = cookie.indexOf(".");
  if (dot <= 0 || dot === cookie.length - 1) return { ok: false, reason: "malformed" };
  const payload = cookie.slice(0, dot);
  const signature = cookie.slice(dot + 1);
  // Signature d'abord : le contenu n'est digne d'être lu qu'une fois authentifié.
  if (!signaturesEqual(sign(payload, check.secret), signature)) {
    return { ok: false, reason: "bad-signature" };
  }
  const claims = parseClaims(Buffer.from(payload, "base64url").toString("utf8"));
  if (claims === null) return { ok: false, reason: "malformed" };

  const now = check.now ?? Date.now();
  const maxAge = check.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (now - claims.issuedAt >= maxAge || now < claims.issuedAt) {
    return { ok: false, reason: "expired" };
  }
  if (check.assignmentId !== undefined && claims.assignmentId !== check.assignmentId) {
    return { ok: false, reason: "assignment-mismatch" };
  }
  // analyse.md D5 : même session, mais provenance vérifiée.
  if (claims.clientAddress !== check.clientAddress) {
    return { ok: false, reason: "address-mismatch" };
  }
  return { ok: true, claims };
}

/** Attributs du cookie posés sur la réponse, factorisés pour le proxy et la route. */
export function examCookieAttributes(options: {
  readonly secure: boolean;
  readonly maxAgeMs?: number;
}): {
  path: string;
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  maxAge: number;
} {
  return {
    path: "/",
    httpOnly: true,
    // `lax` et non `strict` : SEB arrive sur la route de démarrage par une
    // navigation de premier niveau depuis le fichier de configuration.
    sameSite: "lax",
    secure: options.secure,
    maxAge: Math.floor((options.maxAgeMs ?? DEFAULT_MAX_AGE_MS) / 1000),
  };
}

export const EXAM_COOKIE_DEFAULT_MAX_AGE_MS = DEFAULT_MAX_AGE_MS;
