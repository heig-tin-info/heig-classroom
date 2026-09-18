import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { configKey, configKeyFromPlistXml, sebJson } from "./configKey.js";
import { array, bool, dict, int, parsePlist, str, toPlistXml } from "./plist.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

/**
 * The expected values all come from the test suite of `quizaccess_seb`, never
 * from this code. See fixtures/PROVENANCE.md.
 * <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/tests/config_key_test.php>
 */
describe("Config Key: vectors of the reference implementation", () => {
  it("empty configuration (config_key_test::test_config_key_hash_generated_with_empty_string)", () => {
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

  it("the intermediate SEB-JSON string is identical to the Moodle fixture", () => {
    // A finer vector than the hash: a divergence in sorting or escaping reads
    // straight off the diff.
    expect(sebJson(parsePlist(fixture("unencrypted_mac_001.seb")))).toBe(
      fixture("JSON_unencrypted_mac_001.txt"),
    );
  });

  it("originatorVersion does not change the key (test_presence_of_originator_version_does_not_effect_hash)", () => {
    const withIt = configKeyFromPlistXml(fixture("simpleunencrypted.seb"));
    const without = configKeyFromPlistXml(fixture("simpleunencryptedwithoutoriginator.seb"));
    expect(withIt).toBe(without);
  });

  it("invalid XML is refused", () => {
    expect(() => configKeyFromPlistXml("<?xml This is some bad xml for sure.")).toThrow();
  });
});

describe("Config Key: sensitivity to the settings", () => {
  const base = dict([
    ["allowDownUploads", bool(false)],
    ["startURL", str("https://portal.example.org/exam/a1/start")],
    ["allowedDisplaysMaxNumber", int(1)],
  ]);

  it("changing a single setting changes the key", () => {
    const modified = dict([
      ["allowDownUploads", bool(true)],
      ["startURL", str("https://portal.example.org/exam/a1/start")],
      ["allowedDisplaysMaxNumber", int(1)],
    ]);
    expect(configKey(modified)).not.toBe(configKey(base));
  });

  it("the declaration order of the keys has no effect", () => {
    const permuted = dict([
      ["startURL", str("https://portal.example.org/exam/a1/start")],
      ["allowedDisplaysMaxNumber", int(1)],
      ["allowDownUploads", bool(false)],
    ]);
    expect(configKey(permuted)).toBe(configKey(base));
  });

  it("one extra character in a URL rule changes the key", () => {
    const a = dict([["URLFilterRules", array([dict([["expression", str("portal.example.org")]])])]]);
    const b = dict([
      ["URLFilterRules", array([dict([["expression", str("portal.example.org/")]])])],
    ]);
    expect(configKey(a)).not.toBe(configKey(b));
  });
});

describe("Config Key: normalisation rules", () => {
  it("case-sensitive UCA sort: allowWlan before allowWLAN (rule 3)", () => {
    const value = dict([
      ["allowWLAN", bool(true)],
      ["allowWlan", bool(false)],
    ]);
    expect(sebJson(value)).toBe('{"allowWlan":false,"allowWLAN":true}');
  });

  it("nested dictionaries are sorted as well (rule 3)", () => {
    const value = dict([
      ["z", dict([["b", int(2)], ["a", int(1)]])],
      ["a", int(0)],
    ]);
    expect(sebJson(value)).toBe('{"a":0,"z":{"a":1,"b":2}}');
  });

  it("empty dictionaries disappear, in cascade (rule 4)", () => {
    const value = dict([
      ["keep", int(1)],
      ["empty", dict([])],
      ["nested", dict([["inner", dict([])]])],
    ]);
    expect(sebJson(value)).toBe('{"keep":1}');
  });

  it("empty arrays are kept (rule 4 only speaks of dicts)", () => {
    expect(sebJson(dict([["additionalResources", array([])]]))).toBe(
      '{"additionalResources":[]}',
    );
  });

  it("the empty configuration serialises to [] and not to {}", () => {
    // A consequence of json_encode() on an empty PHP array, see configKey.ts.
    expect(sebJson(dict([]))).toBe("[]");
  });

  it("the backslashes of URL rules are not escaped (rule 2)", () => {
    expect(sebJson(dict([["expression", str("a\\d+b")]]))).toBe('{"expression":"a\\d+b"}');
  });

  it("forward slashes are not escaped (JSON_UNESCAPED_SLASHES)", () => {
    expect(sebJson(dict([["startURL", str("https://x/y")]]))).toBe(
      '{"startURL":"https://x/y"}',
    );
  });

  it("unicode stays literal (JSON_UNESCAPED_UNICODE, rule 5)", () => {
    expect(sebJson(dict([["k", str("éé")]]))).toBe('{"k":"éé"}');
  });

  it("binary data becomes its base64 text (rule 7)", () => {
    const xml = toPlistXml(
      dict([["examKeySalt", { kind: "data", value: "QJAqvg89YMP6JagAshUm6QqpqpsrVS9ZWUYjdZhfEao=" }]]),
    );
    expect(sebJson(parsePlist(xml))).toBe(
      '{"examKeySalt":"QJAqvg89YMP6JagAshUm6QqpqpsrVS9ZWUYjdZhfEao="}',
    );
  });

  it("originatorVersion is stripped at every depth", () => {
    const value = dict([
      ["a", int(1)],
      ["originatorVersion", str("SEB_Win_2.1.1")],
      ["sub", dict([["originatorVersion", str("x")], ["b", int(2)]])],
    ]);
    expect(sebJson(value)).toBe('{"a":1,"sub":{"b":2}}');
  });
});
