/**
 * What the portal sets on the student container, and **nothing else**
 * (invariant 1: no secret inside the container).
 *
 * Two levels, both unit tests and without Podman:
 *  - `containerEnvFor`: the decision, assignment by assignment;
 *  - `engine.runArgs`: what the decision becomes as `podman run` arguments, and
 *    the fact that no eighth variable gets in.
 */
import { describe, expect, it } from "vitest";

import { createEngine } from "../engine/index.js";
import type { AssignmentRow, SessionRow } from "../db/schema.js";

import type { UserRow } from "../db/schema.js";

import { CONTAINER_ENV_KEYS, containerEnvFor, gitIdentityOf } from "./manager.js";

const URLS = { classroomUrl: "https://classroom.chevallier.io", publicUrl: "https://code.chevallier.io" };

function assignment(patch: Partial<AssignmentRow> = {}): Pick<AssignmentRow, "title" | "closesAt"> {
  return { title: "TP 3 — pointeurs et tableaux", closesAt: null, ...patch };
}

function session(patch: Partial<SessionRow> = {}): Pick<SessionRow, "launchJti"> {
  return { launchJti: null, ...patch };
}

function user(
  patch: Partial<UserRow> = {},
): Pick<UserRow, "displayName" | "email" | "login"> {
  return {
    displayName: "Pierre Bressy",
    email: "pierre.bressy@heig-vd.ch",
    login: "pierre.bressy",
    ...patch,
  };
}

describe("containerEnvFor — these variables, not one more", () => {
  it("never produces a key outside CONTAINER_ENV_KEYS", () => {
    const env = containerEnvFor(
      session({ launchJti: "jti-1" }),
      assignment({ closesAt: new Date("2026-10-01T12:00:00Z") }),
      URLS,
      user(),
    );
    expect(Object.keys(env).sort()).toEqual([...CONTAINER_ENV_KEYS].sort());
  });

  it("has no secret in its values: no token, no key, no password", () => {
    const env = containerEnvFor(
      session({ launchJti: "jti-1" }),
      assignment({ closesAt: new Date("2026-10-01T12:00:00Z") }),
      URLS,
      user(),
    );
    for (const key of Object.keys(env)) {
      expect(key).toMatch(/^(CODESPACE|GIT)_/);
    }
    expect(Object.values(env).join(" ")).not.toMatch(/token|secret|password|ghs_|ghp_/i);
  });

  it("passes on the assignment deadline in ISO 8601", () => {
    const env = containerEnvFor(session(), assignment({ closesAt: new Date("2026-10-01T12:00:00Z") }), URLS);
    expect(env.CODESPACE_DEADLINE).toBe("2026-10-01T12:00:00.000Z");
  });

  it("passes none on when the assignment has no deadline", () => {
    const env = containerEnvFor(session(), assignment(), URLS);
    expect(env.CODESPACE_DEADLINE).toBeUndefined();
  });

  it("points back to classroom when a launch token opened the session", () => {
    const env = containerEnvFor(session({ launchJti: "jti-1" }), assignment(), URLS);
    expect(env.CODESPACE_RETURN_URL).toBe("https://classroom.chevallier.io/");
  });

  it("points back to the portal for a standalone session", () => {
    const env = containerEnvFor(session(), assignment(), URLS);
    expect(env.CODESPACE_RETURN_URL).toBe("https://code.chevallier.io/");
  });

  it("does not invent a return URL when the origin is not configured", () => {
    expect(containerEnvFor(session(), assignment(), {}).CODESPACE_RETURN_URL).toBeUndefined();
    expect(
      containerEnvFor(session(), assignment(), { publicUrl: "not a URL" }).CODESPACE_RETURN_URL,
    ).toBeUndefined();
  });

  it("passes on the assignment title", () => {
    const env = containerEnvFor(session(), assignment(), URLS);
    expect(env.CODESPACE_ASSIGNMENT_NAME).toBe("TP 3 — pointeurs et tableaux");
  });
});

