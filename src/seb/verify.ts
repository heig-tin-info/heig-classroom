/**
 * Vérification de la provenance SEB, sur la seule route de démarrage d'examen.
 *
 * Deux implémentations derrière une interface : `real`, qui contrôle les deux
 * en-têtes que SEB ajoute quand l'option « Use Browser & Config Keys » est
 * active, et `simulated`, qui accepte un en-tête de développement et que
 * `createSebVerifier` refuse de construire en production (invariant 8).
 *
 * Références :
 *   [SPEC-CK] https://safeexambrowser.org/developer/seb-config-key.html
 *             « the LMS creates a SHA256 hash value from the absolute URL
 *             without Fragment part with appended Config Key hash string »
 *   [SPEC-IN] https://safeexambrowser.org/developer/seb-integration.html
 *             (Browser Exam Key, un BEK par plateforme et par version)
 *   [AM]      mod/quiz/accessrule/seb/classes/seb_access_manager.php
 *             `check_key()` : `hash('sha256', $url . $validkey) === $key`
 *             `check_browser_exam_keys()` : boucle sur la liste des BEK
 *             https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/classes/seb_access_manager.php
 *
 * Invariant 5 de CLAUDE.md : rien d'autre que cette route ne lit un en-tête
 * SEB. Le proxy vers code-server ne connaît que le cookie d'examSession.ts.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const CONFIG_KEY_HEADER = "x-safeexambrowser-configkeyhash";
export const REQUEST_HASH_HEADER = "x-safeexambrowser-requesthash";
export const DEV_HEADER = "x-dev-seb";

/** Ce que le vérificateur a besoin de savoir d'une requête HTTP. */
export interface SebRequestFacts {
  /** Chemin et query tels que reçus, par exemple `/exam/a1/start?x=1`. */
  readonly url: string;
  /** En-têtes en minuscules, comme Fastify et Node les exposent. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** Les clés d'un devoir. `beks` est une liste : cf. analyse.md § 4.4. */
export interface AssignmentSebKeys {
  readonly configKey: string;
  /** Un Browser Exam Key par couple (plateforme, version) du parc. */
  readonly beks: readonly string[];
}

export type SebRefusal =
  | "url-unreconstructible"
  | "missing-config-key-header"
  | "missing-request-hash-header"
  | "config-key-mismatch"
  | "browser-exam-key-mismatch"
  | "no-browser-exam-key-configured"
  | "missing-dev-header";

export type SebVerdict =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: SebRefusal; readonly url: string | null };

export interface SebVerifier {
  readonly mode: "real" | "simulated";
  verifyStart(req: SebRequestFacts, keys: AssignmentSebKeys): SebVerdict;
}

// --- Reconstruction de l'URL absolue ---------------------------------------

/**
 * SEB hache l'URL **absolue que le navigateur a demandée**, sans fragment.
 * Derrière un frontal TLS, Node ne voit que le chemin et un `Host` qui peut
 * être celui du frontal comme celui du backend ; il faut donc reconstruire.
 *
 * - `publicOrigin` : origine fixe (`https://codespace.heig-vd.ch`). C'est le
 *   réglage sûr en production : rien de ce que le client envoie n'entre dans
 *   le calcul, donc rien n'est manipulable.
 * - `trustForwarded` : lire `X-Forwarded-Proto` et `X-Forwarded-Host`. À
 *   n'activer que si le frontal les réécrit systématiquement, sinon un client
 *   choisit l'origine à la place du portail.
 * - sinon : `Host` et le protocole par défaut.
 */
export interface RequestUrlOptions {
  readonly publicOrigin?: string;
  readonly trustForwarded?: boolean;
  readonly defaultProtocol?: "http" | "https";
}

function firstHeader(
  headers: SebRequestFacts["headers"],
  name: string,
): string | undefined {
  const raw = headers[name];
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Le fragment n'est jamais transmis par un navigateur ; on le retire quand
 * même, pour que la valeur hachée reste celle de la spécification si un
 * client exotique en envoie un.
 */
function stripFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
}

/** Reconstruit l'URL absolue sans fragment, ou `null` si c'est impossible. */
export function absoluteRequestUrl(
  req: SebRequestFacts,
  options: RequestUrlOptions = {},
): string | null {
  const target = stripFragment(req.url);
  if (options.publicOrigin !== undefined && options.publicOrigin !== "") {
    return new URL(target, options.publicOrigin).toString();
  }
  const forwardedHost = options.trustForwarded === true
    ? firstHeader(req.headers, "x-forwarded-host")
    : undefined;
  const host = forwardedHost ?? firstHeader(req.headers, "host");
  if (host === undefined) return null;
  const forwardedProto = options.trustForwarded === true
    ? firstHeader(req.headers, "x-forwarded-proto")
    : undefined;
  // « https, http » quand plusieurs frontaux se sont ajoutés : le premier est
  // celui qui a parlé au client.
  const proto = (forwardedProto?.split(",")[0]?.trim() ?? options.defaultProtocol ?? "https");
  if (proto !== "http" && proto !== "https") return null;
  try {
    return new URL(target, `${proto}://${host}`).toString();
  } catch {
    return null;
  }
}

