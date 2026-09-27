/**
 * Building the journal's read model from its repository (issue #45).
 *
 * Runs on a `push` webhook, after a browser save, and on the staff's explicit
 * Refresh — never on a page view. Idempotent: replaying it on the same commit
 * rewrites the same rows, so a retry after a partial failure is safe.
 *
 * Three decisions carry the cost of this job:
 *
 *  1. **Blobs are fetched only when their sha moved.** The tree listing gives
 *     every sha up front, and the mirror stores the sha it rendered from, so
 *     an unchanged page costs zero requests.
 *  2. **Every page is re-rendered anyway**, from the markdown already in the
 *     mirror. Rendering is microseconds and a page's HTML depends on its
 *     NEIGHBOURS — a link to a page that did not exist yesterday must become a
 *     link today — so rendering only what changed would leave stale hrefs.
 *  3. **Only assets a page actually references are downloaded.** A repository
 *     may carry the teacher's source files, a 40 MB video or last year's
 *     handouts; caching all of it in Postgres to serve none of it is how a
 *     2 GB VM runs out of disk.
 */
import { randomUUID } from "node:crypto";

import { and, eq, notInArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { placePage, relativeHref, type PagePlacement } from "@hgc/domain";

import { audit, type AuditAction } from "../audit.js";
import type { AppConfig } from "../config.js";
import {
  classroomJournals,
  journalAssets,
  journalPages,
  journals,
  organizations,
} from "../db/schema.js";
import { publish, type Topic } from "../events.js";
import { installationClient } from "../github/app.js";
import { JournalRepoError, readBlob, readTree, type TreeEntry } from "./repo.js";
import { renderPage } from "./render.js";

/**
 * An asset larger than this is not cached and not linked: the page reports it
 * instead. Course material is text, figures and handouts; a repository is a
 * poor blob store and every revision of a file stays in it forever.
 */
export const MAX_ASSET_BYTES = 5_000_000;

/** Content types served for the extensions a journal may carry. */
const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  pdf: "application/pdf",
  zip: "application/zip",
  csv: "text/csv",
  txt: "text/plain",
  json: "application/json",
  c: "text/plain",
  h: "text/plain",
  cpp: "text/plain",
  py: "text/plain",
};

