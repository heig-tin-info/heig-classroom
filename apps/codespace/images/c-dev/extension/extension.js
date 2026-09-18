/**
 * heig.codespace-statusbar — status bar of the heig-codespace portal.
 *
 * Two items at the right of the status bar:
 *   1. the time left until the assignment deadline, refreshed every 30 s;
 *   2. a « Fermer » button that opens the return URL (classroom or portal).
 *
 * Everything comes from the container environment, set by the portal's
 * `podman run` (`src/engine/index.ts`):
 *   CODESPACE_DEADLINE         ISO 8601 deadline  (optional: without it, no countdown)
 *   CODESPACE_RETURN_URL       return URL         (optional: without it, no button)
 *   CODESPACE_ASSIGNMENT_NAME  assignment title   (optional, shown in the tooltip)
 *
 * The code-server extension host inherits the server's environment:
 * `ExtensionHostConnection#buildUserEnvironment` builds `{...process.env, ...}`
 * (checked in the bundled package, see ../README.md).
 *
 * No network access, no telemetry, no dependency: the student container has
 * neither a resolver nor a way out (invariants 1 and 2).
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

/** Refresh period of the countdown. */
const TICK_MS = 30_000;
/** Below this remaining time, the item switches to the warning colour. */
const WARN_MS = 10 * 60 * 1000;
/**
 * Witness file written at activation. It only serves to check, from the host,
 * that the extension host really received the container environment
 * (images/c-dev/test.sh, and a manual check after the editor is opened). It
 * contains no secret: only the three variables.
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

/** French as soon as the interface language starts with "fr". */
function pickStrings(language) {
  return String(language || "en").toLowerCase().startsWith("fr") ? STRINGS.fr : STRINGS.en;
}

/** Countdown text for a remaining time in milliseconds. */
function formatRemaining(remainingMs, t) {
  if (remainingMs <= 0) return t.overdue;
  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes < 1) return t.lessThanAMinute;
  return t.remaining(Math.floor(totalMinutes / 60), totalMinutes % 60);
}

/** Local date and time of the container (TZ=Europe/Zurich in the image). */
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

/** `undefined` rather than an empty string: an empty variable means absent. */
function readEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function writeWitness(payload) {
  try {
    fs.writeFileSync(WITNESS, JSON.stringify(payload, null, 2), { encoding: "utf8" });
  } catch {
    // The witness is a testing convenience, never a condition of operation.
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

  // --- 1. countdown --------------------------------------------------------
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

  // --- 2. « Fermer » button ------------------------------------------------
  // The command is always registered (it is declared by the manifest, so it is
  // visible in the palette); the status bar item, though, only exists if the
  // portal passed a return URL.
  context.subscriptions.push(
    vscode.commands.registerCommand("codespace.close", async () => {
      if (!returnUrl) {
        await vscode.window.showInformationMessage(t.noReturnUrl);
        return;
      }
      // `openExternal` opens a new browser tab (see README).
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
