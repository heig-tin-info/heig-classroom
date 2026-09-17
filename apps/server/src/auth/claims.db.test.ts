import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { userEmails, userIdpClaims, users } from "../db/schema.js";
import { testDb, type TestDb } from "../test/db.js";
import { recordIdpClaims, syncUserEmails } from "./claims.js";

let db: TestDb;
let userId: string;

beforeAll(async () => {
  db = await testDb();
  userId = randomUUID();
  await db
    .insert(users)
    .values({ id: userId, oidcSub: `u-${userId}`, email: "private@example.test" });
});

async function stored() {
  const [row] = await db
    .select()
    .from(userIdpClaims)
    .where(eq(userIdpClaims.userId, userId));
  return row;
}

describe("recordIdpClaims", () => {
  it("stores the released claims and the normalized affiliations", async () => {
    await recordIdpClaims(db, userId, {
      sub: "eduid-sub",
      email: "private@example.test",
      swissEduIDLinkedAffiliationMail: ["first.last@heig-vd.ch", "first.last@hes-so.ch"],
      eduPersonScopedAffiliation: ["student@heig-vd.ch"],
      nonce: "token plumbing",
    });
    const row = await stored();
    expect(row?.claims.swissEduIDLinkedAffiliationMail).toEqual([
      "first.last@heig-vd.ch",
      "first.last@hes-so.ch",
    ]);
    expect(row?.claims).not.toHaveProperty("nonce");
    expect(row?.affiliations).toEqual(["student@heig-vd.ch"]);
  });

  it("overwrites the snapshot at the next login", async () => {
    const before = await stored();
    await recordIdpClaims(db, userId, {
      sub: "eduid-sub",
      email: "first.last@heig-vd.ch",
      eduPersonScopedAffiliation: ["staff@heig-vd.ch"],
    });
    const row = await stored();
    expect(row?.claims.email).toBe("first.last@heig-vd.ch");
    expect(row?.claims).not.toHaveProperty("swissEduIDLinkedAffiliationMail");
    expect(row?.affiliations).toEqual(["staff@heig-vd.ch"]);
    expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
  });
});

describe("syncUserEmails", () => {
  it("records the login address and the institutional ones, with their source", async () => {
    await syncUserEmails(
      db,
      userId,
      {
        email: "private@example.test",
        swissEduIDLinkedAffiliationMail: ["First.Last@heig.test"],
      },
      true,
    );
    const rows = await db
      .select()
      .from(userEmails)
      .where(eq(userEmails.userId, userId))
      .orderBy(userEmails.email);
    expect(rows.map((r) => [r.email, r.source, r.verified])).toEqual([
      ["first.last@heig.test", "swissEduIDLinkedAffiliationMail", true],
      ["private@example.test", "login", true],
    ]);
  });

  it("is idempotent — a second login adds nothing", async () => {
    const added = await syncUserEmails(
      db,
      userId,
      {
        email: "private@example.test",
        swissEduIDLinkedAffiliationMail: ["first.last@heig.test"],
      },
      true,
    );
    expect(added).toBe(0);
  });

  it("carries email_verified on the login address only", async () => {
    // An address asserted by the home organization is verified by
    // construction; the preferred address the user chose is not.
    const other = randomUUID();
    await db
      .insert(users)
      .values({ id: other, oidcSub: `u-${other}`, email: "unverified@example.test" });
    await syncUserEmails(
      db,
      other,
      {
        email: "unverified@example.test",
        swissEduIDLinkedAffiliationMail: ["real.person@heig.test"],
      },
      false,
    );
    const rows = await db.select().from(userEmails).where(eq(userEmails.userId, other));
    expect(rows.find((r) => r.source === "login")!.verified).toBe(false);
    expect(rows.find((r) => r.source !== "login")!.verified).toBe(true);
  });
});
