import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { configKey, configKeyFromPlistXml, sebJson } from "./configKey.js";
import { array, bool, dict, int, parsePlist, str, toPlistXml } from "./plist.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

/**
 * Les valeurs attendues viennent toutes du jeu de tests de `quizaccess_seb`,
 * jamais de ce code. Voir fixtures/PROVENANCE.md.
 * <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/tests/config_key_test.php>
 */
describe("Config Key : vecteurs de l'implémentation de référence", () => {
  it("configuration vide (config_key_test::test_config_key_hash_generated_with_empty_string)", () => {
    expect(configKeyFromPlistXml("")).toBe(
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    );
  });

  it("unencrypted_mac_001.seb (real_ck_hash_provider, 'unencrypted_mac2.1.4')", () => {
    expect(configKeyFromPlistXml(fixture("unencrypted_mac_001.seb"))).toBe(
      "4fa9af8ec8759eb7c680752ef4ee5eaf1a860628608fccae2715d519849f9292",
    );
  });

  it("unencrypted_win_223.seb (real_ck_hash_provider, 'unencrypted_win2.2.3')", () => {
    expect(configKeyFromPlistXml(fixture("unencrypted_win_223.seb"))).toBe(
      "2534e4e9f3188f9f9133bf7cf7b4c5d898292bbd7e8d0230f39d1176636a1431",
    );
  });

  it("la chaîne SEB-JSON intermédiaire est identique à la fixture Moodle", () => {
    // Vecteur plus fin que le haché : une divergence de tri ou d'échappement
    // se lit directement dans le diff.
    expect(sebJson(parsePlist(fixture("unencrypted_mac_001.seb")))).toBe(
      fixture("JSON_unencrypted_mac_001.txt"),
    );
  });

  it("originatorVersion ne change pas la clé (test_presence_of_originator_version_does_not_effect_hash)", () => {
    const avec = configKeyFromPlistXml(fixture("simpleunencrypted.seb"));
    const sans = configKeyFromPlistXml(fixture("simpleunencryptedwithoutoriginator.seb"));
    expect(avec).toBe(sans);
  });

  it("un XML invalide est refusé", () => {
    expect(() => configKeyFromPlistXml("<?xml This is some bad xml for sure.")).toThrow();
  });
});

describe("Config Key : sensibilité aux réglages", () => {
  const base = dict([
    ["allowDownUploads", bool(false)],
    ["startURL", str("https://portal.example.org/exam/a1/start")],
    ["allowedDisplaysMaxNumber", int(1)],
  ]);

  it("modifier un seul réglage change la clé", () => {
    const modifie = dict([
      ["allowDownUploads", bool(true)],
      ["startURL", str("https://portal.example.org/exam/a1/start")],
      ["allowedDisplaysMaxNumber", int(1)],
    ]);
    expect(configKey(modifie)).not.toBe(configKey(base));
  });

  it("l'ordre de déclaration des clés n'a aucun effet", () => {
    const permute = dict([
      ["startURL", str("https://portal.example.org/exam/a1/start")],
      ["allowedDisplaysMaxNumber", int(1)],
      ["allowDownUploads", bool(false)],
    ]);
    expect(configKey(permute)).toBe(configKey(base));
  });

  it("une virgule de plus dans une règle d'URL change la clé", () => {
    const a = dict([["URLFilterRules", array([dict([["expression", str("portal.example.org")]])])]]);
    const b = dict([
      ["URLFilterRules", array([dict([["expression", str("portal.example.org/")]])])],
    ]);
    expect(configKey(a)).not.toBe(configKey(b));
  });
});

describe("Config Key : règles de normalisation", () => {
  it("tri sensible à la casse selon l'UCA : allowWlan avant allowWLAN (règle 3)", () => {
    const value = dict([
      ["allowWLAN", bool(true)],
      ["allowWlan", bool(false)],
    ]);
    expect(sebJson(value)).toBe('{"allowWlan":false,"allowWLAN":true}');
  });

  it("les dictionnaires imbriqués sont triés aussi (règle 3)", () => {
    const value = dict([
      ["z", dict([["b", int(2)], ["a", int(1)]])],
      ["a", int(0)],
    ]);
    expect(sebJson(value)).toBe('{"a":0,"z":{"a":1,"b":2}}');
  });

  it("les dictionnaires vides disparaissent, en cascade (règle 4)", () => {
    const value = dict([
      ["keep", int(1)],
      ["empty", dict([])],
      ["nested", dict([["inner", dict([])]])],
    ]);
    expect(sebJson(value)).toBe('{"keep":1}');
  });

  it("les tableaux vides sont conservés (la règle 4 ne parle que des dict)", () => {
    expect(sebJson(dict([["additionalResources", array([])]]))).toBe(
      '{"additionalResources":[]}',
    );
  });

  it("la configuration vide se sérialise en [] et non en {}", () => {
    // Conséquence de json_encode() sur un tableau PHP vide, cf. configKey.ts.
    expect(sebJson(dict([]))).toBe("[]");
  });

  it("les antislash des règles d'URL ne sont pas échappés (règle 2)", () => {
    expect(sebJson(dict([["expression", str("a\\d+b")]]))).toBe('{"expression":"a\\d+b"}');
  });

  it("les barres obliques ne sont pas échappées (JSON_UNESCAPED_SLASHES)", () => {
    expect(sebJson(dict([["startURL", str("https://x/y")]]))).toBe(
      '{"startURL":"https://x/y"}',
    );
  });

  it("l'unicode reste littéral (JSON_UNESCAPED_UNICODE, règle 5)", () => {
    expect(sebJson(dict([["k", str("éé")]]))).toBe('{"k":"éé"}');
  });

  it("les données binaires deviennent leur texte base64 (règle 7)", () => {
    const xml = toPlistXml(
      dict([["examKeySalt", { kind: "data", value: "QJAqvg89YMP6JagAshUm6QqpqpsrVS9ZWUYjdZhfEao=" }]]),
    );
    expect(sebJson(parsePlist(xml))).toBe(
      '{"examKeySalt":"QJAqvg89YMP6JagAshUm6QqpqpsrVS9ZWUYjdZhfEao="}',
    );
  });

  it("originatorVersion est retiré à toute profondeur", () => {
    const value = dict([
      ["a", int(1)],
      ["originatorVersion", str("SEB_Win_2.1.1")],
      ["sub", dict([["originatorVersion", str("x")], ["b", int(2)]])],
    ]);
    expect(sebJson(value)).toBe('{"a":1,"sub":{"b":2}}');
  });
});
