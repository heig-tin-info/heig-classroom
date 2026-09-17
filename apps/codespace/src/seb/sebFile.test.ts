import { describe, expect, it } from "vitest";

import { configKey } from "./configKey.js";
import { parsePlist, type SebValue } from "./plist.js";
import {
  buildSebConfig,
  configKeyOfSebFile,
  newExamKeySalt,
  renderSebFile,
  sebFilePath,
  sebLink,
  sebStartPath,
  type SebConfigInput,
} from "./sebFile.js";

const INPUT: SebConfigInput = {
  startUrl: "https://codespace.heig-vd.ch/exam/a1/start",
  quitUrl: "https://codespace.heig-vd.ch/exam/a1/fini",
  examKeySalt: "QJAqvg89YMP6JagAshUm6QqpqpsrVS9ZWUYjdZhfEao=",
};

function entry(root: SebValue, key: string): SebValue | undefined {
  if (root.kind !== "dict") return undefined;
  return root.value.find(([k]) => k === key)?.[1];
}

describe("génération du .seb", () => {
  it("le fichier est un plist XML non chiffré", () => {
    const { xml } = renderSebFile(INPUT);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<plist version=\"1.0\">");
    expect(() => parsePlist(xml)).not.toThrow();
  });

  it("porte les réglages exigés par le jalon", () => {
    const config = buildSebConfig(INPUT);
    expect(entry(config, "startURL")).toEqual({ kind: "string", value: INPUT.startUrl });
    expect(entry(config, "quitURL")).toEqual({ kind: "string", value: INPUT.quitUrl });
    expect(entry(config, "URLFilterEnable")).toEqual({ kind: "bool", value: true });
    expect(entry(config, "allowDownUploads")).toEqual({ kind: "bool", value: false });
    expect(entry(config, "enablePrivateClipboard")).toEqual({ kind: "bool", value: true });
    expect(entry(config, "sendBrowserExamKey")).toEqual({ kind: "bool", value: true });
    expect(entry(config, "examKeySalt")).toEqual({ kind: "data", value: INPUT.examKeySalt });
  });

  it("n'autorise que le domaine du portail", () => {
    const rules = entry(buildSebConfig(INPUT), "URLFilterRules");
    expect(rules?.kind).toBe("array");
    if (rules?.kind !== "array") throw new Error("URLFilterRules doit être un tableau");
    const expressions = rules.value.map((rule) =>
      rule.kind === "dict" ? rule.value.find(([k]) => k === "expression")?.[1] : undefined,
    );
    expect(expressions).toEqual([{ kind: "string", value: "codespace.heig-vd.ch" }]);
  });

  it("n'écrit jamais de Browser Exam Key dans le fichier remis à l'étudiant", () => {
    // project.md § 9 : « Le BEK ne doit jamais être exposé côté client ».
    const { xml } = renderSebFile(INPUT);
    expect(entry(buildSebConfig(INPUT), "browserExamKey")).toEqual({ kind: "string", value: "" });
    expect(xml).toContain("<key>browserExamKey</key>");
    expect(xml).toContain("<key>browserExamKey</key>\n  <string></string>");
  });

  it("idempotence : recharger le fichier généré redonne la même Config Key", () => {
    const { xml, configKey: cle } = renderSebFile(INPUT);
    expect(configKeyOfSebFile(xml)).toBe(cle);
    // Et un second aller-retour ne bouge pas non plus.
    expect(configKeyOfSebFile(xml)).toBe(configKey(parsePlist(xml)));
  });

  it("la génération est déterministe pour une même entrée", () => {
    expect(renderSebFile(INPUT)).toEqual(renderSebFile(INPUT));
  });

  it("changer un seul réglage change la Config Key", () => {
    const autre = renderSebFile({ ...INPUT, quitUrl: `${INPUT.quitUrl}/` });
    expect(autre.configKey).not.toBe(renderSebFile(INPUT).configKey);
  });

  it("un hôte autorisé de plus change la Config Key", () => {
    const avecMiroir = renderSebFile({ ...INPUT, extraAllowedHosts: ["docs.heig-vd.ch"] });
    expect(avecMiroir.configKey).not.toBe(renderSebFile(INPUT).configKey);
    expect(avecMiroir.xml).toContain("docs.heig-vd.ch");
  });

  it("deux sels différents donnent deux Config Keys différentes", () => {
    const a = renderSebFile({ ...INPUT, examKeySalt: newExamKeySalt() });
    const b = renderSebFile({ ...INPUT, examKeySalt: newExamKeySalt() });
    expect(a.configKey).not.toBe(b.configKey);
  });

  it("newExamKeySalt produit du base64 de 32 octets", () => {
    const salt = newExamKeySalt();
    expect(Buffer.from(salt, "base64")).toHaveLength(32);
  });
});

describe("lien sebs://", () => {
  it("https devient sebs, en gardant hôte et chemin", () => {
    expect(sebLink("https://codespace.heig-vd.ch", "a1")).toBe(
      "sebs://codespace.heig-vd.ch/exam/a1.seb",
    );
  });

  it("http devient seb, comme link_generator::get_link()", () => {
    expect(sebLink("http://localhost:3000", "a1")).toBe("seb://localhost:3000/exam/a1.seb");
  });

  it("le chemin du lien est celui de la route", () => {
    expect(sebLink("https://h", "a1").endsWith(sebFilePath("a1"))).toBe(true);
    expect(sebStartPath("a1")).toBe("/exam/a1/start");
  });

  it("un identifiant de devoir est échappé", () => {
    expect(sebLink("https://h", "a/1")).toBe("sebs://h/exam/a%2F1.seb");
  });
});
