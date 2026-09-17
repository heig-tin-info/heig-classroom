/**
 * heig.codespace-statusbar — barre d'etat du portail heig-codespace.
 *
 * Deux elements a droite de la barre d'etat :
 *   1. le temps restant jusqu'a l'echeance du devoir, rafraichi toutes les 30 s ;
 *   2. un bouton « Fermer » qui ouvre l'URL de retour (classroom ou portail).
 *
 * Tout vient de l'environnement du conteneur, pose par le `podman run` du
 * portail (`src/engine/index.ts`) :
 *   CODESPACE_DEADLINE         echeance ISO 8601  (optionnelle : sans elle, pas de compte a rebours)
 *   CODESPACE_RETURN_URL       URL de retour      (optionnelle : sans elle, pas de bouton)
 *   CODESPACE_ASSIGNMENT_NAME  titre du devoir    (optionnel, affiche dans l'infobulle)
 *
 * L'hote d'extensions de code-server herite de l'environnement du serveur :
 * `ExtensionHostConnection#buildUserEnvironment` construit `{...process.env, ...}`
 * (verifie dans le paquet embarque, voir ../README.md).
 *
 * Aucun acces reseau, aucune telemetrie, aucune dependance : le conteneur
 * etudiant n'a ni resolveur ni sortie (invariants 1 et 2).
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

/** Periode de rafraichissement du compte a rebours. */
const TICK_MS = 30_000;
/** En dessous de ce reste, l'element passe en couleur d'avertissement. */
const WARN_MS = 10 * 60 * 1000;
/**
 * Fichier temoin ecrit a l'activation. Il ne sert qu'a constater, depuis
 * l'hote, que l'hote d'extensions a bien recu l'environnement du conteneur
 * (images/c-dev/test.sh, et verification manuelle apres ouverture de
 * l'editeur). Il ne contient aucun secret : seules les trois variables.
 */
const WITNESS = path.join(os.tmpdir(), "codespace-statusbar.json");

const STRINGS = {
  fr: {
    overdue: "Échéance dépassée",
    lessThanAMinute: "moins d'une minute restante",
    close: "Fermer",
    closeTooltip: "Quitter l'éditeur et revenir au portail",
    deadline: "Échéance",
    assignment: "Devoir",
    noReturnUrl: "Aucune URL de retour n'a été transmise à cette session.",
    remaining: (h, m) =>
      h > 0
        ? `${h} h ${m} min restantes`
        : m > 1
          ? `${m} min restantes`
          : `${m} min restante`,
  },
  en: {
    overdue: "Deadline passed",
    lessThanAMinute: "less than a minute left",
    close: "Close",
    closeTooltip: "Leave the editor and go back to the portal",
    deadline: "Deadline",
    assignment: "Assignment",
    noReturnUrl: "No return URL was given to this session.",
    remaining: (h, m) => (h > 0 ? `${h} h ${m} min left` : `${m} min left`),
  },
};

/** Francais des que la langue de l'interface commence par « fr ». */
function pickStrings(language) {
  return String(language || "en").toLowerCase().startsWith("fr") ? STRINGS.fr : STRINGS.en;
}

/** Texte du compte a rebours pour un reste en millisecondes. */
function formatRemaining(remainingMs, t) {
  if (remainingMs <= 0) return t.overdue;
  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes < 1) return t.lessThanAMinute;
  return t.remaining(Math.floor(totalMinutes / 60), totalMinutes % 60);
}

/** Date-heure locale du conteneur (TZ=Europe/Zurich dans l'image). */
function formatDeadline(deadline, fr) {
  try {
    return deadline.toLocaleString(fr ? "fr-CH" : "en-GB", {
      dateStyle: "full",
      timeStyle: "short",
    });
  } catch {
    return deadline.toISOString();
  }
}

/** `undefined` plutot qu'une chaine vide : une variable vide vaut absente. */
function readEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function writeWitness(payload) {
  try {
    fs.writeFileSync(WITNESS, JSON.stringify(payload, null, 2), { encoding: "utf8" });
  } catch {
    // Le temoin est un confort de test, jamais une condition de marche.
  }
}

function activate(context) {
  const fr = String(vscode.env.language || "en").toLowerCase().startsWith("fr");
  const t = pickStrings(vscode.env.language);

  const rawDeadline = readEnv("CODESPACE_DEADLINE");
  const returnUrl = readEnv("CODESPACE_RETURN_URL");
  const assignmentName = readEnv("CODESPACE_ASSIGNMENT_NAME");

  const parsed = rawDeadline ? new Date(rawDeadline) : null;
  const deadline = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;

  writeWitness({
    activatedAt: new Date().toISOString(),
    language: vscode.env.language,
    deadline: rawDeadline ?? null,
    deadlineParsed: deadline ? deadline.toISOString() : null,
    returnUrl: returnUrl ?? null,
    assignmentName: assignmentName ?? null,
  });

  // --- 1. compte a rebours -------------------------------------------------
  if (deadline) {
    const countdown = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    const tooltipLines = [`${t.deadline} : ${formatDeadline(deadline, fr)}`];
    if (assignmentName) tooltipLines.push(`${t.assignment} : ${assignmentName}`);
    countdown.tooltip = tooltipLines.join("\n");

    const render = () => {
      const remaining = deadline.getTime() - Date.now();
      countdown.text = `$(clock) ${formatRemaining(remaining, t)}`;
      countdown.backgroundColor =
        remaining <= WARN_MS
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
    };

    render();
    countdown.show();
    const timer = setInterval(render, TICK_MS);
    context.subscriptions.push(countdown, { dispose: () => clearInterval(timer) });
  }

  // --- 2. bouton « Fermer » ------------------------------------------------
  // La commande est toujours enregistree (elle est declaree par le manifeste,
  // donc visible dans la palette) ; l'element de barre d'etat, lui, n'existe
  // que si le portail a transmis une URL de retour.
  context.subscriptions.push(
    vscode.commands.registerCommand("codespace.close", async () => {
      if (!returnUrl) {
        await vscode.window.showInformationMessage(t.noReturnUrl);
        return;
      }
      // `openExternal` ouvre un nouvel onglet du navigateur (voir README).
      await vscode.env.openExternal(vscode.Uri.parse(returnUrl));
    }),
  );

  if (returnUrl) {
    const close = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    close.text = `$(sign-out) ${t.close}`;
    close.tooltip = `${t.closeTooltip} (${returnUrl})`;
    close.command = "codespace.close";
    close.show();
    context.subscriptions.push(close);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
