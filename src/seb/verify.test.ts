import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CONFIG_KEY_HEADER,
  DEV_HEADER,
  REQUEST_HASH_HEADER,
  SebConfigurationError,
  absoluteRequestUrl,
  createSebVerifier,
  expectedHash,
  hashesEqual,
  type AssignmentSebKeys,
  type SebRequestFacts,
} from "./verify.js";

const ORIGIN = "https://codespace.heig-vd.ch";
const PATH = "/exam/a1/start";
const ABSOLUTE = `${ORIGIN}${PATH}`;

const KEYS: AssignmentSebKeys = {
  configKey: "2534e4e9f3188f9f9133bf7cf7b4c5d898292bbd7e8d0230f39d1176636a1431",
  // Deux BEK : un poste Windows et un Mac, cf. analyse.md § 4.4.
  beks: [
    "aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
    "bbbb111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
  ],
};

const real = createSebVerifier({
  mode: "real",
  nodeEnv: "test",
  url: { publicOrigin: ORIGIN },
});

const simulated = createSebVerifier({ mode: "simulated", nodeEnv: "test" });

function sebRequest(
  url: string,
  extra: Record<string, string> = {},
  hashUrl = `${ORIGIN}${url}`,
): SebRequestFacts {
  return {
    url,
    headers: {
      host: "codespace.heig-vd.ch",
      [CONFIG_KEY_HEADER]: expectedHash(hashUrl, KEYS.configKey),
      [REQUEST_HASH_HEADER]: expectedHash(hashUrl, KEYS.beks[1] as string),
      ...extra,
    },
  };
}

describe("createSebVerifier", () => {
  it("refuse de construire le mode simulated en production (invariant 8)", () => {
    expect(() => createSebVerifier({ mode: "simulated", nodeEnv: "production" })).toThrow(
      SebConfigurationError,
    );
  });

  it("le mode real reste possible en production", () => {
    expect(createSebVerifier({ mode: "real", nodeEnv: "production" }).mode).toBe("real");
  });

  it("le mode simulated reste possible hors production", () => {
    for (const env of ["development", "test", ""]) {
      expect(createSebVerifier({ mode: "simulated", nodeEnv: env }).mode).toBe("simulated");
    }
  });
});

describe("verifier real : la formule", () => {
  it("accepte quand les deux hachés correspondent (sha256(url + clé))", () => {
    const verdict = real.verifyStart(sebRequest(PATH), KEYS);
    expect(verdict).toEqual({ ok: true, url: ABSOLUTE });
  });

  it("le haché attendu est bien sha256(url + clé), sans séparateur", () => {
    // Formule de seb_access_manager::check_key() :
    // hash('sha256', $url . $validkey) === $key
    expect(expectedHash(ABSOLUTE, KEYS.configKey)).toBe(
      createHash("sha256").update(`${ABSOLUTE}${KEYS.configKey}`).digest("hex"),
    );
  });

  it("accepte le premier BEK de la liste comme le second", () => {
    for (const bek of KEYS.beks) {
      const req = sebRequest(PATH, { [REQUEST_HASH_HEADER]: expectedHash(ABSOLUTE, bek) });
      expect(real.verifyStart(req, KEYS).ok).toBe(true);
    }
  });
});

describe("verifier real : cas de refus", () => {
  it("aucun en-tête", () => {
    const verdict = real.verifyStart({ url: PATH, headers: { host: "x" } }, KEYS);
    expect(verdict).toMatchObject({ ok: false, reason: "missing-config-key-header" });
  });

  it("Config Key présente, hachage de requête absent", () => {
    const verdict = real.verifyStart(
      {
        url: PATH,
        headers: { [CONFIG_KEY_HEADER]: expectedHash(ABSOLUTE, KEYS.configKey) },
      },
      KEYS,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "missing-request-hash-header" });
  });

  it("en-tête forgé", () => {
    const verdict = real.verifyStart(
      sebRequest(PATH, { [CONFIG_KEY_HEADER]: "00".repeat(32) }),
      KEYS,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "config-key-mismatch" });
  });

  it("hachage calculé sur une URL portant un fragment", () => {
    // Un navigateur n'envoie jamais le fragment ; un client qui l'aurait inclus
    // dans son calcul obtient un haché qui ne correspond pas.
    const verdict = real.verifyStart(sebRequest(PATH, {}, `${ABSOLUTE}#section`), KEYS);
    expect(verdict).toMatchObject({ ok: false, reason: "config-key-mismatch" });
  });

  it("un fragment présent dans la cible de la requête est retiré avant hachage", () => {
    const verdict = real.verifyStart(sebRequest(`${PATH}#section`, {}, ABSOLUTE), KEYS);
    expect(verdict).toEqual({ ok: true, url: ABSOLUTE });
  });

  it("query réordonnée : le haché porte sur l'URL exacte", () => {
    const asked = `${PATH}?b=2&a=1`;
    const verdict = real.verifyStart(
      sebRequest(asked, {}, `${ORIGIN}${PATH}?a=1&b=2`),
      KEYS,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "config-key-mismatch" });
  });

  it("BEK d'une autre version de SEB", () => {
    const autreVersion = "cccc111122223333444455556666777788889999aaaabbbbccccddddeeeeffff";
    const verdict = real.verifyStart(
      sebRequest(PATH, { [REQUEST_HASH_HEADER]: expectedHash(ABSOLUTE, autreVersion) }),
      KEYS,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "browser-exam-key-mismatch" });
  });

  it("Config Key d'un autre devoir", () => {
    const verdict = real.verifyStart(
      sebRequest(PATH, {
        [CONFIG_KEY_HEADER]: expectedHash(ABSOLUTE, "4fa9af8e".repeat(8)),
      }),
      KEYS,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "config-key-mismatch" });
  });

  it("devoir sans aucun BEK enregistré", () => {
    const verdict = real.verifyStart(sebRequest(PATH), { configKey: KEYS.configKey, beks: [] });
    expect(verdict).toMatchObject({ ok: false, reason: "no-browser-exam-key-configured" });
  });

  it("l'en-tête de développement ne suffit pas au vérificateur réel", () => {
    const verdict = real.verifyStart({ url: PATH, headers: { [DEV_HEADER]: "ok" } }, KEYS);
    expect(verdict.ok).toBe(false);
  });
});

