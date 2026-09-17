/**
 * Config Key: normalisation of a SEB configuration into the "SEB-JSON" string,
 * then SHA-256.
 *
 * This is a faithful port of the reference implementation of the Moodle plugin
 * `quizaccess_seb`, itself written against the SEB developer documentation.
 * Every rule below carries the reference it comes from:
 *
 *   [SPEC]  https://safeexambrowser.org/developer/seb-config-key.html
 *   [CK]    mod/quiz/accessrule/seb/classes/config_key.php      (Moodle 4.5)
 *   [PL]    mod/quiz/accessrule/seb/classes/property_list.php   (Moodle 4.5)
 *           https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/classes/property_list.php
 *
 * The numbered rules are the ones spelled out in the doc block of
 * `property_list::to_json()` [PL], which restates [SPEC]:
 *
 *   1. no whitespace, no line formatting;
 *   2. no character escaping — in particular the backslashes of URL filter
 *      rules stay raw;
 *   3. every `<dict>` is sorted by key name, recursively, with a
 *      culture-invariant case-insensitive Unicode ordering, so that
 *      `allowWlan` comes before `allowWLAN`;
 *   4. empty `<dict>` elements are removed;
 *   5. strings are UTF-8;
 *   6. Base16 uses lower-case a-f;
 *   7. `<data>` becomes its Base64 string;
 *   8. `<date>` becomes an ISO 8601 string.
 *
 * And, before all of them, `originatorVersion` is deleted [CK:generate].
 */
import { createHash } from "node:crypto";

import { parsePlist, type SebDict, type SebValue } from "./plist.js";

/**
 * Rule 3 [PL:array_sort]. The reference calls `(new Collator('root'))->asort()`,
 * i.e. the Unicode Collation Algorithm with the root locale and default
 * strength, under which case is a tertiary difference and lower case sorts
 * first.
 *
 * Node resolves both `'root'` and `'und'` to the *runtime* default locale
 * (`'root'` is in fact rejected outright), which would make the result depend
 * on the machine. `'en'` is used instead: it carries no collation tailoring in
 * CLDR, so it is the root order, and it is deterministic. The golden vector
 * `JSON_unencrypted_mac_001.txt` (239 keys, several differing only by case)
 * is what actually proves the ordering matches the reference.
 */
const COLLATOR = new Intl.Collator("en", {
  usage: "sort",
  sensitivity: "variant",
  numeric: false,
  caseFirst: "false",
  ignorePunctuation: false,
});

/** Rule 4 [PL:prepare_plist_for_json_encoding]: drop empty `<dict>` elements. */
function prune(value: SebValue): SebValue | null {
  switch (value.kind) {
    case "dict": {
      const kept: Array<readonly [string, SebValue]> = [];
      for (const [key, child] of value.value) {
        const pruned = prune(child);
        if (pruned !== null) kept.push([key, pruned] as const);
      }
      // The reference walks the tree depth-first and deletes an empty
      // dictionary from its parent *after* its own children were deleted, so
      // the removal cascades upwards. Returning null here reproduces that.
      return kept.length === 0 ? null : { kind: "dict", value: kept };
    }
    case "array": {
      const kept: SebValue[] = [];
      for (const item of value.value) {
        const pruned = prune(item);
        if (pruned !== null) kept.push(pruned);
      }
      return { kind: "array", value: kept };
    }
    default:
      return value;
  }
}

/**
 * Rules 1, 2 and 5 [PL:to_json]. The reference calls `json_encode` with
 * `JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE`, then puts back the
 * backslashes that PHP insists on escaping.
 *
 * `keepBackslash` reproduces the asymmetry of the reference exactly: the
 * substitution of `\` happens in the callback that visits **values**
 * (`$value instanceof CFString`), so a backslash inside a dictionary *key*
 * is still escaped by `json_encode`. No SEB key contains one, but the port
 * stays faithful rather than tidy.
 */
function jsonString(text: string, keepBackslash: boolean): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += keepBackslash ? "\\" : "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    // PHP escapes U+2028/U+2029 even under JSON_UNESCAPED_UNICODE unless
    // JSON_UNESCAPED_LINE_TERMINATORS is passed, which the reference does not.
    else if (code === 0x2028 || code === 0x2029) out += `\\u${code.toString(16)}`;
    else out += ch;
  }
  return `${out}"`;
}

