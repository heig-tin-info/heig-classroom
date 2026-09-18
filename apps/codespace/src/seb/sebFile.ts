/**
 * Generation of the `.seb` file of an assignment in exam mode, and of the
 * matching Config Key.
 *
 * **Shape of the file.** An unencrypted `.seb` is a plain XML plist, with no
 * gzip and no prefix: that is what the Moodle plugin `quizaccess_seb` serves
 * (`helper::send_seb_config_file`, `Content-Type: application/seb`), and it is
 * the shape of the example files published by the SEB project itself, for
 * instance
 * <https://github.com/SafeExamBrowser/SafeExamBrowser-Website/blob/master/exams/MoodleDemoEduhubDaysFilterUC.seb>
 * which starts with `<?xml version="1.0" encoding="UTF-8"?>`. Encryption
 * (prefixes `pswd`, `pwcc`, `plnd`, …) only concerns password-protected files,
 * ruled out by analyse.md § 4.4: "encrypting the `.seb` file brings nothing
 * to integrity (the Config Key guarantees it)".
 *
 * **Partial configuration.** The file only contains the settings that matter,
 * not the whole of the SEB settings. That is legitimate: the Config Key is
 * computed over the content of the file, and `quizaccess_seb` does exactly
 * that — `seb_quiz_settings::process_seb_config_manually()` starts from an
 * empty `new property_list()` and only adds the settings of the form.
 *
 * **The BEK is not in the file.** `browserExamKey` stays empty and
 * `examKeySalt` carries a salt of its own per assignment: SEB then computes
 * the BEK from the salt and from its own binary, hence one BEK per platform
 * and per version (analyse.md § 4.4, whence the list of BEKs on the assignment
 * side). Writing a BEK into the file would amount to handing the shared secret
 * to the student, which project.md § 9 explicitly forbids.
 *
 * Names and types of the settings: taken from two real configurations, the one
 * of SEB Windows 2.2.3 (`fixtures/unencrypted_win_223.seb`) and the one
 * published by the SEB project quoted above.
 */
import { randomBytes } from "node:crypto";

import { configKey } from "./configKey.js";
import {
  array,
  bool,
  data,
  dict,
  int,
  parsePlist,
  str,
  toPlistXml,
  type SebValue,
} from "./plist.js";

/** MIME type and file name, see `helper::get_seb_file_headers()`. */
export const SEB_CONTENT_TYPE = "application/seb";

export interface SebConfigInput {
  /** Absolute URL of the start route: `https://<portal>/exam/<a>/start`. */
  readonly startUrl: string;
  /** SEB quit URL, shown to the student at the end of the exam. */
  readonly quitUrl: string;
  /** Browser Exam Key salt, in base64. Stable for a given assignment. */
  readonly examKeySalt: string;
  /**
   * Extra hosts allowed by the URL filter. Empty by default: project.md § 7
   * "Documentation hors ligne" wants the mirrors to be served under the
   * portal's own paths, so that the list boils down to a single domain rule.
   */
  readonly extraAllowedHosts?: readonly string[];
}

/** A fresh salt, to be kept in the assignment: it has to be stable. */
export function newExamKeySalt(): string {
  return randomBytes(32).toString("base64");
}

function filterRule(expression: string): SebValue {
  // Shape taken from the configuration published by the SEB project:
  // action 1 = allow, `regex` false = expression with wildcard characters.
  return dict([
    ["action", int(1)],
    ["active", bool(true)],
    ["expression", str(expression)],
    ["regex", bool(false)],
  ]);
}

