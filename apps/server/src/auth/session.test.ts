import { describe, expect, it } from "vitest";

import { hashToken, newToken } from "./session.js";

describe("sessions (AU-06)", () => {
  it("tokens are unique and 256 bits long", () => {
    const a = newToken();
    const b = newToken();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
  });

  it("only the hex SHA-256 is meant for the database", () => {
    const token = newToken();
    const h = hashToken(token);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(token);
    expect(hashToken(token)).toBe(h); // deterministic
  });
});