/**
 * PHP renders a float with `serialize_precision = -1`, i.e. the shortest
 * round-tripping representation — the same algorithm as JavaScript's
 * `Number#toString` — but it always keeps a decimal part, so `1.0` stays
 * `1.0` where `String(1)` would give `1`.
 * TODO(verify): PHP switches to `1.0e+30` for very large magnitudes where
 * JavaScript writes `1e+30`. No SEB setting is a float of that magnitude
 * (the two `<real>` keys in a `.seb` file are battery thresholds in [0,1]),
 * so the divergence is left unhandled and untested.
 */
function jsonNumber(value: number, kind: "integer" | "real"): string {
  if (kind === "integer") return value.toFixed(0);
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function serialise(value: SebValue): string {
  switch (value.kind) {
    case "bool":
      return value.value ? "true" : "false";
    case "integer":
    case "real":
      return jsonNumber(value.value, value.kind);
    case "string":
      return jsonString(value.value, true);
    // Rule 7: `<data>` is re-emitted as its Base64 text, as a JSON string.
    case "data":
      return jsonString(value.value, true);
    // Rule 8: `<date>` becomes ISO 8601.
    case "date":
      return jsonString(isoDate(value.value), true);
    case "array":
      return `[${value.value.map(serialise).join(",")}]`;
    case "dict":
      return serialiseDict(value.value);
  }
}

function serialiseDict(entries: SebDict): string {
  // A dictionary that survived pruning is never empty, except the root one;
  // the reference serialises a PList to a PHP array, and `json_encode` of an
  // empty PHP array is `[]`, not `{}` — which is why the Config Key of an
  // empty configuration is sha256("[]"). See [PL:is_associative_array], which
  // returns false for an empty array.
  if (entries.length === 0) return "[]";
  const sorted = [...entries].sort(([a], [b]) => COLLATOR.compare(a, b));
  const body = sorted
    .map(([key, child]) => `${jsonString(key, false)}:${serialise(child)}`)
    .join(",");
  return `{${body}}`;
}

/**
 * Rule 8 [PL:prepare_plist_for_json_encoding]: the reference reads the plist
 * date as a Unix timestamp then formats it with PHP's `'c'`, which yields
 * `2010-01-01T12:00:00+00:00` — an explicit offset, not `Z`, and no
 * sub-second part.
 *
 * TODO(verify): no published vector exercises a `<date>`. The Moodle test
 * suite only asserts that two fixtures containing the same date hash alike,
 * which does not pin the format. The configurations this portal generates
 * contain no `<date>`, so this path is documented but unproven.
 */
function isoDate(text: string): string {
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text;
  return `${parsed.toISOString().replace(/\.\d{3}Z$/, "")}+00:00`;
}

/** The key that is exempted from the hash [CK:generate]. */
export const EXEMPT_KEY = "originatorVersion";

/**
 * Builds the SEB-JSON string of a configuration. Exposed on its own because
 * it is the value the Moodle fixture `JSON_unencrypted_mac_001.txt` pins, so
 * a failure can be read directly instead of through a hash.
 */
export function sebJson(root: SebValue): string {
  if (root.kind !== "dict") throw new TypeError("A SEB configuration root must be a dictionary");
  // [CK:generate] "Remove the key originatorVersion first."
  // The reference deletes it at *every* depth (`plist_map` is recursive), not
  // only at the root, so `strip` is recursive too.
  const stripped = strip(root);
  const pruned = prune(stripped);
  // The root dictionary survives even when empty: the reference only deletes
  // an empty dictionary through its *parent*, and the root has none.
  return serialiseDict(pruned === null ? [] : (pruned as { value: SebDict }).value);
}

function strip(value: SebValue): SebValue {
  switch (value.kind) {
    case "dict":
      return {
        kind: "dict",
        value: value.value
          .filter(([key]) => key !== EXEMPT_KEY)
          .map(([key, child]) => [key, strip(child)] as const),
      };
    case "array":
      return { kind: "array", value: value.value.map(strip) };
    default:
      return value;
  }
}

/** The Config Key: SHA-256 of the SEB-JSON string, Base16 lower case (rule 6). */
export function configKey(root: SebValue): string {
  return createHash("sha256").update(sebJson(root), "utf8").digest("hex");
}

/**
 * The Config Key of an unencrypted `.seb` file (plist XML), which is the entry
 * point the Moodle test vectors use. An empty string means "SEB defaults",
 * i.e. an empty root dictionary [PL:__construct].
 */
export function configKeyFromPlistXml(xml: string): string {
  if (xml.trim() === "") return configKey({ kind: "dict", value: [] });
  return configKey(parsePlist(xml));
}
