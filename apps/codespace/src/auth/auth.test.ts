import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";
import { roleFromClaims, safeLogin } from "./oidc.js";
import { AUTH_COOKIE, issueAuthCookie, verifyAuthCookie } from "./session.js";

const SECRET = "un-secret-de-test-assez-long";

describe("cookie de session du portail", () => {
  const claims = {
    userId: "u1",
    login: "student",
    role: "student" as const,
    expiresAt: Date.now() + 60_000,
  };

  it("s'émet et se relit", () => {
    const verdict = verifyAuthCookie(issueAuthCookie(claims, SECRET), SECRET);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.claims.login).toBe("student");
  });

  it("refuse une signature d'un autre secret", () => {
    const verdict = verifyAuthCookie(issueAuthCookie(claims, SECRET), `${SECRET}-autre`);
    expect(verdict).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuse une charge utile modifiée — le rôle n'est pas déclaratif", () => {
    const cookie = issueAuthCookie(claims, SECRET);
    const [payload, signature] = cookie.split(".");
    const tampered = JSON.parse(Buffer.from(payload as string, "base64url").toString("utf8")) as {
      role: string;
    };
    tampered.role = "teacher";
    const forged = `${Buffer.from(JSON.stringify(tampered), "utf8").toString("base64url")}.${signature}`;
    expect(verifyAuthCookie(forged, SECRET)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuse un cookie échu", () => {
    const old = issueAuthCookie({ ...claims, expiresAt: Date.now() - 1 }, SECRET);
    expect(verifyAuthCookie(old, SECRET)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuse l'absence de cookie", () => {
    expect(verifyAuthCookie(undefined, SECRET)).toEqual({ ok: false, reason: "missing" });
    expect(AUTH_COOKIE).toBe("cs_auth");
  });

  it("refuse un secret trop court à l'émission plutôt qu'à la vérification", () => {
    expect(() => issueAuthCookie(claims, "court")).toThrow();
  });
});

describe("rôle déduit des revendications, jamais d'une variable d'environnement", () => {
  it("lit la revendication du mappeur de realm", () => {
    expect(roleFromClaims({ codespace_roles: ["teacher"] }, "codespace_roles", "teacher")).toBe(
      "teacher",
    );
  });

  it("accepte le repli sur realm_access.roles de Keycloak", () => {
    expect(
      roleFromClaims({ realm_access: { roles: ["offline_access", "teacher"] } }, "absent", "teacher"),
    ).toBe("teacher");
  });

  it("rend student par défaut : le moins puissant", () => {
    expect(roleFromClaims({}, "codespace_roles", "teacher")).toBe("student");
    expect(roleFromClaims({ codespace_roles: ["student"] }, "codespace_roles", "teacher")).toBe(
      "student",
    );
  });
});

describe("normalisation de l'identifiant institutionnel", () => {
  it("garde un identifiant déjà propre", () => {
    expect(safeLogin("student")).toBe("student");
  });

  it("coupe une adresse et normalise la casse", () => {
    expect(safeLogin("Sacha.Student@heig-vd.ch")).toBe("sacha.student");
  });

  it("neutralise ce qui sortirait de VOLUMES_ROOT", () => {
    // `git/staging.ts` refuserait ces valeurs ; on les rend inoffensives avant.
    expect(safeLogin("../../etc")).toBe("etc");
    expect(safeLogin("a/b")).toBe("a-b");
  });

  it("refuse plutôt que d'inventer un identifiant vide", () => {
    expect(() => safeLogin("@@@")).toThrow();
  });
});

describe("configuration : ce qui est interdit en production", () => {
  const base = {
    NODE_ENV: "production",
    OIDC_CLIENT_SECRET: "vrai-secret",
    COOKIE_SECRET: "un-secret-de-production-long",
    EXAM_COOKIE_SECRET: "un-autre-secret-de-production",
    SEB_VERIFIER: "real",
    SEB_PUBLIC_ORIGIN: "https://codespace.heig-vd.ch",
  };

  it("accepte une configuration de production complète", () => {
    expect(() => loadConfig(base)).not.toThrow();
  });

  it("refuse le vérificateur SEB simulé (invariant 8, garde de configuration)", () => {
    expect(() => loadConfig({ ...base, SEB_VERIFIER: "simulated" })).toThrow(/simulated/);
  });

  it("refuse TRUST_PROXY, qui est un réglage de test", () => {
    expect(() => loadConfig({ ...base, TRUST_PROXY: "1" })).toThrow(/TRUST_PROXY/);
  });

  it("refuse les secrets de développement", () => {
    expect(() =>
      loadConfig({ ...base, COOKIE_SECRET: "dev-cookie-secret-change-me" }),
    ).toThrow(/COOKIE_SECRET/);
    expect(() =>
      loadConfig({ ...base, OIDC_CLIENT_SECRET: "dev-secret-not-for-production" }),
    ).toThrow(/OIDC_CLIENT_SECRET/);
  });

  it("exige SEB_PUBLIC_ORIGIN : rien du client n'entre dans le calcul (analyse.md 4.6)", () => {
    expect(() => loadConfig({ ...base, SEB_PUBLIC_ORIGIN: "" })).toThrow(/SEB_PUBLIC_ORIGIN/);
  });

  it("résout les chemins depuis la racine du dépôt, pas depuis le répertoire de lancement", () => {
    const config = loadConfig({ SECCOMP_PROFILE: "./infra/seccomp/codespace.json" });
    expect(config.seccompProfile.endsWith("/heig-codespace/infra/seccomp/codespace.json")).toBe(
      true,
    );
  });
});
