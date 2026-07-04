/**
 * Import du roster par CSV (AU-13..16) : UTF-8, séparateur `,` ou `;`
 * auto-détecté, ligne d'en-tête obligatoire `nom,prenom,email` (ordre libre).
 * L'import est atomique : la moindre erreur (dont doublon intra-fichier)
 * rejette tout le fichier.
 */

export interface RosterRow {
  nom: string;
  prenom: string;
  /** Normalisé : trim + minuscules. */
  email: string;
}

export interface RosterError {
  line: number;
  message: string;
}

export type RosterParse =
  | { ok: true; rows: RosterRow[] }
  | { ok: false; errors: RosterError[] };

const REQUIRED_COLUMNS = ["nom", "prenom", "email"] as const;
// Volontairement simple : la vérification forte, c'est le claim sur e-mail
// vérifié par l'IdP (AU-18) — ici on attrape les fautes de frappe évidentes.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function detectSeparator(header: string): "," | ";" {
  const commas = (header.match(/,/g) ?? []).length;
  const semis = (header.match(/;/g) ?? []).length;
  return semis > commas ? ";" : ",";
}

export function parseRosterCsv(text: string): RosterParse {
  const lines = text
    .replace(/^﻿/, "") // BOM
    .split(/\r?\n/)
    .map((l, i) => ({ line: i + 1, raw: l }))
    .filter(({ raw }) => raw.trim().length > 0);

  const header = lines.shift();
  if (!header) return { ok: false, errors: [{ line: 1, message: "Fichier vide" }] };

  const sep = detectSeparator(header.raw);
  const cols = header.raw.split(sep).map((c) => c.trim().toLowerCase());
  const indices: Record<(typeof REQUIRED_COLUMNS)[number], number> = {
    nom: cols.indexOf("nom"),
    prenom: cols.indexOf("prenom"),
    email: cols.indexOf("email"),
  };
  const missing = REQUIRED_COLUMNS.filter((c) => indices[c] === -1);
  if (missing.length > 0) {
    return {
      ok: false,
      errors: [{ line: 1, message: `En-tête invalide : colonne(s) ${missing.join(", ")} manquante(s)` }],
    };
  }

  const errors: RosterError[] = [];
  const rows: RosterRow[] = [];
  const seen = new Map<string, number>();

  for (const { line, raw } of lines) {
    const fields = raw.split(sep).map((f) => f.trim());
    const nom = fields[indices.nom] ?? "";
    const prenom = fields[indices.prenom] ?? "";
    const email = (fields[indices.email] ?? "").toLowerCase();

    if (!nom || !prenom) {
      errors.push({ line, message: "nom et prenom sont obligatoires" });
      continue;
    }
    if (!EMAIL_RE.test(email)) {
      errors.push({ line, message: `e-mail invalide : « ${email} »` });
      continue;
    }
    const first = seen.get(email);
    if (first !== undefined) {
      errors.push({ line, message: `doublon de « ${email} » (déjà en ligne ${first})` });
      continue;
    }
    seen.set(email, line);
    rows.push({ nom, prenom, email });
  }

  if (errors.length > 0) return { ok: false, errors };
  if (rows.length === 0) {
    return { ok: false, errors: [{ line: 1, message: "Aucune ligne de données" }] };
  }
  return { ok: true, rows };
}
