/**
 * The two rules of the journal API that are not about GitHub (issue #45): what
 * a path is allowed to be, and what a student is allowed to see.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import {
  journalPages,
  journals,
  organizations,
  users,
} from "../db/schema.js";
import { testApp, type TestDb } from "../test/db.js";
import { safeJournalPath, visibleToStudents } from "./journal.js";

describe("safeJournalPath", () => {
  it("accepts a plain path inside the journal", () => {
    expect(safeJournalPath("010-basics/020-pointers.md")).toBe("010-basics/020-pointers.md");
    expect(safeJournalPath("images/a%20b.png")).toBe("images/a b.png");
  });

  it("refuses every way out of the journal", () => {
    // A page path becomes a GitHub path on a write: this is the only thing
    // standing between a request and a file elsewhere in the repository.
    expect(safeJournalPath("../secrets.md")).toBeNull();
    expect(safeJournalPath("010-basics/../../etc/passwd")).toBeNull();
    expect(safeJournalPath("/etc/passwd")).toBeNull();
    expect(safeJournalPath("a/./b.md")).toBeNull();
    expect(safeJournalPath("a//b.md")).toBeNull();
    expect(safeJournalPath("C:\\secrets")).toBeNull();
    expect(safeJournalPath("%2e%2e/secrets.md")).toBeNull();
    expect(safeJournalPath("a\u0000b.md")).toBeNull();
    expect(safeJournalPath("")).toBeNull();
    expect(safeJournalPath("%zz")).toBeNull();
    expect(safeJournalPath("x".repeat(401))).toBeNull();
  });
});

describe("visibleToStudents", () => {
  let db: TestDb;
  let journalId: string;

  beforeEach(async () => {
    const app = await testApp();
    db = app.db;
    const orgId = randomUUID();
    const userId = randomUUID();
    journalId = randomUUID();
    await db.insert(organizations).values({ id: orgId, login: "heig-test" });
    await db.insert(users).values({
      id: userId,
      oidcSub: `sub-${userId}`,
      email: "prof@heig-vd.ch",
      givenName: "Ada",
      familyName: "Byron",
      role: "teacher",
    });
    await db.insert(journals).values({
      id: journalId,
      orgId,
      fullName: "heig-test/j",
      createdBy: userId,
    });
    const page = (path: string, over: Partial<typeof journalPages.$inferInsert> = {}) => ({
      id: randomUUID(),
      journalId,
      path,
      parentPath: "",
      sortKey: `1:${path}`,
      title: path,
      blobSha: "s",
      markdown: "",
      html: "",
      ...over,
    });
    await db.insert(journalPages).values([
      page("010-open.md"),
      page("020-draft.md", { draft: true }),
      page("030-future.md", { visibleFrom: new Date(Date.now() + 86_400_000) }),
      page("040-past.md", { visibleFrom: new Date(Date.now() - 86_400_000) }),
      page("050-draft-and-past.md", { draft: true, visibleFrom: new Date(0) }),
    ]);
  });

  it("hides a draft and a page whose date has not come", async () => {
    const rows = await db
      .select({ path: journalPages.path })
      .from(journalPages)
      .where(and(eq(journalPages.journalId, journalId), visibleToStudents()))
      .orderBy(journalPages.path);
    expect(rows.map((r) => r.path)).toEqual(["010-open.md", "040-past.md"]);
  });

  it("shows the staff everything", async () => {
    const rows = await db
      .select({ path: journalPages.path })
      .from(journalPages)
      .where(eq(journalPages.journalId, journalId));
    expect(rows).toHaveLength(5);
  });
});
