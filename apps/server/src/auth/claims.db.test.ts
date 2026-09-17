import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { userIdpClaims, users } from "../db/schema.js";
import { testDb, type TestDb } from "../test/db.js";
import { recordIdpClaims } from "./claims.js";

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
