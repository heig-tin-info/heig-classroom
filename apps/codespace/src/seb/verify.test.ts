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
  // Two BEKs: one Windows workstation and one Mac, see analyse.md § 4.4.
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
  it("refuses to build the simulated mode in production (invariant 8)", () => {
    expect(() => createSebVerifier({ mode: "simulated", nodeEnv: "production" })).toThrow(
      SebConfigurationError,
    );
  });

  it("the real mode stays possible in production", () => {
    expect(createSebVerifier({ mode: "real", nodeEnv: "production" }).mode).toBe("real");
  });

  it("the simulated mode stays possible outside production", () => {
    for (const env of ["development", "test", ""]) {
      expect(createSebVerifier({ mode: "simulated", nodeEnv: env }).mode).toBe("simulated");
    }
  });
});

describe("real verifier: the formula", () => {
  it("accepts when both hashes match (sha256(url + key))", () => {
    const verdict = real.verifyStart(sebRequest(PATH), KEYS);
    expect(verdict).toEqual({ ok: true, url: ABSOLUTE });
  });

  it("the expected hash really is sha256(url + key), with no separator", () => {
    // Formula of seb_access_manager::check_key():
    // hash('sha256', $url . $validkey) === $key
    expect(expectedHash(ABSOLUTE, KEYS.configKey)).toBe(
      createHash("sha256").update(`${ABSOLUTE}${KEYS.configKey}`).digest("hex"),
    );
  });

  it("accepts the first BEK of the list as well as the second", () => {
    for (const bek of KEYS.beks) {
      const req = sebRequest(PATH, { [REQUEST_HASH_HEADER]: expectedHash(ABSOLUTE, bek) });
      expect(real.verifyStart(req, KEYS).ok).toBe(true);
    }
  });
});

describe("real verifier: refusal cases", () => {
  it("no header at all", () => {
    const verdict = real.verifyStart({ url: PATH, headers: { host: "x" } }, KEYS);
    expect(verdict).toMatchObject({ ok: false, reason: "missing-config-key-header" });
  });

  it("Config Key present, request hash missing", () => {
    const verdict = real.verifyStart(
      {
        url: PATH,
        headers: { [CONFIG_KEY_HEADER]: expectedHash(ABSOLUTE, KEYS.configKey) },
      },
      KEYS,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "missing-request-hash-header" });
  });

  it("forged header", () => {
    const verdict = real.verifyStart(
      sebRequest(PATH, { [CONFIG_KEY_HEADER]: "00".repeat(32) }),
      KEYS,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "config-key-mismatch" });
  });

  it("hash computed over a URL carrying a fragment", () => {
    // A browser never sends the fragment; a client that had included it in its
    // computation gets a hash that does not match.
    const verdict = real.verifyStart(sebRequest(PATH, {}, `${ABSOLUTE}#section`), KEYS);
    expect(verdict).toMatchObject({ ok: false, reason: "config-key-mismatch" });
  });

  it("a fragment present in the request target is stripped before hashing", () => {
    const verdict = real.verifyStart(sebRequest(`${PATH}#section`, {}, ABSOLUTE), KEYS);
    expect(verdict).toEqual({ ok: true, url: ABSOLUTE });
  });

  it("reordered query: the hash is over the exact URL", () => {
    const asked = `${PATH}?b=2&a=1`;
    const verdict = real.verifyStart(
      sebRequest(asked, {}, `${ORIGIN}${PATH}?a=1&b=2`),
      KEYS,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "config-key-mismatch" });
  });

  it("BEK of another version of SEB", () => {
    const otherVersion = "cccc111122223333444455556666777788889999aaaabbbbccccddddeeeeffff";
    const verdict = real.verifyStart(
      sebRequest(PATH, { [REQUEST_HASH_HEADER]: expectedHash(ABSOLUTE, otherVersion) }),
      KEYS,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "browser-exam-key-mismatch" });
  });

  it("Config Key of another assignment", () => {
    const verdict = real.verifyStart(
      sebRequest(PATH, {
        [CONFIG_KEY_HEADER]: expectedHash(ABSOLUTE, "4fa9af8e".repeat(8)),
      }),
      KEYS,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "config-key-mismatch" });
  });

  it("assignment with no BEK recorded at all", () => {
    const verdict = real.verifyStart(sebRequest(PATH), { configKey: KEYS.configKey, beks: [] });
    expect(verdict).toMatchObject({ ok: false, reason: "no-browser-exam-key-configured" });
  });

  it("the development header is not enough for the real verifier", () => {
    const verdict = real.verifyStart({ url: PATH, headers: { [DEV_HEADER]: "ok" } }, KEYS);
    expect(verdict.ok).toBe(false);
  });
});

