import { describe, expect, it } from "vitest";

import { rowAffordances } from "./StudentHome";
import { DICTS } from "./i18n";

/**
 * Ce que la ligne d'un devoir montre à l'étudiant, mode par mode.
 *
 * Retour du 2026-09-18 sur la vraie vue étudiant : en mode en ligne, le bouton
 * « Ouvrir votre dépôt » n'a pas d'objet (l'étudiant n'a que la lecture, voire
 * rien sous SEB) et la pastille de mode encombrait la ligne du nom. « Démarrer »
 * reste l'action principale. Le mode libre, lui, ne bouge pas d'un pixel.
 */
describe("rowAffordances", () => {
  const free = { workMode: "free" as const, accepted: true, locked: false };
  const online = { workMode: "online" as const, accepted: true, locked: false };
  const seb = { workMode: "online_seb" as const, accepted: true, locked: false };

  it("mode libre : rendu inchangé — nom cliquable et bouton du dépôt, pas de Démarrer", () => {
    expect(rowAffordances(free)).toEqual({
      nameIsLink: true,
      repoButton: true,
      startButton: false,
      modeNote: null,
    });
  });

  it("mode libre non accepté : ni lien ni bouton", () => {
    expect(rowAffordances({ ...free, accepted: false })).toEqual({
      nameIsLink: false,
      repoButton: false,
      startButton: false,
      modeNote: null,
    });
  });

  it("mode en ligne : plus de bouton « Ouvrir votre dépôt », Démarrer et lien discret", () => {
    expect(rowAffordances(online)).toEqual({
      nameIsLink: true,
      repoButton: false,
      startButton: true,
      modeNote: "student.workspace",
    });
  });

  it("mode examen : aucun accès au dépôt, pas même le lien du nom", () => {
    expect(rowAffordances(seb)).toEqual({
      nameIsLink: false,
      repoButton: false,
      startButton: true,
      modeNote: "student.workspaceSeb",
    });
  });

  it("devoir verrouillé : Démarrer disparaît, la mention du mode reste", () => {
    expect(rowAffordances({ ...online, locked: true }).startButton).toBe(false);
    expect(rowAffordances({ ...online, locked: true }).modeNote).toBe("student.workspace");
    expect(rowAffordances({ ...seb, locked: true }).startButton).toBe(false);
  });

  it("le bouton du dépôt n'existe que dans le mode où il sert", () => {
    for (const mode of ["free", "online", "online_seb"] as const) {
      const a = rowAffordances({ workMode: mode, accepted: true, locked: false });
      expect(a.repoButton).toBe(mode === "free");
      expect(a.startButton).toBe(mode !== "free");
    }
  });

  it("la mention du mode est traduite en anglais et en français", () => {
    for (const key of ["student.workspace", "student.workspaceSeb"] as const) {
      expect(DICTS.en[key]).toBeTruthy();
      expect(DICTS.fr[key]).toBeTruthy();
      expect(DICTS.fr[key]).not.toBe(DICTS.en[key]);
    }
  });
});
