import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SESSION_LABEL, createEngine } from "./index.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const RUN_HARDENED = readFileSync(`${REPO_ROOT}images/c-dev/run-hardened.sh`, "utf8");

const engine = createEngine({
  podmanUrl: "unix:///run/podman/podman.sock",
  network: "codespace",
  gateway: "10.77.0.254",
  seccompProfile: "/repo/infra/seccomp/codespace.json",
  image: "codespace/c-dev:4.137.0",
  memory: "1536m",
  cpus: "1",
  pidsLimit: 256,
});

const args = engine.runArgs({
  sessionId: "s1",
  name: "cs-s1",
  workDir: "/vol/student/tp/work",
});

/** `--x a` ou `--x=a` : les deux formes existent dans run-hardened.sh. */
function hasOption(argv: string[], name: string, value?: string): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === `${name}=${value}`) return true;
    if (a === name) {
      if (value === undefined) return true;
      if (argv[i + 1] === value) return true;
    }
    if (value === undefined && a.startsWith(`${name}=`)) return true;
  }
  return false;
}

describe("engine.runArgs — invariant 3, le durcissement vient de run-hardened.sh", () => {
  // Le test ne réécrit pas la liste : il la *lit* dans le script de P1, pour
  // qu'un durcissement retiré là-bas fasse échouer le portail ici.
  const required = [
    "--userns=auto",
    "--cap-drop=ALL",
    "--read-only",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "--memory",
    "--cpus",
    "/run:rw,nosuid,nodev,mode=1777",
    "/home/student/.cache:rw,nosuid,nodev,mode=1777",
  ];

  for (const option of required) {
    it(`reprend ${option}, que run-hardened.sh impose`, () => {
      expect(RUN_HARDENED).toContain(option);
      expect(args.join(" ")).toContain(option);
    });
  }

  it("monte le tmpfs /tmp", () => {
    expect(hasOption(args, "--tmpfs", "/tmp")).toBe(true);
  });

  it("passe le profil seccomp du projet", () => {
    expect(hasOption(args, "--security-opt", "seccomp=/repo/infra/seccomp/codespace.json")).toBe(
      true,
    );
  });

  it("monte le volume en :U, jamais autrement", () => {
    expect(hasOption(args, "-v", "/vol/student/tp/work:/work:U")).toBe(true);
    // La négation compte autant : un montage sans `:U` laisserait l'étudiant
    // sans droit d'écriture sur son propre volume (analyse.md D6).
    expect(args.filter((a) => a.includes(":/work")).every((a) => a.endsWith(":U"))).toBe(true);
  });
});

describe("engine.runArgs — invariant 2, réseau clos", () => {
  it("attache le réseau codespace sans DNS", () => {
    expect(hasOption(args, "--network", "codespace")).toBe(true);
    expect(hasOption(args, "--dns=none")).toBe(true);
  });

  it("déclare portal.internal sur la passerelle du pont", () => {
    expect(hasOption(args, "--add-host", "portal.internal:10.77.0.254")).toBe(true);
  });
});

describe("engine.runArgs — étiquetage", () => {
  it("marque la session, et c'est la seule marque que le moteur regarde", () => {
    expect(hasOption(args, "--label", `${SESSION_LABEL}=s1`)).toBe(true);
    expect(SESSION_LABEL).toBe("heig-codespace.session");
  });

  it("ne porte pas le label d'ancrage : l'ancrage n'est jamais une session", () => {
    expect(args.join(" ")).not.toContain("heig-codespace.role=anchor");
  });

  it("laisse le devoir imposer son image", () => {
    const other = engine.runArgs({
      sessionId: "s2",
      name: "cs-s2",
      workDir: "/vol/a/b/work",
      image: "codespace/rust-dev:1",
    });
    expect(other.at(-1)).toBe("codespace/rust-dev:1");
    expect(args.at(-1)).toBe("codespace/c-dev:4.137.0");
  });
});
