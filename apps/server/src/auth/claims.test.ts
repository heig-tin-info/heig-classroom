import { describe, expect, it } from "vitest";

import {
  affiliationKinds,
  affiliationsOf,
  claimList,
  persistableClaims,
} from "./claims.js";
import { scopeFor } from "./oidc.js";

describe("scopeFor", () => {
  it("asks edu-ID for its attribute scope", () => {
    expect(scopeFor("https://login.eduid.ch/")).toBe(
      "openid profile email https://eduid.ch/scope/userinfo.read",
    );
  });

  it("leaves any other IdP alone — an unknown scope is an invalid_scope error", () => {
    expect(scopeFor("http://localhost:8080/realms/hgc-dev")).toBe("openid profile email");
    // A look-alike host must not be taken for edu-ID.
    expect(scopeFor("https://eduid.ch.evil.test/")).toBe("openid profile email");
    expect(scopeFor("not a url")).toBe("openid profile email");
  });
});

describe("claimList", () => {
  it("takes the JSON arrays edu-ID specifies", () => {
    expect(claimList(["student@heig-vd.ch", "member@heig-vd.ch"])).toEqual([
      "student@heig-vd.ch",
      "member@heig-vd.ch",
    ]);
  });

  it("also splits the separated strings the SAML bridges hand out", () => {
    expect(claimList("student, staff;member")).toEqual(["student", "staff", "member"]);
  });

  it("ignores what is absent or unusable", () => {
    expect(claimList(undefined)).toEqual([]);
    expect(claimList(null)).toEqual([]);
    expect(claimList([" ", ""])).toEqual([]);
    expect(claimList({ nope: true })).toEqual([]);
  });
});

describe("affiliationsOf", () => {
  it("merges the three affiliation claims, lowercased and deduplicated", () => {
    expect(
      affiliationsOf({
        eduPersonPrimaryAffiliation: ["student"],
        eduPersonScopedAffiliation: ["Student@heig-vd.ch", "member@heig-vd.ch"],
        swissEduIDLinkedAffiliation: ["student@heig-vd.ch", "staff@hes-so.ch"],
      }),
    ).toEqual(["student", "student@heig-vd.ch", "member@heig-vd.ch", "staff@hes-so.ch"]);
  });

  it("is empty when the IdP releases no affiliation", () => {
    expect(affiliationsOf({ email: "who@example.test" })).toEqual([]);
  });
});

describe("affiliationKinds", () => {
  it("drops the scope so student@heig-vd.ch reads as student", () => {
    expect(affiliationKinds(["student", "student@heig-vd.ch", "staff@hes-so.ch"])).toEqual([
      "student",
      "staff",
    ]);
  });
});

describe("persistableClaims", () => {
  it("keeps the attributes and drops the token plumbing", () => {
    const kept = persistableClaims({
      sub: "abc",
      email: "private@example.test",
      swissEduIDLinkedAffiliationMail: ["first.last@heig-vd.ch"],
      at_hash: "…",
      nonce: "…",
      iss: "https://login.eduid.ch/",
      exp: 1,
    });
    expect(kept).toEqual({
      sub: "abc",
      email: "private@example.test",
      swissEduIDLinkedAffiliationMail: ["first.last@heig-vd.ch"],
    });
  });
});
