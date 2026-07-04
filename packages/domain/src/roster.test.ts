import { describe, expect, it } from "vitest";

import { parseRosterCsv } from "./roster.js";

const ok = (text: string) => {
  const r = parseRosterCsv(text);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.rows;
};
const errors = (text: string) => {
  const r = parseRosterCsv(text);
  if (r.ok) throw new Error("attendu: erreurs");
  return r.errors;
};

describe("parseRosterCsv (AU-13..16)", () => {
  it("parse un CSV virgule avec normalisation d'e-mail", () => {
    expect(ok("nom,prenom,email\nDupont,Marie, Marie.DUPONT@heig-vd.ch \n")).toEqual([
      { nom: "Dupont", prenom: "Marie", email: "marie.dupont@heig-vd.ch" },
    ]);
  });

  it("détecte le séparateur point-virgule et l'ordre libre des colonnes", () => {
    expect(ok("email;nom;prenom\na@b.ch;Martin;Luc")).toEqual([
      { nom: "Martin", prenom: "Luc", email: "a@b.ch" },
    ]);
  });

  it("ignore BOM et lignes vides", () => {
    expect(ok("﻿nom,prenom,email\n\nDupont,Marie,a@b.ch\n\n")).toHaveLength(1);
  });

  it("rejette l'en-tête incomplet", () => {
    expect(errors("nom,email\nx,a@b.ch")[0]?.message).toMatch(/prenom/);
  });

  it("rejette un doublon intra-fichier avec les deux lignes citées", () => {
    const errs = errors("nom,prenom,email\nA,B,a@b.ch\nC,D,A@B.CH");
    expect(errs[0]?.line).toBe(3);
    expect(errs[0]?.message).toMatch(/ligne 2/);
  });

  it("rejette e-mail invalide et champs manquants (import atomique)", () => {
    const errs = errors("nom,prenom,email\nA,,a@b.ch\nB,C,pas-un-email");
    expect(errs).toHaveLength(2);
  });

  it("rejette un fichier sans données", () => {
    expect(errors("nom,prenom,email\n")[0]?.message).toMatch(/Aucune ligne/);
    expect(errors("")[0]?.message).toMatch(/vide/);
  });
});
