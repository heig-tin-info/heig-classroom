/**
 * Génération du fichier `.seb` d'un devoir en mode examen, et de la Config Key
 * qui lui correspond.
 *
 * **Forme du fichier.** Un `.seb` non chiffré est un plist XML tel quel, sans
 * gzip ni préfixe : c'est ce que sert le greffon Moodle `quizaccess_seb`
 * (`helper::send_seb_config_file`, `Content-Type: application/seb`), et c'est
 * la forme des fichiers d'exemple publiés par le projet SEB lui-même, par
 * exemple
 * <https://github.com/SafeExamBrowser/SafeExamBrowser-Website/blob/master/exams/MoodleDemoEduhubDaysFilterUC.seb>
 * qui commence par `<?xml version="1.0" encoding="UTF-8"?>`. Le chiffrement
 * (préfixes `pswd`, `pwcc`, `plnd`…) ne concerne que les fichiers protégés par
 * mot de passe, écartés par analyse.md § 4.4 : « le chiffrement du fichier
 * `.seb` n'apporte rien à l'intégrité (la Config Key la garantit) ».
 *
 * **Configuration partielle.** Le fichier ne contient que les réglages qui
 * comptent, pas la totalité des réglages SEB. C'est légitime : la Config Key
 * se calcule sur le contenu du fichier, et `quizaccess_seb` fait exactement
 * cela — `seb_quiz_settings::process_seb_config_manually()` part d'un
 * `new property_list()` vide et n'y ajoute que les réglages du formulaire.
 *
 * **Le BEK n'est pas dans le fichier.** `browserExamKey` reste vide et
 * `examKeySalt` porte un sel propre au devoir : SEB calcule alors le BEK à
 * partir du sel et de son propre binaire, donc un BEK par plateforme et par
 * version (analyse.md § 4.4, d'où la liste de BEK côté devoir). Écrire un BEK
 * dans le fichier reviendrait à remettre le secret partagé à l'étudiant, ce
 * que project.md § 9 interdit explicitement.
 *
 * Noms et types des réglages : relevés sur deux configurations réelles, celle
 * de SEB Windows 2.2.3 (`fixtures/unencrypted_win_223.seb`) et celle publiée
 * par le projet SEB citée plus haut.
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

/** Type MIME et nom de fichier, cf. `helper::get_seb_file_headers()`. */
export const SEB_CONTENT_TYPE = "application/seb";

export interface SebConfigInput {
  /** URL absolue de la route de démarrage : `https://<portail>/exam/<a>/start`. */
  readonly startUrl: string;
  /** URL de sortie de SEB, présentée à l'étudiant à la fin de l'épreuve. */
  readonly quitUrl: string;
  /** Sel du Browser Exam Key, en base64. Stable pour un devoir donné. */
  readonly examKeySalt: string;
  /**
   * Hôtes supplémentaires autorisés par le filtre d'URL. Vide par défaut :
   * project.md § 7 « Documentation hors ligne » veut que les miroirs soient
   * servis sous les chemins du portail, pour que la liste se réduise à une
   * règle de domaine unique.
   */
  readonly extraAllowedHosts?: readonly string[];
}

/** Un sel neuf, à conserver dans le devoir : il doit être stable. */
export function newExamKeySalt(): string {
  return randomBytes(32).toString("base64");
}

function filterRule(expression: string): SebValue {
  // Forme relevée sur la configuration publiée par le projet SEB :
  // action 1 = autoriser, `regex` faux = expression avec caractères jokers.
  return dict([
    ["action", int(1)],
    ["active", bool(true)],
    ["expression", str(expression)],
    ["regex", bool(false)],
  ]);
}

