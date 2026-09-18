import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";
import { roleFromClaims, safeLogin } from "./oidc.js";
import { AUTH_COOKIE, issueAuthCookie, verifyAuthCookie } from "./session.js";

const SECRET = "a-test-secret-long-enough";

describe("portal session cookie", () => {
  const claims = {
    userId: "u1",
    login: "student",
    role: "student" as const,
    expiresAt: Date.now() + 60_000,
  };

  it("is issued and read back", () => {
    const verdict = verifyAuthCookie(issueAuthCookie(claims, SECRET), SECRET);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.claims.login).toBe("student");
  });

  it("refuses a signature made with another secret", () => {
    const verdict = verifyAuthCookie(issueAuthCookie(claims, SECRET), `${SECRET}-other`);
    expect(verdict).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses a tampered payload — the role is not declarative", () => {
    const cookie = issueAuthCookie(claims, SECRET);
    const [payload, signature] = cookie.split(".");
    const tampered = JSON.parse(Buffer.from(payload as string, "base64url").toString("utf8")) as {
      role: string;
    };
    tampered.role = "teacher";
    const forged = `${Buffer.from(JSON.stringify(tampered), "utf8").toString("base64url")}.${signature}`;
    expect(verifyAuthCookie(forged, SECRET)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses an expired cookie", () => {
    const old = issueAuthCookie({ ...claims, expiresAt: Date.now() - 1 }, SECRET);
    expect(verifyAuthCookie(old, SECRET)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a missing cookie", () => {
    expect(verifyAuthCookie(undefined, SECRET)).toEqual({ ok: false, reason: "missing" });
    expect(AUTH_COOKIE).toBe("cs_auth");
  });

  it("refuses a too-short secret at issuance rather than at verification", () => {
    expect(() => issueAuthCookie(claims, "short")).toThrow();
  });
});

describe("role derived from the claims, never from an environment variable", () => {
  it("reads the realm mapper's claim", () => {
    expect(roleFromClaims({ codespace_roles: ["teacher"] }, "codespace_roles", "teacher")).toBe(
      "teacher",
    );
  });

  it("accepts the fallback on Keycloak's realm_access.roles", () => {
    expect(
      roleFromClaims({ realm_access: { roles: ["offline_access", "teacher"] } }, "absent", "teacher"),
    ).toBe("teacher");
  });

  it("returns student by default: the least powerful role", () => {
    expect(roleFromClaims({}, "codespace_roles", "teacher")).toBe("student");
    expect(roleFromClaims({ codespace_roles: ["student"] }, "codespace_roles", "teacher")).toBe(
      "student",
    );
  });
});

describe("normalization of the institutional login", () => {
  it("keeps an already clean login", () => {
    expect(safeLogin("student")).toBe("student");
  });

  it("cuts an address and normalizes the case", () => {
    expect(safeLogin("Sacha.Student@heig-vd.ch")).toBe("sacha.student");
  });

  it("neutralizes what would escape VOLUMES_ROOT", () => {
    // `git/staging.ts` would refuse these values; we make them harmless first.
    expect(safeLogin("../../etc")).toBe("etc");
    expect(safeLogin("a/b")).toBe("a-b");
  });

  it("refuses rather than inventing an empty login", () => {
    expect(() => safeLogin("@@@")).toThrow();
  });
});

describe("configuration: what is forbidden in production", () => {
  const base = {
    NODE_ENV: "production",
    OIDC_CLIENT_SECRET: "real-secret",
    COOKIE_SECRET: "a-long-production-secret",
    EXAM_COOKIE_SECRET: "another-production-secret",
    SEB_VERIFIER: "real",
    SEB_PUBLIC_ORIGIN: "https://codespace.heig-vd.ch",
  };

  it("accepts a complete production configuration", () => {
    expect(() => loadConfig(base)).not.toThrow();
  });

  it("refuses the simulated SEB verifier (invariant 8, configuration guard)", () => {
    expect(() => loadConfig({ ...base, SEB_VERIFIER: "simulated" })).toThrow(/simulated/);
  });

  it("refuses TRUST_PROXY, which is a test setting", () => {
    expect(() => loadConfig({ ...base, TRUST_PROXY: "1" })).toThrow(/TRUST_PROXY/);
  });

  it("refuses development secrets", () => {
    expect(() =>
      loadConfig({ ...base, COOKIE_SECRET: "dev-cookie-secret-change-me" }),
    ).toThrow(/COOKIE_SECRET/);
    expect(() =>
      loadConfig({ ...base, OIDC_CLIENT_SECRET: "dev-secret-not-for-production" }),
    ).toThrow(/OIDC_CLIENT_SECRET/);
  });

  it("requires SEB_PUBLIC_ORIGIN: nothing from the client enters the computation (analyse.md 4.6)", () => {
    expect(() => loadConfig({ ...base, SEB_PUBLIC_ORIGIN: "" })).toThrow(/SEB_PUBLIC_ORIGIN/);
  });

  it("resolves paths from the repository root, not from the launch directory", () => {
    const config = loadConfig({ SECCOMP_PROFILE: "./infra/seccomp/codespace.json" });
    // The application root is the package.json closest to the module, whatever
    // the name of the repository that hosts it (monorepo or not).
    const appRoot = fileURLToPath(new URL("../../", import.meta.url));
    expect(config.seccompProfile).toBe(resolve(appRoot, "infra/seccomp/codespace.json"));
  });
});
