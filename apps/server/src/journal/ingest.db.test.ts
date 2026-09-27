/**
 * The journal read model, built from a repository that only exists as a stub
 * of the two endpoints the ingestion uses (issue #45).
 *
 * What is being pinned here is the cost model as much as the result: an
 * unchanged page fetches no blob, an asset nothing points at is never
 * downloaded, and a file the repository no longer holds leaves the mirror.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";
import {
  classroomJournals,
  classrooms,
  journalAssets,
  journalPages,
  journals,
  organizations,
  users,
} from "../db/schema.js";
import { subscribe, type AppEvent } from "../events.js";
import { testApp, type TestDb } from "../test/db.js";
import { ingestJournal, MAX_ASSET_BYTES } from "./ingest.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../github/app.js", () => ({
  installationClient: async () => ({ octokit: { request }, token: "t" }),
}));

const config = {} as AppConfig;

/** A file of the fake repository: its path, its content, its sha. */
interface Blob {
  path: string;
  content: string | Buffer;
  sha: string;
}

/** Stubs the two endpoints `ingestJournal` calls, and counts the blob reads. */
function repoWith(blobs: Blob[], opts: { commit?: string; truncated?: boolean } = {}) {
  const reads: string[] = [];
  request.mockReset();
  request.mockImplementation(async (route: string, params: Record<string, string>) => {
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}") {
      return { data: { sha: opts.commit ?? "c".repeat(40) } };
    }
    if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
      return {
        data: {
          truncated: opts.truncated ?? false,
          tree: blobs.map((b) => ({
            path: b.path,
            type: "blob",
            sha: b.sha,
            size: Buffer.from(b.content as string).length,
          })),
        },
      };
    }
    if (route === "GET /repos/{owner}/{repo}/git/blobs/{file_sha}") {
      reads.push(params.file_sha!);
      const blob = blobs.find((b) => b.sha === params.file_sha);
      if (!blob) throw Object.assign(new Error("no blob"), { status: 404 });
      return {
        data: { content: Buffer.from(blob.content as string).toString("base64"), encoding: "base64" },
      };
    }
    throw new Error(`unexpected route ${route}`);
  });
  return { reads };
}

/** A big blob without allocating one: only `size` is read from the tree. */
function oversized(path: string, sha: string): Blob {
  return { path, content: "x".repeat(MAX_ASSET_BYTES + 1), sha };
}

let db: TestDb;
let app: Awaited<ReturnType<typeof testApp>>;
let journalId: string;
let classroomId: string;

beforeEach(async () => {
  app = await testApp();
  db = app.db;
  const orgId = randomUUID();
  const userId = randomUUID();
  classroomId = randomUUID();
  journalId = randomUUID();
  await db.insert(organizations).values({ id: orgId, login: "heig-test", installationId: 42 });
  await db.insert(users).values({
    id: userId,
    oidcSub: `sub-${userId}`,
    email: "prof@heig-vd.ch",
    givenName: "Ada",
    familyName: "Byron",
    role: "teacher",
  });
  await db
    .insert(classrooms)
    .values({ id: classroomId, orgId, teacherId: userId, name: "Prog C 2026" });
  await db.insert(journals).values({
    id: journalId,
    orgId,
    githubRepoId: 777,
    fullName: "heig-test/prog-c-2026-journal",
    ref: "main",
    createdBy: userId,
  });
  await db
    .insert(classroomJournals)
    .values({ classroomId, journalId, attachedBy: userId });
});

const pagesOf = () =>
  db
    .select()
    .from(journalPages)
    .where(eq(journalPages.journalId, journalId))
    .orderBy(journalPages.path);

