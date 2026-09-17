import { describe, expect, it } from "vitest";

import {
  EXAM_COOKIE_DEFAULT_MAX_AGE_MS,
  examCookieAttributes,
  issueExamCookie,
  verifyExamCookie,
  type ExamClaims,
} from "./examSession.js";

const SECRET = "secret-de-test-assez-long";
const CLAIMS: ExamClaims = {
  assignmentId: "a1",
  sessionId: "s-42",
  clientAddress: "10.0.0.7",
  issuedAt: 1_700_000_000_000,
};

const cookie = issueExamCookie(CLAIMS, { secret: SECRET });
const check = { secret: SECRET, clientAddress: "10.0.0.7", now: CLAIMS.issuedAt + 1000 };

describe("cookie d'examen", () => {
  it("un cookie fraîchement émis est accepté", () => {
    const verdict = verifyExamCookie(cookie, check);
    expect(verdict).toEqual({ ok: true, claims: CLAIMS });
  });

  it("le cookie ne contient aucun caractère à échapper", () => {
    expect(cookie).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("le cookie n'expose aucun secret", () => {
    const payload = Buffer.from(cookie.split(".")[0] as string, "base64url").toString("utf8");
    expect(payload).not.toContain(SECRET);
    expect(JSON.parse(payload)).toEqual(CLAIMS);
  });

  it("cookie absent", () => {
    expect(verifyExamCookie(undefined, check)).toEqual({ ok: false, reason: "missing" });
    expect(verifyExamCookie("", check)).toEqual({ ok: false, reason: "missing" });
  });

  it("cookie mal formé", () => {
    expect(verifyExamCookie("pasdepoint", check)).toMatchObject({ reason: "malformed" });
    expect(verifyExamCookie(".signature", check)).toMatchObject({ reason: "malformed" });
    expect(verifyExamCookie("payload.", check)).toMatchObject({ reason: "malformed" });
  });

  it("signature invalide", () => {
    const [payload] = cookie.split(".");
    expect(verifyExamCookie(`${payload}.AAAA`, check)).toMatchObject({
      reason: "bad-signature",
    });
  });

  it("charge utile trafiquée : la signature ne suit pas", () => {
    const forge = Buffer.from(
      JSON.stringify({ ...CLAIMS, clientAddress: "10.0.0.8" }),
      "utf8",
    ).toString("base64url");
    expect(verifyExamCookie(`${forge}.${cookie.split(".")[1]}`, check)).toMatchObject({
      reason: "bad-signature",
    });
  });

  it("secret différent", () => {
    expect(verifyExamCookie(cookie, { ...check, secret: "un-autre-secret-de-test" })).toMatchObject(
      { reason: "bad-signature" },
    );
  });

  it("cookie valide présenté depuis une autre adresse : refusé (analyse.md D5)", () => {
    expect(verifyExamCookie(cookie, { ...check, clientAddress: "10.0.0.8" })).toEqual({
      ok: false,
      reason: "address-mismatch",
    });
  });

  it("cookie d'un autre devoir", () => {
    expect(verifyExamCookie(cookie, { ...check, assignmentId: "a2" })).toEqual({
      ok: false,
      reason: "assignment-mismatch",
    });
  });

  it("cookie périmé", () => {
    expect(
      verifyExamCookie(cookie, {
        ...check,
        now: CLAIMS.issuedAt + EXAM_COOKIE_DEFAULT_MAX_AGE_MS,
      }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("cookie daté du futur", () => {
    expect(verifyExamCookie(cookie, { ...check, now: CLAIMS.issuedAt - 1 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("un secret trop court est refusé à l'émission", () => {
    expect(() => issueExamCookie(CLAIMS, { secret: "court" })).toThrow();
  });

  it("les attributs du cookie sont ceux d'un cookie de session lié au poste", () => {
    expect(examCookieAttributes({ secure: true })).toEqual({
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      maxAge: EXAM_COOKIE_DEFAULT_MAX_AGE_MS / 1000,
    });
  });
});
