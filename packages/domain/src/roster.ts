/**
 * Import du roster (AU-13..16) depuis des données tabulaires : CSV collé ou
 * feuille Excel déposée. L'identification des colonnes nom / prénom / e-mail
 * est PERMISSIVE : accents et casse ignorés, alias français/anglais, colonnes
 * parasites tolérées, en-tête pas forcément en première ligne, et repli sur la
 * détection de la colonne e-mail par son contenu si aucun en-tête n'est
 * reconnu. L'import reste atomique : la moindre erreur rejette tout.
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

/** Cellule telle qu'elle sort d'un parseur CSV ou d'une feuille Excel. */
export type Cell = string | number | null | undefined;

// Volontairement simple : la vérification forte, c'est le claim sur e-mail
// vérifié par l'IdP (AU-18) — ici on attrape les fautes de frappe évidentes.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** minuscules, sans accents ni ponctuation : « E-Mail » → « email ». */
function normalizeHeader(cell: Cell): string {
  return String(cell ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const ALIASES = {
  nom: ["nom", "nomdefamille", "lastname", "surname", "familyname"],
  prenom: ["prenom", "firstname", "givenname"],
  email: ["email", "mail", "emailaddress", "adresseemail", "adressemail", "courriel"],
} as const;

type Columns = { nom: number; prenom: number; email: number };

function matchHeader(row: readonly Cell[]): Partial<Columns> {
  const found: Partial<Columns> = {};
  row.forEach((cell, i) => {
    const h = normalizeHeader(cell);
    for (const key of ["nom", "prenom", "email"] as const) {
      if (found[key] === undefined && (ALIASES[key] as readonly string[]).includes(h)) {
        found[key] = i;
      }
    }
  });
  return found;
}

const HEADER_SCAN_ROWS = 10;

/**
 * Localise l'en-tête (les trois colonnes reconnues sur une même ligne, dans
 * les premières lignes) ; à défaut, détecte la colonne e-mail par contenu et
 * prend les deux premières autres colonnes comme nom puis prénom.
 */
function locateColumns(rows: readonly (readonly Cell[])[]): {
  columns: Columns;
  dataStart: number;
} | null {
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN_ROWS); i++) {
    const found = matchHeader(rows[i] ?? []);
    if (found.nom !== undefined && found.prenom !== undefined && found.email !== undefined) {
      return { columns: found as Columns, dataStart: i + 1 };
    }
  }
  // Repli sans en-tête : colonne dont le contenu ressemble le plus à des
  // e-mails, puis les deux premières autres colonnes (ordre nom, prénom).
  const width = Math.max(0, ...rows.map((r) => r.length));
  let bestCol = -1;
  let bestHits = 0;
  for (let c = 0; c < width; c++) {
    const hits = rows.filter((r) => EMAIL_RE.test(String(r[c] ?? "").trim())).length;
    if (hits > bestHits) {
      bestHits = hits;
      bestCol = c;
    }
  }
  if (bestCol === -1 || bestHits === 0) return null;
  const others = Array.from({ length: width }, (_, c) => c).filter((c) => c !== bestCol);
  const [nom, prenom] = others;
  if (nom === undefined || prenom === undefined) return null;
  return { columns: { nom, prenom, email: bestCol }, dataStart: 0 };
}

function cellText(cell: Cell): string {
  return String(cell ?? "").trim();
}

/** Cœur de l'import : des lignes tabulaires (CSV, Excel…) vers le roster. */
export function rosterFromRows(input: readonly (readonly Cell[])[]): RosterParse {
  // Les numéros de ligne rapportés sont ceux du document d'origine (base 1).
  const numbered = input
    .map((cells, i) => ({ line: i + 1, cells }))
    .filter(({ cells }) => cells.some((c) => cellText(c) !== ""));
  if (numbered.length === 0) {
    return { ok: false, errors: [{ line: 1, message: "Fichier vide" }] };
  }

  const located = locateColumns(numbered.map((r) => r.cells));
  if (!located) {
    return {
      ok: false,
      errors: [
        {
          line: 1,
          message:
            "Colonnes introuvables : attendu un en-tête nom / prenom / email (ou une colonne d'e-mails identifiable)",
        },
      ],
    };
  }

  const errors: RosterError[] = [];
  const rows: RosterRow[] = [];
  const seen = new Map<string, number>();

  for (const { line, cells } of numbered.slice(located.dataStart)) {
    const nom = cellText(cells[located.columns.nom]);
    const prenom = cellText(cells[located.columns.prenom]);
    const email = cellText(cells[located.columns.email]).toLowerCase();

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

function detectSeparator(line: string): "," | ";" | "\t" {
  const counts: ["\t" | ";" | ",", number][] = [
    ["\t", (line.match(/\t/g) ?? []).length],
    [";", (line.match(/;/g) ?? []).length],
    [",", (line.match(/,/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ",";
}

/** CSV texte (collé dans le portail) : découpe simple puis règles communes. */
export function parseRosterCsv(text: string): RosterParse {
  const clean = text.replace(/^﻿/, ""); // BOM
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const sep = detectSeparator(firstLine);
  const rows = clean.split(/\r?\n/).map((l) => l.split(sep));
  return rosterFromRows(rows);
}