/** Construit la configuration SEB d'un devoir, comme arbre plist typé. */
export function buildSebConfig(input: SebConfigInput): SebValue {
  const host = new URL(input.startUrl).host;
  const hosts = [host, ...(input.extraAllowedHosts ?? [])];

  return dict([
    // --- Démarrage et sortie ---
    ["startURL", str(input.startUrl)],
    ["quitURL", str(input.quitUrl)],
    ["quitURLConfirm", bool(true)],
    ["allowQuit", bool(true)],
    ["restartExamUseStartURL", bool(true)],

    // --- Filtre d'URL : seul le domaine du portail (invariant : réseau clos) ---
    ["URLFilterEnable", bool(true)],
    ["URLFilterEnableContentFilter", bool(true)],
    ["URLFilterRulesAsRegex", bool(false)],
    ["URLFilterRules", array(hosts.map(filterRule))],

    // --- Entrées et sorties de fichiers (analyse.md § 4.3) ---
    ["allowDownUploads", bool(false)],
    ["downloadAndOpenSebConfig", bool(false)],
    ["downloadPDFFiles", bool(false)],
    ["enablePrivateClipboard", bool(true)],

    // --- Kiosque ---
    // TODO(verify) : `browserViewMode` vaut 0 dans les deux configurations de
    // référence ; la valeur 1 (plein écran) n'a pas été vérifiée sur une
    // version épinglée de SEB. À confirmer lors de la preuve B manuelle.
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

    // --- Clés ---
    ["sendBrowserExamKey", bool(true)],
    // Vide à dessein : voir l'en-tête de ce module.
    ["browserExamKey", str("")],
    ["examKeySalt", data(input.examKeySalt)],
    // TODO(verify) : `browserURLSalt` vaut `true` dans les deux configurations
    // de référence. Sa sémantique exacte (inclusion de l'URL dans le calcul du
    // hachage de requête) n'a pas été vérifiée sur une version épinglée ; la
    // valeur de référence est reprise telle quelle.
    ["browserURLSalt", bool(true)],
  ]);
}

export interface GeneratedSebFile {
  /** Le contenu du `.seb`, plist XML non chiffré. */
  readonly xml: string;
  /** La Config Key de cette configuration, à stocker dans le devoir. */
  readonly configKey: string;
}

/** Rend le fichier et sa Config Key d'un seul coup : les deux vont ensemble. */
export function renderSebFile(input: SebConfigInput): GeneratedSebFile {
  const config = buildSebConfig(input);
  return { xml: toPlistXml(config), configKey: configKey(config) };
}

/**
 * La Config Key d'un fichier `.seb` déjà écrit, en le relisant. Sert au test
 * d'idempotence : `renderSebFile(x).configKey === configKeyOfSebFile(xml)`.
 */
export function configKeyOfSebFile(xml: string): string {
  return configKey(parsePlist(xml));
}

/**
 * Le lien que l'étudiant clique. `sebs://` est la même URL que le `https://`
 * du fichier, schéma remplacé : c'est ce que fait `link_generator::get_link()`
 * de `quizaccess_seb` (`$url->set_scheme('sebs')`).
 *
 * @param origin Origine publique du portail, `https://codespace.heig-vd.ch`.
 */
export function sebLink(origin: string, assignmentId: string): string {
  const url = new URL(`/exam/${encodeURIComponent(assignmentId)}.seb`, origin);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Origine inattendue pour un lien SEB : ${origin}`);
  }
  // `seb://` pour http, `sebs://` pour https, comme le générateur de Moodle.
  const scheme = url.protocol === "https:" ? "sebs" : "seb";
  return `${scheme}://${url.host}${url.pathname}${url.search}`;
}

/** Le chemin du fichier, pour que routes.ts et sebLink ne divergent pas. */
export function sebFilePath(assignmentId: string): string {
  return `/exam/${encodeURIComponent(assignmentId)}.seb`;
}

/** Le chemin de la route de démarrage vérifiée. */
export function sebStartPath(assignmentId: string): string {
  return `/exam/${encodeURIComponent(assignmentId)}/start`;
}