// --- Comparaisons ----------------------------------------------------------

/** Comparaison à temps constant de deux hachés hexadécimaux. */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a.trim().toLowerCase(), "utf8");
  const right = Buffer.from(b.trim().toLowerCase(), "utf8");
  // `timingSafeEqual` exige des longueurs égales, et comparer les longueurs
  // d'abord court-circuiterait. On compare les condensés, toujours de 32
  // octets : durée constante, et l'égalité des condensés vaut celle des
  // chaînes.
  const la = createHash("sha256").update(left).digest();
  const lb = createHash("sha256").update(right).digest();
  return timingSafeEqual(la, lb);
}

/** `sha256(url + clé)`, la formule de [AM:check_key]. */
export function expectedHash(url: string, key: string): string {
  return createHash("sha256").update(`${url}${key}`, "utf8").digest("hex");
}

// --- Implémentations -------------------------------------------------------

class RealSebVerifier implements SebVerifier {
  readonly mode = "real" as const;
  constructor(private readonly urlOptions: RequestUrlOptions) {}

  verifyStart(req: SebRequestFacts, keys: AssignmentSebKeys): SebVerdict {
    const url = absoluteRequestUrl(req, this.urlOptions);
    if (url === null) return { ok: false, reason: "url-unreconstructible", url: null };

    const configKeyHash = firstHeader(req.headers, CONFIG_KEY_HEADER);
    if (configKeyHash === undefined) {
      return { ok: false, reason: "missing-config-key-header", url };
    }
    const requestHash = firstHeader(req.headers, REQUEST_HASH_HEADER);
    if (requestHash === undefined) {
      return { ok: false, reason: "missing-request-hash-header", url };
    }
    if (!hashesEqual(expectedHash(url, keys.configKey), configKeyHash)) {
      return { ok: false, reason: "config-key-mismatch", url };
    }
    if (keys.beks.length === 0) {
      // Contrairement à Moodle, qui laisse passer quand aucun BEK n'est
      // configuré, un devoir en mode examen sans BEK est ici une erreur de
      // configuration : refuser est le comportement sûr.
      return { ok: false, reason: "no-browser-exam-key-configured", url };
    }
    // [AM:check_browser_exam_keys] : au moins un des BEK acceptés. La boucle
    // ne s'interrompt pas au premier succès afin que la durée ne dépende pas
    // de la position du BEK qui a réussi.
    let matched = false;
    for (const bek of keys.beks) {
      if (hashesEqual(expectedHash(url, bek), requestHash)) matched = true;
    }
    if (!matched) return { ok: false, reason: "browser-exam-key-mismatch", url };
    return { ok: true, url };
  }
}

class SimulatedSebVerifier implements SebVerifier {
  readonly mode = "simulated" as const;
  constructor(private readonly urlOptions: RequestUrlOptions) {}

  verifyStart(req: SebRequestFacts, _keys: AssignmentSebKeys): SebVerdict {
    const url = absoluteRequestUrl(req, this.urlOptions);
    if (url === null) return { ok: false, reason: "url-unreconstructible", url: null };
    if (firstHeader(req.headers, DEV_HEADER) !== "ok") {
      return { ok: false, reason: "missing-dev-header", url };
    }
    return { ok: true, url };
  }
}

export interface SebVerifierConfig {
  readonly mode: "real" | "simulated";
  /** Passé explicitement plutôt que lu ici : la configuration se valide au démarrage. */
  readonly nodeEnv: string;
  readonly url?: RequestUrlOptions;
}

export class SebConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SebConfigurationError";
  }
}

/**
 * Invariant 8 de CLAUDE.md : le mode `simulated` est impossible en
 * `NODE_ENV=production`. Le refus est une exception au démarrage, pas un repli
 * silencieux sur `real` : une production mal configurée doit ne pas démarrer.
 */
export function createSebVerifier(config: SebVerifierConfig): SebVerifier {
  if (config.mode === "simulated" && config.nodeEnv === "production") {
    throw new SebConfigurationError(
      "SEB_VERIFIER=simulated est interdit quand NODE_ENV=production",
    );
  }
  const urlOptions = config.url ?? {};
  return config.mode === "real"
    ? new RealSebVerifier(urlOptions)
    : new SimulatedSebVerifier(urlOptions);
}
