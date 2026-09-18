import { describe, expect, it } from "vitest";

import {
  EXAM_COOKIE_DEFAULT_MAX_AGE_MS,
  examCookieAttributes,
  issueExamCookie,
  verifyExamCookie,
  type ExamClaims,
} from "./examSession.js";

const SECRET = "long-enough-test-secret";
const CLAIMS: ExamClaims = {
  assignmentId: "a1",
  sessionId: "s-42",
  clientAddress: "10.0.0.7",
  issuedAt: 1_700_000_000_000,
};

const cookie = issueExamCookie(CLAIMS, { secret: SECRET });
const check = { secret: SECRET, clientAddress: "10.0.0.7", now: CLAIMS.issuedAt + 1000 };

describe("exam cookie", () => {
  it("a freshly issued cookie is accepted", () => {
    const verdict = verifyExamCookie(cookie, check);
    expect(verdict).toEqual({ ok: true, claims: CLAIMS });
  });

  it("the cookie contains no character that needs escaping", () => {
    expect(cookie).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("the cookie exposes no secret", () => {
    const payload = Buffer.from(cookie.split(".")[0] as string, "base64url").toString("utf8");
    expect(payload).not.toContain(SECRET);
    expect(JSON.parse(payload)).toEqual(CLAIMS);
  });

  it("cookie missing", () => {
    expect(verifyExamCookie(undefined, check)).toEqual({ ok: false, reason: "missing" });
    expect(verifyExamCookie("", check)).toEqual({ ok: false, reason: "missing" });
  });

  it("malformed cookie", () => {
    expect(verifyExamCookie("nodot", check)).toMatchObject({ reason: "malformed" });
    expect(verifyExamCookie(".signature", check)).toMatchObject({ reason: "malformed" });
    expect(verifyExamCookie("payload.", check)).toMatchObject({ reason: "malformed" });
  });

  it("invalid signature", () => {
    const [payload] = cookie.split(".");
    expect(verifyExamCookie(`${payload}.AAAA`, check)).toMatchObject({
      reason: "bad-signature",
    });
  });

  it("tampered payload: the signature does not follow", () => {
    const forged = Buffer.from(
      JSON.stringify({ ...CLAIMS, clientAddress: "10.0.0.8" }),
      "utf8",
    ).toString("base64url");
    expect(verifyExamCookie(`${forged}.${cookie.split(".")[1]}`, check)).toMatchObject({
      reason: "bad-signature",
    });
  });

  it("different secret", () => {
    expect(verifyExamCookie(cookie, { ...check, secret: "another-test-secret-here" })).toMatchObject(
      { reason: "bad-signature" },
    );
  });

  it("a valid cookie presented from another address: refused (analyse.md D5)", () => {
    expect(verifyExamCookie(cookie, { ...check, clientAddress: "10.0.0.8" })).toEqual({
      ok: false,
      reason: "address-mismatch",
    });
  });

  it("cookie of another assignment", () => {
    expect(verifyExamCookie(cookie, { ...check, assignmentId: "a2" })).toEqual({
      ok: false,
      reason: "assignment-mismatch",
    });
  });

  it("expired cookie", () => {
    expect(
      verifyExamCookie(cookie, {
        ...check,
        now: CLAIMS.issuedAt + EXAM_COOKIE_DEFAULT_MAX_AGE_MS,
      }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("cookie dated in the future", () => {
    expect(verifyExamCookie(cookie, { ...check, now: CLAIMS.issuedAt - 1 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("a secret that is too short is refused at issue time", () => {
    expect(() => issueExamCookie(CLAIMS, { secret: "short" })).toThrow();
  });

  it("the cookie attributes are those of a session cookie bound to the workstation", () => {
    expect(examCookieAttributes({ secure: true })).toEqual({
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      maxAge: EXAM_COOKIE_DEFAULT_MAX_AGE_MS / 1000,
    });
  });
});
