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
  quitUrl: "https://codespace.heig-vd.ch/exam/a1/done",
  examKeySalt: "QJAqvg89YMP6JagAshUm6QqpqpsrVS9ZWUYjdZhfEao=",
};

function entry(root: SebValue, key: string): SebValue | undefined {
  if (root.kind !== "dict") return undefined;
  return root.value.find(([k]) => k === key)?.[1];
}

describe("generation of the .seb file", () => {
  it("the file is an unencrypted XML plist", () => {
    const { xml } = renderSebFile(INPUT);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<plist version=\"1.0\">");
    expect(() => parsePlist(xml)).not.toThrow();
  });

  it("carries the settings the milestone requires", () => {
    const config = buildSebConfig(INPUT);
    expect(entry(config, "startURL")).toEqual({ kind: "string", value: INPUT.startUrl });
    expect(entry(config, "quitURL")).toEqual({ kind: "string", value: INPUT.quitUrl });
    expect(entry(config, "URLFilterEnable")).toEqual({ kind: "bool", value: true });
    expect(entry(config, "allowDownUploads")).toEqual({ kind: "bool", value: false });
    expect(entry(config, "enablePrivateClipboard")).toEqual({ kind: "bool", value: true });
    expect(entry(config, "sendBrowserExamKey")).toEqual({ kind: "bool", value: true });
    expect(entry(config, "examKeySalt")).toEqual({ kind: "data", value: INPUT.examKeySalt });
  });

  it("allows the portal domain and nothing else", () => {
    const rules = entry(buildSebConfig(INPUT), "URLFilterRules");
    expect(rules?.kind).toBe("array");
    if (rules?.kind !== "array") throw new Error("URLFilterRules must be an array");
    const expressions = rules.value.map((rule) =>
      rule.kind === "dict" ? rule.value.find(([k]) => k === "expression")?.[1] : undefined,
    );
    expect(expressions).toEqual([{ kind: "string", value: "codespace.heig-vd.ch" }]);
  });

  it("never writes a Browser Exam Key into the file handed to the student", () => {
    // project.md § 9: the BEK must never be exposed on the client side.
    const { xml } = renderSebFile(INPUT);
    expect(entry(buildSebConfig(INPUT), "browserExamKey")).toEqual({ kind: "string", value: "" });
    expect(xml).toContain("<key>browserExamKey</key>");
    expect(xml).toContain("<key>browserExamKey</key>\n  <string></string>");
  });

  it("idempotence: reloading the generated file gives the same Config Key back", () => {
    const { xml, configKey: key } = renderSebFile(INPUT);
    expect(configKeyOfSebFile(xml)).toBe(key);
    // And a second round trip does not move either.
    expect(configKeyOfSebFile(xml)).toBe(configKey(parsePlist(xml)));
  });

  it("generation is deterministic for the same input", () => {
    expect(renderSebFile(INPUT)).toEqual(renderSebFile(INPUT));
  });

  it("changing a single setting changes the Config Key", () => {
    const other = renderSebFile({ ...INPUT, quitUrl: `${INPUT.quitUrl}/` });
    expect(other.configKey).not.toBe(renderSebFile(INPUT).configKey);
  });

  it("one more allowed host changes the Config Key", () => {
    const withMirror = renderSebFile({ ...INPUT, extraAllowedHosts: ["docs.heig-vd.ch"] });
    expect(withMirror.configKey).not.toBe(renderSebFile(INPUT).configKey);
    expect(withMirror.xml).toContain("docs.heig-vd.ch");
  });

  it("two different salts give two different Config Keys", () => {
    const a = renderSebFile({ ...INPUT, examKeySalt: newExamKeySalt() });
    const b = renderSebFile({ ...INPUT, examKeySalt: newExamKeySalt() });
    expect(a.configKey).not.toBe(b.configKey);
  });

  it("newExamKeySalt produces base64 of 32 bytes", () => {
    const salt = newExamKeySalt();
    expect(Buffer.from(salt, "base64")).toHaveLength(32);
  });
});

describe("sebs:// link", () => {
  it("https becomes sebs, keeping host and path", () => {
    expect(sebLink("https://codespace.heig-vd.ch", "a1")).toBe(
      "sebs://codespace.heig-vd.ch/exam/a1.seb",
    );
  });

  it("http becomes seb, like link_generator::get_link()", () => {
    expect(sebLink("http://localhost:3000", "a1")).toBe("seb://localhost:3000/exam/a1.seb");
  });

  it("the path of the link is the one of the route", () => {
    expect(sebLink("https://h", "a1").endsWith(sebFilePath("a1"))).toBe(true);
    expect(sebStartPath("a1")).toBe("/exam/a1/start");
  });

  it("an assignment identifier is escaped", () => {
    expect(sebLink("https://h", "a/1")).toBe("sebs://h/exam/a%2F1.seb");
  });
});
