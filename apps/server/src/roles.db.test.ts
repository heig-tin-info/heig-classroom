import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import type { AppConfig } from "./config.js";
import { teacherGrants, users } from "./db/schema.js";
import { roleForIdentity } from "./roles.js";
import { testDb, type TestDb } from "./test/db.js";

const config = { SUPER_ADMIN_EMAIL: "boss@heig.test" } as AppConfig;

let db: TestDb;

beforeAll(async () => {
  db = await testDb();
  const adminId = randomUUID();
  await db
    .insert(users)
    .values({ id: adminId, oidcSub: `u-${adminId}`, email: "boss@heig.test", role: "admin" });
  await db.insert(teacherGrants).values({
    id: randomUUID(),
    email: "granted@heig.test",
    createdBy: adminId,
  });
});

describe("roleForIdentity (GH-11)", () => {
  it("promotes on a granted address even when the login address is private", async () => {
    // The grant was issued on the institutional address; edu-ID hands us a
    // private one. Before GH-11 this teacher came back as a student.
    expect(
      await roleForIdentity(db, config, {
        emails: ["someone@gmail.test", "granted@heig.test"],
        affiliations: ["student@hes-so.ch"],
      }),
    ).toBe("teacher");
  });

  it("recognizes the administrator on any of their addresses", async () => {
    expect(
      await roleForIdentity(db, config, { emails: ["private@gmail.test", "boss@heig.test"] }),
    ).toBe("admin");
  });

  it("makes a staff affiliation a teacher", async () => {
    // Exactly the shape production returns for an employee.
    expect(
      await roleForIdentity(db, config, {
        emails: ["nobody@heig.test"],
        affiliations: ["affiliate@eduid.ch", "member@hes-so.ch", "staff@hes-so.ch"],
      }),
    ).toBe("teacher");
  });

  it("keeps a student who is also staff a student", async () => {
    // Student assistants hold both affiliations; the student side wins.
    expect(
      await roleForIdentity(db, config, {
        emails: ["nobody@heig.test"],
        affiliations: ["student@hes-so.ch", "staff@hes-so.ch"],
      }),
    ).toBe("student");
  });

  it("leaves a plain student a student", async () => {
    expect(
      await roleForIdentity(db, config, {
        emails: ["nobody@heig.test"],
        affiliations: ["affiliate@eduid.ch", "member@hes-so.ch", "student@hes-so.ch"],
      }),
    ).toBe("student");
  });

  it("defaults to student without any affiliation", async () => {
    expect(await roleForIdentity(db, config, { emails: ["nobody@heig.test"] })).toBe("student");
  });
});