export function assetContentType(path: string): string {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** URL the platform serves an asset of this journal at. */
export function assetUrl(journalId: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `/app/api/journals/${journalId}/assets/${encoded}`;
}

/** Everything under the journal root that is not a page, small enough to serve. */
function classifyAssets(entries: readonly TreeEntry[], rootPath: string) {
  const prefix = rootPath ? `${rootPath.replace(/\/+$/, "")}/` : "";
  const assets = new Map<string, TreeEntry>();
  const oversized: string[] = [];
  for (const e of entries) {
    if (/\.md$/i.test(e.path)) continue;
    if (prefix && !e.path.startsWith(prefix)) continue;
    const path = e.path.slice(prefix.length);
    // Repository furniture is not course material.
    if (!path || path.split("/").some((p) => p.startsWith("."))) continue;
    if (e.size > MAX_ASSET_BYTES) {
      oversized.push(path);
      continue;
    }
    assets.set(path, e);
  }
  return { assets, oversized };
}

export interface IngestOutcome {
  commitSha: string | null;
  pages: number;
  assets: number;
  /** Files too large to serve, reported to the staff. */
  oversized: string[];
}

/**
 * Rebuilds the mirror of one journal. Terminal problems (no installation, an
 * empty repository, a tree too large) are recorded on the journal row and NOT
 * thrown: they are the teacher's to fix, and a retry every 20 seconds would
 * fix nothing. Anything unexpected is rethrown, so pg-boss retries it.
 */
export async function ingestJournal(
  app: FastifyInstance,
  config: AppConfig,
  journalId: string,
): Promise<IngestOutcome | null> {
  const [row] = await app.db
    .select({ journal: journals, org: organizations })
    .from(journals)
    .innerJoin(organizations, eq(journals.orgId, organizations.id))
    .where(eq(journals.id, journalId))
    .limit(1);
  if (!row) return null;
  const { journal, org } = row;

  const fail = async (message: string) => {
    await app.db
      .update(journals)
      .set({ syncStatus: "error", syncError: message.slice(0, 500), lastSyncedAt: new Date() })
      .where(eq(journals.id, journalId));
    await notifyReaders(app, journalId);
    return null;
  };

  if (org.installationId === null) {
    return fail(`The GitHub App is not installed on ${org.login}`);
  }

  const [, repoName] = journal.fullName.split("/") as [string, string];
  let tree;
  try {
    const { octokit } = await installationClient(config, org.installationId);
    tree = await readTree(octokit, { org: org.login, repo: repoName, ref: journal.ref });
    return await mirror(app, journalId, journal, org.login, repoName, tree, octokit);
  } catch (err) {
    if (err instanceof JournalRepoError) {
      if (err.code === "empty") {
        // A repository with no commit on this ref has no pages. Emptying the
        // mirror is the honest answer, not keeping yesterday's copy.
        await app.db.delete(journalPages).where(eq(journalPages.journalId, journalId));
        await app.db.delete(journalAssets).where(eq(journalAssets.journalId, journalId));
        await app.db
          .update(journals)
          .set({
            syncStatus: "ok",
            syncError: null,
            lastCommitSha: null,
            lastSyncedAt: new Date(),
          })
          .where(eq(journals.id, journalId));
        await notifyReaders(app, journalId);
        return { commitSha: null, pages: 0, assets: 0, oversized: [] };
      }
      return fail(err.message);
    }
    if ((err as { status?: number }).status === 404) {
      return fail(`${journal.fullName} is no longer reachable with this installation`);
    }
    await app.db
      .update(journals)
      .set({ syncStatus: "error", syncError: String(err).slice(0, 500) })
      .where(eq(journals.id, journalId));
    throw err;
  }
}

async function mirror(
  app: FastifyInstance,
  journalId: string,
  journal: typeof journals.$inferSelect,
  orgLogin: string,
  repoName: string,
  tree: { commitSha: string; entries: TreeEntry[] },
  octokit: Awaited<ReturnType<typeof installationClient>>["octokit"],
): Promise<IngestOutcome> {
  const { assets, oversized } = classifyAssets(tree.entries, journal.rootPath);
  const placed: { entry: TreeEntry; place: PagePlacement }[] = [];
  for (const entry of tree.entries) {
    const place = placePage(entry.path, journal.rootPath);
    if (place) placed.push({ entry, place });
  }
  const pagePaths = new Set(placed.map((p) => p.place.path));
  const oversizedSet = new Set(oversized);

  const existing = await app.db
    .select({
      id: journalPages.id,
      path: journalPages.path,
      blobSha: journalPages.blobSha,
      markdown: journalPages.markdown,
    })
    .from(journalPages)
    .where(eq(journalPages.journalId, journalId));
  const known = new Map(existing.map((p) => [p.path, p]));

  /** Assets a page actually points at: the only ones worth downloading. */
  const referenced = new Set<string>();
  const rendered: (typeof journalPages.$inferInsert)[] = [];

  for (const { entry, place } of placed) {
    const before = known.get(place.path);
    const source =
      before && before.blobSha === entry.sha
        ? before.markdown
        : (await readBlob(octokit, { org: orgLogin, repo: repoName, sha: entry.sha })).toString(
            "utf8",
          );
    const page = renderPage(source, {
      pagePath: place.path,
      fallbackTitle: place.fallbackTitle,
      asset: (path) => {
        if (!assets.has(path)) return null;
        referenced.add(path);
        return assetUrl(journalId, path);
      },
      page: (path) => (pagePaths.has(path) ? relativeHref(place.path, path) : null),
      describeMissing: (path) =>
        oversizedSet.has(path)
          ? `${path} is larger than 5 MB: it is neither served nor linked.`
          : `${path} is not in the journal.`,
    });
    rendered.push({
      id: before?.id ?? randomUUID(),
      journalId,
      path: place.path,
      parentPath: place.parentPath,
      sortKey: place.sortKey,
      title: page.title,
      frontMatter: page.frontMatter,
      blobSha: entry.sha,
      markdown: source,
      html: page.html,
      toc: page.toc,
      draft: page.draft,
      visibleFrom: page.visibleFrom,
      warnings: page.warnings,
      updatedAt: new Date(),
    });
  }

  for (const page of rendered) {
    await app.db
      .insert(journalPages)
      .values(page)
      .onConflictDoUpdate({
        target: [journalPages.journalId, journalPages.path],
        set: {
          parentPath: page.parentPath,
          sortKey: page.sortKey,
          title: page.title,
          frontMatter: page.frontMatter,
          blobSha: page.blobSha,
          markdown: page.markdown,
          html: page.html,
          toc: page.toc,
          draft: page.draft,
          visibleFrom: page.visibleFrom,
          warnings: page.warnings,
          updatedAt: page.updatedAt,
        },
      });
  }
  // What the repository no longer holds.
  const keptPaths = [...pagePaths];
  await app.db
    .delete(journalPages)
    .where(
      keptPaths.length
        ? and(eq(journalPages.journalId, journalId), notInArray(journalPages.path, keptPaths))
        : eq(journalPages.journalId, journalId),
    );

  const cached = await app.db
    .select({ path: journalAssets.path, blobSha: journalAssets.blobSha })
    .from(journalAssets)
    .where(eq(journalAssets.journalId, journalId));
  const cachedShas = new Map(cached.map((a) => [a.path, a.blobSha]));
  for (const path of referenced) {
    const entry = assets.get(path)!;
    if (cachedShas.get(path) === entry.sha) continue;
    const data = await readBlob(octokit, { org: orgLogin, repo: repoName, sha: entry.sha });
    await app.db
      .insert(journalAssets)
      .values({
        id: randomUUID(),
        journalId,
        path,
        blobSha: entry.sha,
        contentType: assetContentType(path),
        size: data.length,
        data,
        cachedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [journalAssets.journalId, journalAssets.path],
        set: {
          blobSha: entry.sha,
          contentType: assetContentType(path),
          size: data.length,
          data,
          cachedAt: new Date(),
        },
      });
  }
  const keptAssets = [...referenced];
  await app.db
    .delete(journalAssets)
    .where(
      keptAssets.length
        ? and(eq(journalAssets.journalId, journalId), notInArray(journalAssets.path, keptAssets))
        : eq(journalAssets.journalId, journalId),
    );

  await app.db
    .update(journals)
    .set({
      lastCommitSha: tree.commitSha,
      lastSyncedAt: new Date(),
      syncStatus: "ok",
      syncError: null,
    })
    .where(eq(journals.id, journalId));
  await notifyReaders(app, journalId);

  return {
    commitSha: tree.commitSha,
    pages: rendered.length,
    assets: referenced.size,
    oversized,
  };
}

/** Every classroom reading this journal, as SSE topics. */
export async function journalTopics(app: FastifyInstance, journalId: string): Promise<Topic[]> {
  const rooms = await app.db
    .select({ classroomId: classroomJournals.classroomId })
    .from(classroomJournals)
    .where(eq(classroomJournals.journalId, journalId));
  return rooms.map((r) => `classroom:${r.classroomId}` as Topic);
}

async function notifyReaders(app: FastifyInstance, journalId: string) {
  const topics = await journalTopics(app, journalId);
  publish("journal", topics);
}

/**
 * The journals tracking a repository: a `push` arrives for a repository, and
 * two classrooms may follow two different branches of it.
 */
export async function journalsForPush(
  app: FastifyInstance,
  repoId: number,
  branch: string,
): Promise<{ id: string; lastCommitSha: string | null }[]> {
  return app.db
    .select({ id: journals.id, lastCommitSha: journals.lastCommitSha })
    .from(journals)
    .where(and(eq(journals.githubRepoId, repoId), eq(journals.ref, branch)));
}

/** Every journal held in a repository, whatever branch it tracks. */
export async function journalsOfRepo(
  app: FastifyInstance,
  repoId: number,
): Promise<{ id: string; fullName: string }[]> {
  return app.db
    .select({ id: journals.id, fullName: journals.fullName })
    .from(journals)
    .where(eq(journals.githubRepoId, repoId));
}

/** Audit helper shared by the routes that write to a journal. */
export async function auditJournal(
  app: FastifyInstance,
  opts: {
    userId: string;
    action: AuditAction;
    journalId: string;
    payload?: Record<string, unknown>;
  },
) {
  await audit(app.db, {
    actorUserId: opts.userId,
    actorType: "user",
    action: opts.action,
    subjectType: "journal",
    subjectId: opts.journalId,
    payload: opts.payload ?? {},
  });
}
