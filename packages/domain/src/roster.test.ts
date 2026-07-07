import { describe, expect, it } from "vitest";

import { parseRosterCsv, rosterFromRows } from "./roster.js";

const ok = (r: ReturnType<typeof parseRosterCsv>) => {
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.rows;
};
const errs = (r: ReturnType<typeof parseRosterCsv>) => {
  if (r.ok) throw new Error("attendu: erreurs");
  return r.errors;
};

describe("parseRosterCsv (AU-13..16)", () => {
  it("parse un CSV virgule avec normalisation d'e-mail", () => {
    expect(ok(parseRosterCsv("nom,prenom,email\nDupont,Marie, Marie.DUPONT@heig-vd.ch \n"))).toEqual([
      { nom: "Dupont", prenom: "Marie", email: "marie.dupont@heig-vd.ch" },
    ]);
  });

  it("détecte le séparateur point-virgule et l'ordre libre des colonnes", () => {
    expect(ok(parseRosterCsv("email;nom;prenom\na@b.ch;Martin;Luc"))).toEqual([
      { nom: "Martin", prenom: "Luc", email: "a@b.ch" },
    ]);
  });

  it("ignore BOM et lignes vides", () => {
    expect(ok(parseRosterCsv("﻿nom,prenom,email\n\nDupont,Marie,a@b.ch\n\n"))).toHaveLength(1);
  });

  it("rejette un doublon intra-fichier avec les deux lignes citées", () => {
    const e = errs(parseRosterCsv("nom,prenom,email\nA,B,a@b.ch\nC,D,A@B.CH"));
    expect(e[0]?.line).toBe(3);
    expect(e[0]?.message).toMatch(/line 2/);
  });

  it("rejette e-mail invalide et champs manquants (import atomique)", () => {
    const e = errs(parseRosterCsv("nom,prenom,email\nA,,a@b.ch\nB,C,pas-un-email"));
    expect(e).toHaveLength(2);
  });

  it("rejette un fichier sans données", () => {
    expect(errs(parseRosterCsv("nom,prenom,email\n"))[0]?.message).toMatch(/No data/);
    expect(errs(parseRosterCsv(""))[0]?.message).toMatch(/Empty/);
  });
});

describe("rosterFromRows — identification permissive (Excel)", () => {
  it("structure réelle HEIG : accents, E-mail, colonnes parasites", () => {
    const rows = [
      ["Nom", "Prénom", "Formation", "Mode de formation", "E-mail"],
      ["Baschiera", "Michele", "EEM", "PT", "michele.baschiera@heig-vd.ch"],
      ["Cornuz", "Aurélien", "EN", "EE", "aurelien.cornuz@heig-vd.ch"],
    ];
    expect(ok(rosterFromRows(rows))).toEqual([
      { nom: "Baschiera", prenom: "Michele", email: "michele.baschiera@heig-vd.ch" },
      { nom: "Cornuz", prenom: "Aurélien", email: "aurelien.cornuz@heig-vd.ch" },
    ]);
  });

  it("alias anglais et en-tête pas en première ligne (titre au-dessus)", () => {
    const rows = [
      ["Liste des étudiants — Info2", "", ""],
      [],
      ["First name", "Last Name", "E-Mail Address"],
      ["Ada", "Lovelace", "ada@heig-vd.ch"],
    ];
    expect(ok(rosterFromRows(rows))).toEqual([
      { nom: "Lovelace", prenom: "Ada", email: "ada@heig-vd.ch" },
    ]);
  });

  it("sans en-tête : colonne e-mail détectée par contenu, ordre nom puis prénom", () => {
    const rows = [
      ["Dupont", "Marie", "marie@heig-vd.ch"],
      ["Martin", "Luc", "luc@heig-vd.ch"],
    ];
    expect(ok(rosterFromRows(rows))).toEqual([
      { nom: "Dupont", prenom: "Marie", email: "marie@heig-vd.ch" },
      { nom: "Martin", prenom: "Luc", email: "luc@heig-vd.ch" },
    ]);
  });

  it("cellules numériques et vides tolérées, lignes vides ignorées", () => {
    const rows = [
      ["nom", "prenom", "email", "note"],
      ["Dupont", "Marie", "marie@heig-vd.ch", 42],
      [null, null, null, null],
    ];
    expect(ok(rosterFromRows(rows))).toHaveLength(1);
  });

  it("échec explicite quand rien n'est identifiable", () => {
    const e = errs(rosterFromRows([["a", "b"], ["c", "d"]]));
    expect(e[0]?.message).toMatch(/Could not identify/);
  });

  it("les numéros de ligne rapportés sont ceux du document d'origine", () => {
    const rows = [
      ["Titre", "", ""],
      ["nom", "prenom", "email"],
      ["Dupont", "Marie", "pas-un-email"],
    ];
    expect(errs(rosterFromRows(rows))[0]?.line).toBe(3);
  });
});