describe("ingestJournal", () => {
  it("mirrors the pages of the repository, titled and placed", async () => {
    repoWith([
      { path: "README.md", content: "# The course\n", sha: "s1" },
      { path: "010-basics/README.md", content: "---\ntitle: Basics\n---\nIntro\n", sha: "s2" },
      { path: "010-basics/020-pointers.md", content: "## A heading\n", sha: "s3" },
      { path: "Makefile", content: "all:\n", sha: "s4" },
    ]);
    const out = await ingestJournal(app, config, journalId);
    expect(out).toMatchObject({ pages: 3, assets: 0 });
    const pages = await pagesOf();
    expect(pages.map((p) => [p.path, p.title, p.parentPath])).toEqual([
      ["010-basics/020-pointers.md", "Pointers", "010-basics"],
      ["010-basics/README.md", "Basics", "010-basics"],
      ["README.md", "The course", ""],
    ]);
    // A file that is not markdown is not a page.
    expect(pages.some((p) => p.path === "Makefile")).toBe(false);
  });

  it("records the commit it was built from and reports success", async () => {
    repoWith([{ path: "README.md", content: "# A\n", sha: "s1" }], { commit: "d".repeat(40) });
    await ingestJournal(app, config, journalId);
    const [journal] = await db.select().from(journals).where(eq(journals.id, journalId));
    expect(journal).toMatchObject({ syncStatus: "ok", syncError: null, lastCommitSha: "d".repeat(40) });
    expect(journal!.lastSyncedAt).not.toBeNull();
  });

  it("fetches no blob for a page whose sha did not move", async () => {
    const blobs = [
      { path: "README.md", content: "# A\n", sha: "s1" },
      { path: "010-b.md", content: "# B\n", sha: "s2" },
    ];
    repoWith(blobs);
    await ingestJournal(app, config, journalId);
    // Second pass: one page edited, the other untouched.
    const second = repoWith([
      { path: "README.md", content: "# A\n", sha: "s1" },
      { path: "010-b.md", content: "# B revised\n", sha: "s2-new" },
    ]);
    await ingestJournal(app, config, journalId);
    expect(second.reads).toEqual(["s2-new"]);
    const pages = await pagesOf();
    expect(pages.find((p) => p.path === "010-b.md")!.title).toBe("B revised");
  });

  it("re-renders every page, so a link to a new page stops being dead", async () => {
    repoWith([{ path: "README.md", content: "See [later](./010-later.md)\n", sha: "s1" }]);
    await ingestJournal(app, config, journalId);
    let [home] = await pagesOf().then((p) => p.filter((x) => x.path === "README.md"));
    expect(home!.html).not.toContain("<a ");
    expect(home!.warnings as string[]).toHaveLength(1);

    repoWith([
      { path: "README.md", content: "See [later](./010-later.md)\n", sha: "s1" },
      { path: "010-later.md", content: "# Later\n", sha: "s2" },
    ]);
    await ingestJournal(app, config, journalId);
    [home] = await pagesOf().then((p) => p.filter((x) => x.path === "README.md"));
    expect(home!.html).toContain('href="./010-later.md"');
    expect(home!.warnings as string[]).toHaveLength(0);
  });

  it("downloads only the assets a page points at", async () => {
    const { reads } = repoWith([
      { path: "README.md", content: "![p](images/used.png)\n", sha: "s1" },
      { path: "images/used.png", content: "PNG-BYTES", sha: "a1" },
      { path: "images/unused.png", content: "NEVER-READ", sha: "a2" },
      { path: "video.mp4", content: "HUGE", sha: "a3" },
    ]);
    const out = await ingestJournal(app, config, journalId);
    expect(out).toMatchObject({ assets: 1 });
    expect(reads).toEqual(["s1", "a1"]);
    const cached = await db.select().from(journalAssets).where(eq(journalAssets.journalId, journalId));
    expect(cached.map((a) => a.path)).toEqual(["images/used.png"]);
    expect(cached[0]!.contentType).toBe("image/png");
    // PGlite hands bytea back as a Uint8Array where pg gives a Buffer.
    expect(Buffer.from(cached[0]!.data).toString()).toBe("PNG-BYTES");
  });

  it("neither serves nor links a file over the size cap, and says why", async () => {
    repoWith([
      { path: "README.md", content: "![big](images/big.png)\n", sha: "s1" },
      oversized("images/big.png", "a1"),
    ]);
    await ingestJournal(app, config, journalId);
    const [home] = await pagesOf();
    expect(home!.html).not.toContain("<img");
    expect((home!.warnings as string[]).join()).toMatch(/larger than 5 MB/);
    expect(await db.select().from(journalAssets)).toHaveLength(0);
  });

  it("drops what the repository no longer holds", async () => {
    repoWith([
      { path: "README.md", content: "![p](images/p.png)\n", sha: "s1" },
      { path: "010-gone.md", content: "# Gone\n", sha: "s2" },
      { path: "images/p.png", content: "BYTES", sha: "a1" },
    ]);
    await ingestJournal(app, config, journalId);
    expect(await pagesOf()).toHaveLength(2);

    repoWith([{ path: "README.md", content: "Nothing left\n", sha: "s3" }]);
    await ingestJournal(app, config, journalId);
    expect((await pagesOf()).map((p) => p.path)).toEqual(["README.md"]);
    expect(await db.select().from(journalAssets)).toHaveLength(0);
  });

  it("keeps the page id stable across ingestions", async () => {
    repoWith([{ path: "README.md", content: "# A\n", sha: "s1" }]);
    await ingestJournal(app, config, journalId);
    const first = (await pagesOf())[0]!.id;
    repoWith([{ path: "README.md", content: "# A revised\n", sha: "s2" }]);
    await ingestJournal(app, config, journalId);
    expect((await pagesOf())[0]!.id).toBe(first);
  });

  it("carries the visibility of the front matter into the mirror", async () => {
    repoWith([
      { path: "010-draft.md", content: "---\ndraft: true\n---\n# Soon\n", sha: "s1" },
      { path: "020-timed.md", content: "---\nvisible_from: 2030-01-01\n---\n# Later\n", sha: "s2" },
      { path: "030-open.md", content: "# Now\n", sha: "s3" },
    ]);
    await ingestJournal(app, config, journalId);
    const pages = await pagesOf();
    expect(pages.map((p) => [p.path, p.draft, p.visibleFrom !== null])).toEqual([
      ["010-draft.md", true, false],
      ["020-timed.md", false, true],
      ["030-open.md", false, false],
    ]);
  });

  it("empties the mirror of a repository with no commit, without failing", async () => {
    repoWith([{ path: "README.md", content: "# A\n", sha: "s1" }]);
    await ingestJournal(app, config, journalId);
    request.mockReset();
    request.mockImplementation(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}") {
        throw Object.assign(new Error("empty"), { status: 409 });
      }
      throw new Error(`unexpected ${route}`);
    });
    const out = await ingestJournal(app, config, journalId);
    expect(out).toMatchObject({ pages: 0, commitSha: null });
    expect(await pagesOf()).toHaveLength(0);
    const [journal] = await db.select().from(journals).where(eq(journals.id, journalId));
    expect(journal!.syncStatus).toBe("ok");
  });

  it("records a truncated tree as an error and keeps the pages it had", async () => {
    repoWith([{ path: "README.md", content: "# A\n", sha: "s1" }]);
    await ingestJournal(app, config, journalId);
    repoWith([{ path: "README.md", content: "# A\n", sha: "s1" }], { truncated: true });
    expect(await ingestJournal(app, config, journalId)).toBeNull();
    const [journal] = await db.select().from(journals).where(eq(journals.id, journalId));
    expect(journal!.syncStatus).toBe("error");
    expect(journal!.syncError).toMatch(/too large/);
    // The classroom keeps reading what was last ingested successfully.
    expect(await pagesOf()).toHaveLength(1);
  });

  it("reports a missing installation instead of calling GitHub", async () => {
    await db.update(organizations).set({ installationId: null });
    repoWith([]);
    expect(await ingestJournal(app, config, journalId)).toBeNull();
    const [journal] = await db.select().from(journals).where(eq(journals.id, journalId));
    expect(journal!.syncError).toMatch(/not installed/);
    expect(request).not.toHaveBeenCalled();
  });

  it("tells the classrooms that read it to refresh", async () => {
    repoWith([{ path: "README.md", content: "# A\n", sha: "s1" }]);
    const seen: AppEvent[] = [];
    const off = subscribe((e) => seen.push(e));
    try {
      await ingestJournal(app, config, journalId);
    } finally {
      off();
    }
    expect(seen).toEqual([{ type: "journal", topics: [`classroom:${classroomId}`] }]);
  });

  it("is a no-op on a journal that does not exist", async () => {
    expect(await ingestJournal(app, config, randomUUID())).toBeNull();
  });

  it("serves the root of a journal that lives in a sub-directory", async () => {
    await db.update(journals).set({ rootPath: "docs" }).where(eq(journals.id, journalId));
    repoWith([
      { path: "docs/README.md", content: "# The course\n", sha: "s1" },
      { path: "README.md", content: "# The repository\n", sha: "s2" },
      { path: "docs/images/p.png", content: "BYTES", sha: "a1" },
    ]);
    await ingestJournal(app, config, journalId);
    const pages = await pagesOf();
    expect(pages.map((p) => p.path)).toEqual(["README.md"]);
    expect(pages[0]!.title).toBe("The course");
  });

  it("keeps two journals of the same repository apart", async () => {
    const second = randomUUID();
    const [journal] = await db.select().from(journals).where(eq(journals.id, journalId));
    await db.insert(journals).values({
      ...journal!,
      id: second,
      ref: "2025-autumn",
      lastCommitSha: null,
      syncStatus: "pending",
    });
    repoWith([{ path: "README.md", content: "# Main\n", sha: "s1" }]);
    await ingestJournal(app, config, journalId);
    repoWith([{ path: "README.md", content: "# Last year\n", sha: "s9" }]);
    await ingestJournal(app, config, second);
    const mine = await db
      .select({ title: journalPages.title })
      .from(journalPages)
      .where(and(eq(journalPages.journalId, journalId), eq(journalPages.path, "README.md")));
    const theirs = await db
      .select({ title: journalPages.title })
      .from(journalPages)
      .where(and(eq(journalPages.journalId, second), eq(journalPages.path, "README.md")));
    expect(mine[0]!.title).toBe("Main");
    expect(theirs[0]!.title).toBe("Last year");
  });
});
