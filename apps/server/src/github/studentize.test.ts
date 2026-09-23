import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyStudentHandout, parseStudentIgnore } from "./studentize.js";

/*
 * The linked-list lab of 2026-09-23 reached students with its solution: the
 * repository carried a `student/` overlay and a studentize workflow that
 * nothing triggered. The squash now applies the overlay itself.
 */

let dir: string;
const write = (rel: string, content: string) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
};
const read = (rel: string) => readFileSync(join(dir, rel), "utf8");
const has = (rel: string) => existsSync(join(dir, rel));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hgc-studentize-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseStudentIgnore", () => {
  it("keeps plain relative paths and drops comments and blanks", () => {
    expect(parseStudentIgnore("# teacher only\n\nscripts/\n/.github/workflows/studentize.yml\r\n")).toEqual([
      "scripts",
      ".github/workflows/studentize.yml",
    ]);
  });

  it("refuses anything that leaves the tree or touches git", () => {
    expect(parseStudentIgnore("../outside\na/../../b\n.git\n.git/config\n./x\n/\n")).toEqual([]);
  });
});

describe("applyStudentHandout", () => {
  it("replaces the solution with the overlay and drops teacher-only paths", () => {
    write("main.cpp", "// solution");
    write("tests/test_main.py", "tests");
    write("student/main.cpp", "// TODO");
    write("scripts/studentize.sh", "#!/bin/sh");
    write(".github/workflows/studentize.yml", "on: workflow_dispatch");
    write(".github/workflows/grading.yml", "on: push");
    write(".studentignore", "scripts/\n.github/workflows/studentize.yml\n");

    const res = applyStudentHandout(dir);

    expect(res.overlaid).toBe(true);
    expect(read("main.cpp")).toBe("// TODO");
    expect(read("tests/test_main.py")).toBe("tests");
    expect(read(".github/workflows/grading.yml")).toBe("on: push");
    for (const gone of ["student", "scripts", ".github/workflows/studentize.yml", ".studentignore"]) {
      expect(has(gone)).toBe(false);
    }
  });

  it("leaves a repository without conventions untouched", () => {
    write("main.cpp", "// starter");
    expect(applyStudentHandout(dir)).toEqual({ overlaid: false, removed: [] });
    expect(read("main.cpp")).toBe("// starter");
  });

  it("merges nested overlay directories instead of replacing them", () => {
    write("src/a.c", "solution a");
    write("src/b.c", "given b");
    write("student/src/a.c", "stub a");
    applyStudentHandout(dir);
    expect(read("src/a.c")).toBe("stub a");
    expect(read("src/b.c")).toBe("given b");
  });

  it("keeps committed symlinks relative", () => {
    write("student/lib/real.h", "h");
    symlinkSync("real.h", join(dir, "student/lib/link.h"));
    applyStudentHandout(dir);
    expect(readlinkSync(join(dir, "lib/link.h"))).toBe("real.h");
  });

  it("never follows a symlink out of the tree to delete something", () => {
    const outside = mkdtempSync(join(tmpdir(), "hgc-studentize-outside-"));
    try {
      writeFileSync(join(outside, "precious"), "keep");
      symlinkSync(outside, join(dir, "escape"));
      write(".studentignore", "escape/precious\n");
      applyStudentHandout(dir);
      expect(readFileSync(join(outside, "precious"), "utf8")).toBe("keep");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("ignores a `student` symlink: it is not an overlay", () => {
    const outside = mkdtempSync(join(tmpdir(), "hgc-studentize-outside-"));
    try {
      writeFileSync(join(outside, "main.cpp"), "foreign");
      write("main.cpp", "// starter");
      symlinkSync(outside, join(dir, "student"));
      expect(applyStudentHandout(dir).overlaid).toBe(false);
      expect(read("main.cpp")).toBe("// starter");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
