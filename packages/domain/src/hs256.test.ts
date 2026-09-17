import { describe, expect, it } from "vitest";

import { signHs256, verifyHs256 } from "./hs256.js";

const secret = "un-secret-de-test-suffisamment-long";
const base = { iss: "heig-classroom", aud: "heig-codespace", iat: 1000, exp: 1300, sub: "u1" };
const at = (t: number) => ({ audience: "heig-codespace", issuer: "heig-classroom", now: () => t });

describe("HS256", () => {
  it("signe puis vérifie", async () => {
    const token = await signHs256(base, secret);
    expect(token.split(".")).toHaveLength(3);
    const r = await verifyHs256<typeof base>(token, secret, at(1100));
    expect(r).toEqual({ ok: true, claims: base });
  });

  it("refuse une signature d'un autre secret", async () => {
    const token = await signHs256(base, "autre");
    expect(await verifyHs256(token, secret, at(1100))).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuse une charge utile modifiée", async () => {
    const [h, , s] = (await signHs256(base, secret)).split(".") as [string, string, string];
    const forged = btoa(JSON.stringify({ ...base, sub: "u2" })).replace(/=+$/, "");
    expect(await verifyHs256(`${h}.${forged}.${s}`, secret, at(1100))).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuse alg=none et les jetons mal formés", async () => {
    const none = btoa(JSON.stringify({ alg: "none" })).replace(/=+$/, "");
    const p = btoa(JSON.stringify(base)).replace(/=+$/, "");
    expect(await verifyHs256(`${none}.${p}.`, secret, at(1100))).toEqual({ ok: false, reason: "bad-alg" });
    expect(await verifyHs256("abc", secret, at(1100))).toEqual({ ok: false, reason: "malformed" });
  });

  it("applique exp, iat, aud et iss", async () => {
    const token = await signHs256(base, secret);
    expect(await verifyHs256(token, secret, at(1400))).toEqual({ ok: false, reason: "expired" });
    expect(await verifyHs256(token, secret, at(900))).toEqual({ ok: false, reason: "not-yet-valid" });
    expect(await verifyHs256(token, secret, { audience: "autre", now: () => 1100 })).toEqual({ ok: false, reason: "bad-audience" });
    expect(await verifyHs256(token, secret, { audience: "heig-codespace", issuer: "x", now: () => 1100 })).toEqual({ ok: false, reason: "bad-issuer" });
  });
});
