import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { FIXTURE_ENV, makeSourceRepo, tempDir } from "./fixtures.js";
import { git, gitAuthEnv, gitBare } from "./gitRunner.js";
import { ensureStagingRepo, refSnapshot, stagingHeadBranch, stagingPaths } from "./staging.js";

const roots: string[] = [];
async function root(): Promise<string> {
  const dir = await tempDir("p3-staging-");
  roots.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

describe("stagingPaths", () => {
  it("puts staging.git next to work/, under <student>/<assignment>", () => {
    const p = stagingPaths("/srv/codespace/volumes", "e1234567", "tp-pointeurs");
    expect(p.dir).toBe("/srv/codespace/volumes/e1234567/tp-pointeurs");
    expect(p.gitDir).toBe("/srv/codespace/volumes/e1234567/tp-pointeurs/staging.git");
    expect(p.workDir).toBe("/srv/codespace/volumes/e1234567/tp-pointeurs/work");
  });

  it("refuses an identifier that would escape VOLUMES_ROOT", () => {
    expect(() => stagingPaths("/srv", "..", "a")).toThrow();
    expect(() => stagingPaths("/srv", "a/../..", "b")).toThrow();
    expect(() => stagingPaths("/srv", "e1", "/etc/passwd")).toThrow();
  });
});

describe("ensureStagingRepo", () => {
  it("lab mode: mirror of the student's repository, upload-pack allowed", async () => {
    const base = await root();
    const src = await makeSourceRepo({
      dir: join(base, "src"),
      files: { "main.c": "int main(void){return 0;}\n" },
      message: "work already pushed from home",
    });
    const staging = await ensureStagingRepo({
      volumesRoot: join(base, "volumes"),
      student: "e1234567",
      assignment: "tp-pointeurs",
      source: { mode: "lab", mirrorFrom: src.gitDir },
    });

    expect(staging.created).toBe(true);
    const refs = await refSnapshot(staging.gitDir);
    expect(refs.get("refs/heads/main")).toBe(src.sha);
    expect((await gitBare(staging.gitDir, ["config", "http.receivepack"])).trim()).toBe("true");
    expect((await gitBare(staging.gitDir, ["config", "http.uploadpack"])).trim()).toBe("true");
    // HEAD points at a real branch, otherwise `git clone` checks nothing out.
    expect((await gitBare(staging.gitDir, ["symbolic-ref", "HEAD"])).trim()).toBe(
      "refs/heads/main",
    );
  });

  it("exam mode: seeded from the template, never from the student's repository", async () => {
    const base = await root();
    const template = await makeSourceRepo({
      dir: join(base, "template"),
      files: { "statement.md": "# Exam\n", "skeleton.c": "int main(void){}\n" },
      message: "teacher's statement",
    });
    const student = await makeSourceRepo({
      dir: join(base, "student"),
      files: { "cheatsheet.txt": "solutions prepared at home\n" },
      message: "forbidden preparation",
    });

    const staging = await ensureStagingRepo({
      volumesRoot: join(base, "volumes"),
      student: "e1234567",
      assignment: "exam-final",
      source: { mode: "exam", templateFrom: template.gitDir },
    });

    const refs = await refSnapshot(staging.gitDir);
    expect(refs.get("refs/heads/main")).toBe(template.sha);
    // Invariant 6: nothing the student prepared at home is reachable here.
    expect([...refs.values()]).not.toContain(student.sha);
    const tree = await gitBare(staging.gitDir, ["ls-tree", "--name-only", "-r", "HEAD"]);
    expect(tree.split("\n").filter(Boolean).sort()).toEqual(["skeleton.c", "statement.md"]);
  });

  it("propagates a statement fix pushed to the template during the exam", async () => {
    const base = await root();
    const template = await makeSourceRepo({
      dir: join(base, "template"),
      files: { "statement.md": "# Exam\n" },
    });
    const opts = {
      volumesRoot: join(base, "volumes"),
      student: "e1234567",
      assignment: "exam-final",
      source: { mode: "exam" as const, templateFrom: template.gitDir },
    };
    const staging = await ensureStagingRepo(opts);

    // The teacher fixes a typo in the statement, mid-exam.
    const clone = join(base, "clone");
    await git(["clone", template.gitDir, clone], { env: FIXTURE_ENV });
    await git(["-C", clone, "commit", "--allow-empty", "-m", "statement fix"], {
      env: FIXTURE_ENV,
    });
    await git(["-C", clone, "push", "origin", "HEAD:main"], { env: FIXTURE_ENV });
    const fixed = (await git(["-C", clone, "rev-parse", "HEAD"], { env: FIXTURE_ENV })).trim();

    const again = await ensureStagingRepo(opts);
    expect(again.created).toBe(false);
    expect((await refSnapshot(staging.gitDir)).get("refs/heads/main")).toBe(fixed);
  });

  it("empty mode: bare repository ready to receive, with no ref at all", async () => {
    const base = await root();
    const staging = await ensureStagingRepo({
      volumesRoot: join(base, "volumes"),
      student: "e1234567",
      assignment: "libre",
      source: { mode: "empty" },
    });
    expect(await refSnapshot(staging.gitDir)).toEqual(new Map());
    expect((await gitBare(staging.gitDir, ["config", "http.receivepack"])).trim()).toBe("true");
  });

  it("returns the number of refs, and zero is not an error", async () => {
    const base = await root();
    const empty = await ensureStagingRepo({
      volumesRoot: join(base, "volumes"),
      student: "e1234567",
      assignment: "libre",
      source: { mode: "empty" },
    });
    expect(empty).toMatchObject({ refs: 0, fetched: false, created: true });
    expect(await stagingHeadBranch(empty.gitDir)).toBeNull();

    const src = await makeSourceRepo({
      dir: join(base, "src"),
      branch: "master",
      files: { "a.c": "int main(void){}\n" },
    });
    const seeded = await ensureStagingRepo({
      volumesRoot: join(base, "volumes"),
      student: "e1234567",
      assignment: "tp",
      source: { mode: "lab", mirrorFrom: src.gitDir },
    });
    expect(seeded).toMatchObject({ refs: 1, fetched: true });
    // `master` just as well as `main`: the branch of the student's repository
    // decides, not a convention of the portal.
    expect(await stagingHeadBranch(seeded.gitDir)).toBe("master");
  });

  it("an unreachable source repository throws: no more silent fallback to an empty repository", async () => {
    const base = await root();
    await expect(
      ensureStagingRepo({
        volumesRoot: join(base, "volumes"),
        student: "e1234567",
        assignment: "tp",
        source: { mode: "lab", mirrorFrom: join(base, "never-created.git") },
      }),
    ).rejects.toThrow();
  });

  /**
   * The point of the 2026-09-17 fix: a student repository provisioned by
   * classroom is **private**, and the seeding `fetch` has to carry the forge
   * authorization — in the environment, never in argv nor on disk. A real
   * private server would be an integration test; here a fake `git` intercepts
   * the `fetch` and writes down what it received.
   */
  it("passes the authorization through the environment, never through argv", async () => {
    const base = await root();
    const bin = join(base, "bin");
    const trace = join(base, "trace.txt");
    await mkdir(bin, { recursive: true });
    const realPath = process.env["PATH"] ?? "/usr/bin:/bin";
    await writeFile(
      join(bin, "git"),
      [
        "#!/bin/sh",
        "for a in \"$@\"; do",
        '  if [ "$a" = "fetch" ]; then',
        `    printf 'ARGV=%s\\nCOUNT=%s\\nKEY0=%s\\nVALUE0=%s\\n' "$*" "$GIT_CONFIG_COUNT" "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_VALUE_0" > ${JSON.stringify(trace)}`,
        "    exit 0",
        "  fi",
        "done",
        // Everything else (`init`, `config`, `for-each-ref`, …) goes to the
        // real git, found through the original PATH.
        `exec env PATH=${JSON.stringify(realPath)} git "$@"`,
      ].join("\n"),
      "utf8",
    );
    await chmod(join(bin, "git"), 0o755);

    const previous = process.env["PATH"];
    process.env["PATH"] = `${bin}:${previous ?? ""}`;
    try {
      await ensureStagingRepo({
        volumesRoot: join(base, "volumes"),
        student: "e1234567",
        assignment: "tp",
        source: { mode: "lab", mirrorFrom: "https://github.com/org/private.git" },
        authorization: "Bearer ghs_installationtoken",
      });
    } finally {
      process.env["PATH"] = previous;
    }

    const seen = await readFile(trace, "utf8");
    expect(seen).toContain("COUNT=1");
    expect(seen).toContain("KEY0=http.extraHeader");
    expect(seen).toContain("VALUE0=Authorization: Bearer ghs_installationtoken");
    const argv = /^ARGV=(.*)$/m.exec(seen)?.[1] ?? "";
    expect(argv).toContain("https://github.com/org/private.git");
    expect(argv).not.toContain("ghs_");
    expect(argv).not.toContain("Authorization");
  });

  it("uploadPack: false becomes http.uploadpack=false in the repository", async () => {
    const base = await root();
    const staging = await ensureStagingRepo({
      volumesRoot: join(base, "volumes"),
      student: "e1234567",
      assignment: "exam-final",
      source: { mode: "empty" },
      uploadPack: false,
    });
    expect((await gitBare(staging.gitDir, ["config", "http.uploadpack"])).trim()).toBe("false");
  });
});
