import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../auth/config.js";
import { SESSION_LABEL, createEngine } from "./index.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RUN_HARDENED = readFileSync(`${REPO_ROOT}images/c-dev/run-hardened.sh`, "utf8");

const engine = createEngine({
  podmanUrl: "unix:///run/podman/podman.sock",
  network: "codespace",
  gateway: "10.77.0.254",
  seccompProfile: "/repo/infra/seccomp/codespace.json",
  apparmorProfile: "codespace",
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

/** `--x a` or `--x=a`: both forms exist in run-hardened.sh. */
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

describe("engine.runArgs — invariant 3, the hardening comes from run-hardened.sh", () => {
  // The test does not rewrite the list: it *reads* it from the P1 script, so
  // that a hardening option removed over there makes the portal fail here.
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
    it(`reuses ${option}, which run-hardened.sh mandates`, () => {
      expect(RUN_HARDENED).toContain(option);
      expect(args.join(" ")).toContain(option);
    });
  }

  it("mounts the /tmp tmpfs", () => {
    expect(hasOption(args, "--tmpfs", "/tmp")).toBe(true);
  });

  it("passes the project seccomp profile", () => {
    expect(hasOption(args, "--security-opt", "seccomp=/repo/infra/seccomp/codespace.json")).toBe(
      true,
    );
  });

  it("passes the project AppArmor profile, with the same default as the script", () => {
    // The script's value is read here rather than restated: `codespace` is the
    // default on both sides, and a change on one side must fail on the other.
    const declared = /^APPARMOR="\$\{APPARMOR-([A-Za-z0-9_.-]+)\}"$/m.exec(RUN_HARDENED);
    expect(declared, "run-hardened.sh no longer declares an APPARMOR default").not.toBeNull();
    expect(declared?.[1]).toBe("codespace");
    expect(RUN_HARDENED).toContain('--security-opt "apparmor=${APPARMOR}"');
    expect(hasOption(args, "--security-opt", `apparmor=${declared?.[1]}`)).toBe(true);
  });

  it("passes no AppArmor flag when the profile is empty: a host without AppArmor", () => {
    // `CODESPACE_APPARMOR_PROFILE=` on the WSL2 workstation. Podman would
    // refuse a profile name the kernel has not loaded, so the flag must go.
    for (const apparmorProfile of ["", undefined]) {
      const bare = createEngine({
        podmanUrl: "unix:///run/podman/podman.sock",
        network: "codespace",
        gateway: "10.77.0.254",
        seccompProfile: "/repo/infra/seccomp/codespace.json",
        apparmorProfile,
        image: "codespace/c-dev:4.137.0",
        memory: "1536m",
        cpus: "1",
        pidsLimit: 256,
      }).runArgs({ sessionId: "s1", name: "cs-s1", workDir: "/vol/a/b/work" });
      expect(bare.some((a) => a.startsWith("apparmor="))).toBe(false);
      // …and nothing else is lost along the way: seccomp is still there.
      expect(hasOption(bare, "--security-opt", "seccomp=/repo/infra/seccomp/codespace.json")).toBe(
        true,
      );
    }
    // run-hardened.sh has the same escape hatch: `APPARMOR=` drops the flag.
    // `${APPARMOR-…}`, not `${APPARMOR:-…}`, is what makes an empty value stick.
    expect(RUN_HARDENED).toContain('if [ -n "$APPARMOR" ]; then');
  });

  it("mounts the volume with :U, never otherwise", () => {
    expect(hasOption(args, "-v", "/vol/student/tp/work:/work:U")).toBe(true);
    // The negation matters just as much: a mount without `:U` would leave the
    // student without write access to their own volume (analyse.md D6).
    expect(args.filter((a) => a.includes(":/work")).every((a) => a.endsWith(":U"))).toBe(true);
  });
});

describe("CODESPACE_APPARMOR_PROFILE", () => {
  it("defaults to the profile of infra/apparmor/codespace", () => {
    expect(loadConfig({}).CODESPACE_APPARMOR_PROFILE).toBe("codespace");
  });

  it("accepts the empty string, which is how a host without AppArmor opts out", () => {
    expect(loadConfig({ CODESPACE_APPARMOR_PROFILE: "" }).CODESPACE_APPARMOR_PROFILE).toBe("");
  });
});

describe("engine.runArgs — invariant 2, closed network", () => {
  it("attaches the codespace network without DNS", () => {
    expect(hasOption(args, "--network", "codespace")).toBe(true);
    expect(hasOption(args, "--dns=none")).toBe(true);
  });

  it("declares portal.internal on the bridge gateway", () => {
    expect(hasOption(args, "--add-host", "portal.internal:10.77.0.254")).toBe(true);
  });
});

describe("engine.runArgs — labelling", () => {
  it("marks the session, and that is the only mark the engine looks at", () => {
    expect(hasOption(args, "--label", `${SESSION_LABEL}=s1`)).toBe(true);
    expect(SESSION_LABEL).toBe("heig-codespace.session");
  });

  it("does not carry the anchor label: the anchor is never a session", () => {
    expect(args.join(" ")).not.toContain("heig-codespace.role=anchor");
  });

  it("lets the assignment mandate its image", () => {
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