describe("simulated verifier", () => {
  const req = (headers: Record<string, string>): SebRequestFacts => ({
    url: PATH,
    headers: { host: "codespace.heig-vd.ch", ...headers },
  });

  it("accepts X-Dev-SEB: ok", () => {
    expect(simulated.verifyStart(req({ [DEV_HEADER]: "ok" }), KEYS).ok).toBe(true);
  });

  it("refuses any other value", () => {
    for (const value of ["", "yes", "true", "OK "]) {
      expect(simulated.verifyStart(req({ [DEV_HEADER]: value }), KEYS).ok).toBe(false);
    }
  });

  it("refuses the same requests as the real verifier", () => {
    // The set of refusal cases is shared by both implementations: no request
    // that is not explicitly allowed goes through.
    const refusals: SebRequestFacts[] = [
      { url: PATH, headers: { host: "codespace.heig-vd.ch" } },
      sebRequest(PATH, { [CONFIG_KEY_HEADER]: "00".repeat(32) }),
      sebRequest(PATH, {}, `${ABSOLUTE}#section`),
      sebRequest(`${PATH}?b=2&a=1`, {}, `${ORIGIN}${PATH}?a=1&b=2`),
    ];
    for (const r of refusals) {
      expect(simulated.verifyStart(r, KEYS).ok, `simulated ${r.url}`).toBe(false);
      expect(real.verifyStart(r, KEYS).ok, `real ${r.url}`).toBe(false);
    }
  });
});

describe("reconstruction of the absolute URL", () => {
  it("publicOrigin ignores whatever the client claims", () => {
    const url = absoluteRequestUrl(
      { url: PATH, headers: { host: "evil.example", "x-forwarded-host": "evil.example" } },
      { publicOrigin: ORIGIN },
    );
    expect(url).toBe(ABSOLUTE);
  });

  it("without publicOrigin and without trust, the Host header is used", () => {
    expect(
      absoluteRequestUrl(
        { url: PATH, headers: { host: "codespace.heig-vd.ch", "x-forwarded-proto": "http" } },
        { defaultProtocol: "https" },
      ),
    ).toBe(ABSOLUTE);
  });

  it("with trustForwarded, X-Forwarded-Proto and -Host are read", () => {
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

  it("with no host, the URL cannot be reconstructed and the request is refused", () => {
    expect(absoluteRequestUrl({ url: PATH, headers: {} }, {})).toBeNull();
    const verdict = createSebVerifier({ mode: "real", nodeEnv: "test" }).verifyStart(
      { url: PATH, headers: {} },
      KEYS,
    );
    expect(verdict).toMatchObject({ ok: false, reason: "url-unreconstructible" });
  });

  it("the fragment is stripped", () => {
    expect(
      absoluteRequestUrl({ url: `${PATH}?a=1#frag`, headers: {} }, { publicOrigin: ORIGIN }),
    ).toBe(`${ABSOLUTE}?a=1`);
  });
});

describe("hashesEqual", () => {
  it("compares hexadecimal hashes regardless of case and surrounding spaces", () => {
    expect(hashesEqual("AABB", " aabb ")).toBe(true);
    expect(hashesEqual("aabb", "aabc")).toBe(false);
    expect(hashesEqual("aabb", "aabbcc")).toBe(false);
    expect(hashesEqual("", "")).toBe(true);
  });
});