/** Builds the SEB configuration of an assignment, as a typed plist tree. */
export function buildSebConfig(input: SebConfigInput): SebValue {
  const host = new URL(input.startUrl).host;
  const hosts = [host, ...(input.extraAllowedHosts ?? [])];

  return dict([
    // --- Start and quit ---
    ["startURL", str(input.startUrl)],
    ["quitURL", str(input.quitUrl)],
    ["quitURLConfirm", bool(true)],
    ["allowQuit", bool(true)],
    ["restartExamUseStartURL", bool(true)],

    // --- URL filter: only the portal domain (invariant: closed network) ---
    ["URLFilterEnable", bool(true)],
    ["URLFilterEnableContentFilter", bool(true)],
    ["URLFilterRulesAsRegex", bool(false)],
    ["URLFilterRules", array(hosts.map(filterRule))],

    // --- File input and output (analyse.md § 4.3) ---
    ["allowDownUploads", bool(false)],
    ["downloadAndOpenSebConfig", bool(false)],
    ["downloadPDFFiles", bool(false)],
    ["enablePrivateClipboard", bool(true)],

    // --- Kiosk ---
    // TODO(verify): `browserViewMode` is 0 in both reference configurations;
    // the value 1 (full screen) has not been checked against a pinned version
    // of SEB. To be confirmed during the manual proof B.
    ["browserViewMode", int(1)],
    ["enableBrowserWindowToolbar", bool(false)],
    ["hideBrowserWindowToolbar", bool(true)],
    ["showMenuBar", bool(false)],
    ["showTaskBar", bool(false)],
    ["allowBrowsingBackForward", bool(false)],
    ["allowPreferencesWindow", bool(false)],
    ["allowSwitchToApplications", bool(false)],
    ["allowVirtualMachine", bool(false)],
    ["allowSpellCheck", bool(false)],
    ["blockPopUpWindows", bool(true)],
    ["createNewDesktop", bool(true)],
    ["killExplorerShell", bool(false)],

    // --- Keys ---
    ["sendBrowserExamKey", bool(true)],
    // Empty on purpose: see the header of this module.
    ["browserExamKey", str("")],
    ["examKeySalt", data(input.examKeySalt)],
    // TODO(verify): `browserURLSalt` is `true` in both reference
    // configurations. Its exact semantics (inclusion of the URL in the request
    // hash computation) has not been checked against a pinned version; the
    // reference value is carried over as is.
    ["browserURLSalt", bool(true)],
  ]);
}

export interface GeneratedSebFile {
  /** The content of the `.seb`, an unencrypted XML plist. */
  readonly xml: string;
  /** The Config Key of this configuration, to be stored in the assignment. */
  readonly configKey: string;
}

/** Renders the file and its Config Key in one go: the two belong together. */
export function renderSebFile(input: SebConfigInput): GeneratedSebFile {
  const config = buildSebConfig(input);
  return { xml: toPlistXml(config), configKey: configKey(config) };
}

/**
 * The Config Key of a `.seb` file that has already been written, by reading it
 * back. Used by the idempotence test:
 * `renderSebFile(x).configKey === configKeyOfSebFile(xml)`.
 */
export function configKeyOfSebFile(xml: string): string {
  return configKey(parsePlist(xml));
}

/**
 * The link the student clicks. `sebs://` is the same URL as the `https://` one
 * of the file, with the scheme swapped: that is what
 * `link_generator::get_link()` of `quizaccess_seb` does
 * (`$url->set_scheme('sebs')`).
 *
 * @param origin Public origin of the portal, `https://codespace.heig-vd.ch`.
 */
export function sebLink(origin: string, assignmentId: string): string {
  const url = new URL(`/exam/${encodeURIComponent(assignmentId)}.seb`, origin);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unexpected origin for a SEB link: ${origin}`);
  }
  // `seb://` for http, `sebs://` for https, like the Moodle generator.
  const scheme = url.protocol === "https:" ? "sebs" : "seb";
  return `${scheme}://${url.host}${url.pathname}${url.search}`;
}

/** The path of the file, so that routes.ts and sebLink do not diverge. */
export function sebFilePath(assignmentId: string): string {
  return `/exam/${encodeURIComponent(assignmentId)}.seb`;
}

/** The path of the verified start route. */
export function sebStartPath(assignmentId: string): string {
  return `/exam/${encodeURIComponent(assignmentId)}/start`;
}