describe("the student's git identity", () => {
  it("sets author and committer from display_name and email", () => {
    const env = containerEnvFor(session(), assignment(), URLS, user());
    expect(env.GIT_AUTHOR_NAME).toBe("Pierre Bressy");
    expect(env.GIT_AUTHOR_EMAIL).toBe("pierre.bressy@heig-vd.ch");
    expect(env.GIT_COMMITTER_NAME).toBe("Pierre Bressy");
    expect(env.GIT_COMMITTER_EMAIL).toBe("pierre.bressy@heig-vd.ch");
  });

  it("falls back on the institutional login when display_name is empty", () => {
    expect(gitIdentityOf(user({ displayName: "  " }))?.name).toBe("pierre.bressy");
  });

  it("all or nothing: without an address, none of the four variables", () => {
    const env = containerEnvFor(session(), assignment(), URLS, user({ email: "" }));
    expect(gitIdentityOf(user({ email: "" }))).toBeNull();
    expect(Object.keys(env).some((k) => k.startsWith("GIT_"))).toBe(false);
  });

  it("sets none when the session has no known user", () => {
    const env = containerEnvFor(session(), assignment(), URLS);
    expect(Object.keys(env).some((k) => k.startsWith("GIT_"))).toBe(false);
  });
});

describe("engine.runArgs — the container environment carries only these variables", () => {
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

  const env = containerEnvFor(
    session({ launchJti: "jti-1" }),
    assignment({ closesAt: new Date("2026-10-01T12:00:00Z") }),
    URLS,
    user(),
  );
  const args = engine.runArgs({ sessionId: "s1", name: "cs-s1", workDir: "/vol/a/b/work", env });

  /** The values of every `-e` on the command line. */
  function envArgs(argv: string[]): string[] {
    return argv.filter((_, i) => argv[i - 1] === "-e" || argv[i - 1] === "--env");
  }

  it("sets exactly the expected variables", () => {
    expect(envArgs(args).map((a) => a.split("=")[0]).sort()).toEqual([...CONTAINER_ENV_KEYS].sort());
  });

  it("carries the values decided by the session manager", () => {
    expect(envArgs(args)).toContain("CODESPACE_DEADLINE=2026-10-01T12:00:00.000Z");
    expect(envArgs(args)).toContain("CODESPACE_RETURN_URL=https://classroom.chevallier.io/");
    expect(envArgs(args)).toContain("GIT_AUTHOR_NAME=Pierre Bressy");
    expect(envArgs(args)).toContain("GIT_COMMITTER_EMAIL=pierre.bressy@heig-vd.ch");
  });

  it("passes a name with spaces as it is: execFile, no shell", () => {
    const spaced = engine.runArgs({
      sessionId: "s3",
      name: "cs-s3",
      workDir: "/vol/a/b/work",
      env: containerEnvFor(session(), assignment(), URLS, user({ displayName: "Jean-Luc D'Arc" })),
    });
    expect(envArgs(spaced)).toContain("GIT_AUTHOR_NAME=Jean-Luc D'Arc");
  });

  it("never uses --env-file: the list must stay readable in the arguments", () => {
    expect(args).not.toContain("--env-file");
    expect(args.some((a) => a.startsWith("--env-file"))).toBe(false);
  });

  it("sets no variable when the caller gives none", () => {
    const bare = engine.runArgs({ sessionId: "s2", name: "cs-s2", workDir: "/vol/a/b/work" });
    expect(envArgs(bare)).toEqual([]);
  });

  it("leaves the hardening and the volume untouched", () => {
    expect(args).toContain("--userns=auto");
    expect(args).toContain("--read-only");
    expect(args.at(-1)).toBe("codespace/c-dev:4.137.0");
    expect(args).toContain("/vol/a/b/work:/work:U");
  });
});
