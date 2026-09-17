/**
 * JWT compact HS256, sans dépendance : Web Crypto (Node ≥ 20, navigateurs).
 * Sert aux jetons de lancement et de service entre classroom et le portail
 * (packages/contracts/src/codespace.ts). Volontairement minimal : un seul
 * algorithme, pas de négociation d'en-tête, vérification stricte de `alg`.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function signHs256(claims: Record<string, unknown>, secret: string): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  const input = `${header}.${payload}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), enc.encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

export interface VerifyHs256Options {
  /** `aud` attendu ; refus si absent ou différent. */
  audience: string;
  /** `iss` attendu ; refus si absent ou différent. */
  issuer?: string;
  /** Horloge injectable (secondes Unix). */
  now?: () => number;
  /** Tolérance en secondes sur `exp` et `iat`. */
  skewSeconds?: number;
}

export type VerifyHs256Result<T> =
  | { ok: true; claims: T }
  | { ok: false; reason: "malformed" | "bad-alg" | "bad-signature" | "expired" | "not-yet-valid" | "bad-audience" | "bad-issuer" };

export async function verifyHs256<T extends Record<string, unknown>>(
  token: string,
  secret: string,
  opts: VerifyHs256Options,
): Promise<VerifyHs256Result<T>> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: unknown };
  let claims: T;
  try {
    header = JSON.parse(dec.decode(unb64url(h))) as { alg?: unknown };
    claims = JSON.parse(dec.decode(unb64url(p))) as T;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "HS256") return { ok: false, reason: "bad-alg" };
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    unb64url(s),
    enc.encode(`${h}.${p}`),
  );
  if (!valid) return { ok: false, reason: "bad-signature" };
  const now = opts.now?.() ?? Math.floor(Date.now() / 1000);
  const skew = opts.skewSeconds ?? 30;
  const exp = claims["exp"];
  const iat = claims["iat"];
  if (typeof exp !== "number" || exp + skew < now) return { ok: false, reason: "expired" };
  if (typeof iat === "number" && iat - skew > now) return { ok: false, reason: "not-yet-valid" };
  if (claims["aud"] !== opts.audience) return { ok: false, reason: "bad-audience" };
  if (opts.issuer !== undefined && claims["iss"] !== opts.issuer) return { ok: false, reason: "bad-issuer" };
  return { ok: true, claims };
}
