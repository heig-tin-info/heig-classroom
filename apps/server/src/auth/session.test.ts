import { describe, expect, it } from "vitest";

import { hashToken, newToken } from "./session.js";

describe("sessions (AU-06)", () => {
  it("les tokens sont uniques et de 256 bits", () => {
    const a = newToken();
    const b = newToken();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
  });

  it("seul le SHA-256 hex est destiné à la base", () => {
    const token = newToken();
    const h = hashToken(token);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(token);
    expect(hashToken(token)).toBe(h); // déterministe
  });
});
