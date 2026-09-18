/**
 * Exam cookie: the only proof the proxy to code-server accepts.
 *
 * Invariant 5 of CLAUDE.md: "The proxy to code-server never reads a SEB
 * header. It only knows the session cookie bound to the client address. The
 * SEB verification happens once, on the exam start route." Hence this module:
 * the SEB verification of verify.ts produces a signed token, and
 * `verifyExamCookie` is the only thing the proxy will ever call.
 *
 * Rationale, analyse.md § 4.5: nothing guarantees that SEB adds its headers to
 * websocket upgrades nor to service-worker requests; a proxy that demanded
 * them would break the editor. And analyse.md D5: in exam mode, a request
 * coming from an address other than the one of the initial verification is
 * refused.
 *
 * The token is self-contained and signed (HMAC-SHA256), not opaque: the proxy
 * validates it without touching the database on every websocket frame. It
 * contains no secret — least of all a BEK — and is not encrypted; everything
 * it carries is already known to the client.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const EXAM_COOKIE = "exam_session";

/** What the cookie carries. None of these values is a secret. */
export interface ExamClaims {
  readonly assignmentId: string;
  readonly sessionId: string;
  /** Client address at the time of the SEB verification. */
  readonly clientAddress: string;
  /** Issue time, in milliseconds since the epoch. */
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
  /** Validity window. Four hours by default, the length of a sitting. */
  readonly maxAgeMs?: number;
}

const DEFAULT_MAX_AGE_MS = 4 * 60 * 60 * 1000;

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

/**
 * Issues the token. Format: `<payload in base64url>.<HMAC in base64url>`, with
 * no character that would need escaping in a cookie.
 */
export function issueExamCookie(claims: ExamClaims, options: ExamCookieOptions): string {
  if (options.secret.length < 16) {
    throw new Error("The signing secret of the exam cookie is too short");
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
  /** Address of the current request; must be the one of the SEB verification. */
  readonly clientAddress: string;
  /** If given, the cookie must carry this assignment. */
  readonly assignmentId?: string;
  readonly now?: number;
}

/**
 * Verifies the token. This is the function the `/s/<session>/*` proxy will
 * call: a valid cookie **and** an identical client address, otherwise an
 * explicit refusal with a reason.
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
  // Signature first: the content is only worth reading once authenticated.
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
  // analyse.md D5: same session, but with the origin verified.
  if (claims.clientAddress !== check.clientAddress) {
    return { ok: false, reason: "address-mismatch" };
  }
  return { ok: true, claims };
}

/** Cookie attributes set on the response, factored out for the proxy and the route. */
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
    // `lax` and not `strict`: SEB reaches the start route through a top-level
    // navigation from the configuration file.
    sameSite: "lax",
    secure: options.secure,
    maxAge: Math.floor((options.maxAgeMs ?? DEFAULT_MAX_AGE_MS) / 1000),
  };
}

export const EXAM_COOKIE_DEFAULT_MAX_AGE_MS = DEFAULT_MAX_AGE_MS;
