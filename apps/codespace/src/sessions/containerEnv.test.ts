/**
 * Ce que le portail pose sur le conteneur étudiant, et **rien d'autre**
 * (invariant 1 : aucun secret dans le conteneur).
 *
 * Deux niveaux, tous deux unitaires et sans Podman :
 *  - `containerEnvFor` : la décision, devoir par devoir ;
 *  - `engine.runArgs` : ce que la décision devient en arguments `podman run`,
 *    et le fait qu'il n'y entre aucune quatrième variable.
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

describe("containerEnvFor — ces variables, pas une de plus", () => {
  it("ne produit jamais de clé hors de CONTAINER_ENV_KEYS", () => {
    const env = containerEnvFor(
      session({ launchJti: "jti-1" }),
      assignment({ closesAt: new Date("2026-10-01T12:00:00Z") }),
      URLS,
      user(),
    );
    expect(Object.keys(env).sort()).toEqual([...CONTAINER_ENV_KEYS].sort());
  });

  it("n'a aucun secret dans ses valeurs : ni jeton, ni clé, ni mot de passe", () => {
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

  it("transmet l'échéance du devoir en ISO 8601", () => {
    const env = containerEnvFor(session(), assignment({ closesAt: new Date("2026-10-01T12:00:00Z") }), URLS);
    expect(env.CODESPACE_DEADLINE).toBe("2026-10-01T12:00:00.000Z");
  });

  it("n'en transmet aucune quand le devoir n'a pas d'échéance", () => {
    const env = containerEnvFor(session(), assignment(), URLS);
    expect(env.CODESPACE_DEADLINE).toBeUndefined();
  });

  it("renvoie vers classroom quand un jeton de lancement a ouvert la session", () => {
    const env = containerEnvFor(session({ launchJti: "jti-1" }), assignment(), URLS);
    expect(env.CODESPACE_RETURN_URL).toBe("https://classroom.chevallier.io/");
  });

  it("renvoie vers le portail pour une session autonome", () => {
    const env = containerEnvFor(session(), assignment(), URLS);
    expect(env.CODESPACE_RETURN_URL).toBe("https://code.chevallier.io/");
  });

  it("n'invente pas d'URL de retour quand l'origine n'est pas configurée", () => {
    expect(containerEnvFor(session(), assignment(), {}).CODESPACE_RETURN_URL).toBeUndefined();
    expect(
      containerEnvFor(session(), assignment(), { publicUrl: "pas une URL" }).CODESPACE_RETURN_URL,
    ).toBeUndefined();
  });

  it("transmet le titre du devoir", () => {
    const env = containerEnvFor(session(), assignment(), URLS);
    expect(env.CODESPACE_ASSIGNMENT_NAME).toBe("TP 3 — pointeurs et tableaux");
  });
});

describe("identité git de l'étudiant", () => {
  it("pose auteur et committer depuis display_name et email", () => {
    const env = containerEnvFor(session(), assignment(), URLS, user());
    expect(env.GIT_AUTHOR_NAME).toBe("Pierre Bressy");
    expect(env.GIT_AUTHOR_EMAIL).toBe("pierre.bressy@heig-vd.ch");
    expect(env.GIT_COMMITTER_NAME).toBe("Pierre Bressy");
    expect(env.GIT_COMMITTER_EMAIL).toBe("pierre.bressy@heig-vd.ch");
  });

  it("retombe sur le login institutionnel quand display_name est vide", () => {
    expect(gitIdentityOf(user({ displayName: "  " }))?.name).toBe("pierre.bressy");
  });

  it("tout ou rien : sans adresse, aucune des quatre variables", () => {
    const env = containerEnvFor(session(), assignment(), URLS, user({ email: "" }));
    expect(gitIdentityOf(user({ email: "" }))).toBeNull();
    expect(Object.keys(env).some((k) => k.startsWith("GIT_"))).toBe(false);
  });

  it("n'en pose aucune quand la session n'a pas d'utilisateur connu", () => {
    const env = containerEnvFor(session(), assignment(), URLS);
    expect(Object.keys(env).some((k) => k.startsWith("GIT_"))).toBe(false);
  });
});

describe("engine.runArgs — l'environnement du conteneur ne porte que ces variables", () => {
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

  /** Les valeurs de chaque `-e` de la ligne de commande. */
  function envArgs(argv: string[]): string[] {
    return argv.filter((_, i) => argv[i - 1] === "-e" || argv[i - 1] === "--env");
  }

  it("pose exactement les variables attendues", () => {
    expect(envArgs(args).map((a) => a.split("=")[0]).sort()).toEqual([...CONTAINER_ENV_KEYS].sort());
  });

  it("porte les valeurs décidées par le gestionnaire de sessions", () => {
    expect(envArgs(args)).toContain("CODESPACE_DEADLINE=2026-10-01T12:00:00.000Z");
    expect(envArgs(args)).toContain("CODESPACE_RETURN_URL=https://classroom.chevallier.io/");
    expect(envArgs(args)).toContain("GIT_AUTHOR_NAME=Pierre Bressy");
    expect(envArgs(args)).toContain("GIT_COMMITTER_EMAIL=pierre.bressy@heig-vd.ch");
  });

  it("passe un nom à espaces tel quel : execFile, aucun shell", () => {
    const spaced = engine.runArgs({
      sessionId: "s3",
      name: "cs-s3",
      workDir: "/vol/a/b/work",
      env: containerEnvFor(session(), assignment(), URLS, user({ displayName: "Jean-Luc D'Arc" })),
    });
    expect(envArgs(spaced)).toContain("GIT_AUTHOR_NAME=Jean-Luc D'Arc");
  });

  it("n'utilise jamais --env-file : la liste doit rester lisible dans les arguments", () => {
    expect(args).not.toContain("--env-file");
    expect(args.some((a) => a.startsWith("--env-file"))).toBe(false);
  });

  it("ne pose aucune variable quand l'appelant n'en donne aucune", () => {
    const bare = engine.runArgs({ sessionId: "s2", name: "cs-s2", workDir: "/vol/a/b/work" });
    expect(envArgs(bare)).toEqual([]);
  });

  it("laisse le durcissement et le volume intacts", () => {
    expect(args).toContain("--userns=auto");
    expect(args).toContain("--read-only");
    expect(args.at(-1)).toBe("codespace/c-dev:4.137.0");
    expect(args).toContain("/vol/a/b/work:/work:U");
  });
});
