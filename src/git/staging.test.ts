import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { FIXTURE_ENV, makeSourceRepo, tempDir } from "./fixtures.js";
import { git, gitBare } from "./gitRunner.js";
import { ensureStagingRepo, refSnapshot, stagingPaths } from "./staging.js";

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
  it("place staging.git à côté de work/, sous <étudiant>/<devoir>", () => {
    const p = stagingPaths("/srv/codespace/volumes", "e1234567", "tp-pointeurs");
    expect(p.dir).toBe("/srv/codespace/volumes/e1234567/tp-pointeurs");
    expect(p.gitDir).toBe("/srv/codespace/volumes/e1234567/tp-pointeurs/staging.git");
    expect(p.workDir).toBe("/srv/codespace/volumes/e1234567/tp-pointeurs/work");
  });

  it("refuse un identifiant qui sortirait de VOLUMES_ROOT", () => {
    expect(() => stagingPaths("/srv", "..", "a")).toThrow();
    expect(() => stagingPaths("/srv", "a/../..", "b")).toThrow();
    expect(() => stagingPaths("/srv", "e1", "/etc/passwd")).toThrow();
  });
});

describe("ensureStagingRepo", () => {
  it("mode TP : miroir du dépôt de l'étudiant, upload-pack autorisé", async () => {
    const base = await root();
    const src = await makeSourceRepo({
      dir: join(base, "src"),
      files: { "main.c": "int main(void){return 0;}\n" },
      message: "travail déjà poussé depuis la maison",
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

  it("mode examen : amorcé depuis le modèle, jamais depuis le dépôt de l'étudiant", async () => {
    const base = await root();
    const template = await makeSourceRepo({
      dir: join(base, "modele"),
      files: { "enonce.md": "# Épreuve\n", "squelette.c": "int main(void){}\n" },
      message: "énoncé de l'enseignant",
    });
    const student = await makeSourceRepo({
      dir: join(base, "etudiant"),
      files: { "antiseche.txt": "solutions préparées à la maison\n" },
      message: "préparation interdite",
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
    expect(tree.split("\n").filter(Boolean).sort()).toEqual(["enonce.md", "squelette.c"]);
  });

  it("propage un correctif d'énoncé poussé sur le modèle pendant l'épreuve", async () => {
    const base = await root();
    const template = await makeSourceRepo({
      dir: join(base, "modele"),
      files: { "enonce.md": "# Épreuve\n" },
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
    await git(["-C", clone, "commit", "--allow-empty", "-m", "correctif d'énoncé"], {
      env: FIXTURE_ENV,
    });
    await git(["-C", clone, "push", "origin", "HEAD:main"], { env: FIXTURE_ENV });
    const fixed = (await git(["-C", clone, "rev-parse", "HEAD"], { env: FIXTURE_ENV })).trim();

    const again = await ensureStagingRepo(opts);
    expect(again.created).toBe(false);
    expect((await refSnapshot(staging.gitDir)).get("refs/heads/main")).toBe(fixed);
  });

  it("mode vide : dépôt nu prêt à recevoir, sans aucune ref", async () => {
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

  it("uploadPack: false se traduit par http.uploadpack=false dans le dépôt", async () => {
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