describe("verifier simulated", () => {
  const req = (headers: Record<string, string>): SebRequestFacts => ({
    url: PATH,
    headers: { host: "codespace.heig-vd.ch", ...headers },
  });

  it("accepte X-Dev-SEB: ok", () => {
    expect(simulated.verifyStart(req({ [DEV_HEADER]: "ok" }), KEYS).ok).toBe(true);
  });

  it("refuse toute autre valeur", () => {
    for (const value of ["", "yes", "true", "OK "]) {
      expect(simulated.verifyStart(req({ [DEV_HEADER]: value }), KEYS).ok).toBe(false);
    }
  });

  it("refuse les mêmes requêtes que le vérificateur réel", () => {
    // Le jeu de cas de refus est commun aux deux implémentations : aucune
    // requête qui n'est pas explicitement autorisée ne passe.
    const refus: SebRequestFacts[] = [
      { url: PATH, headers: { host: "codespace.heig-vd.ch" } },
      sebRequest(PATH, { [CONFIG_KEY_HEADER]: "00".repeat(32) }),
      sebRequest(PATH, {}, `${ABSOLUTE}#section`),
      sebRequest(`${PATH}?b=2&a=1`, {}, `${ORIGIN}${PATH}?a=1&b=2`),
    ];
    for (const r of refus) {
      expect(simulated.verifyStart(r, KEYS).ok, `simulated ${r.url}`).toBe(false);
      expect(real.verifyStart(r, KEYS).ok, `real ${r.url}`).toBe(false);
    }
  });
});

describe("reconstruction de l'URL absolue", () => {
  it("publicOrigin ignore ce que le client raconte", () => {
    const url = absoluteRequestUrl(
      { url: PATH, headers: { host: "evil.example", "x-forwarded-host": "evil.example" } },
      { publicOrigin: ORIGIN },
    );
    expect(url).toBe(ABSOLUTE);
  });

  it("sans publicOrigin ni confiance, l'en-tête Host sert", () => {
    expect(
      absoluteRequestUrl(
        { url: PATH, headers: { host: "codespace.heig-vd.ch", "x-forwarded-proto": "http" } },
        { defaultProtocol: "https" },
      ),
    ).toBe(ABSOLUTE);
  });

  it("avec trustForwarded, X-Forwarded-Proto et -Host sont lus", () => {
    expect(
      absoluteRequestUrl(
        {
          url: PATH,
          headers: {
            host: "127.0.0.1:3000",
            "x-forwarded-host": "codespace.heig-vd.ch",
            "x-forwarded-proto": "https, http",
          },
        },
        { trustForwarded: true },
      ),
    ).toBe(ABSOLUTE);
  });

  it("sans hôte, l'URL est irreconstructible et la requête est refusée", () => {
    expect(absoluteRequestUrl({ url: PATH, headers: {} }, {})).toBeNull();
    const verdict = createSebVerifier({ mode: "real", nodeEnv: "test" }).verifyStart(
      { url: PATH, headers: {} },
      KEYS,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "url-unreconstructible" });
  });

  it("le fragment est retiré", () => {
    expect(
      absoluteRequestUrl({ url: `${PATH}?a=1#frag`, headers: {} }, { publicOrigin: ORIGIN }),
    ).toBe(`${ABSOLUTE}?a=1`);
  });
});

describe("hashesEqual", () => {
  it("compare des hachés hexadécimaux sans se soucier de la casse ni des espaces", () => {
    expect(hashesEqual("AABB", " aabb ")).toBe(true);
    expect(hashesEqual("aabb", "aabc")).toBe(false);
    expect(hashesEqual("aabb", "aabbcc")).toBe(false);
    expect(hashesEqual("", "")).toBe(true);
  });
});
