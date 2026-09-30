/**
 * The classroom journal API (issue #45).
 *
 * The journal is a private GitHub repository of the classroom's organization,
 * mirrored into `journal_pages` by the ingestion. Two consequences shape every
 * route below:
 *
 * - **Reads never touch GitHub.** They select from the mirror, so a page view
 *   costs one query and a GitHub outage leaves the journal readable.
 * - **Writes go to GitHub first**, with the blob sha the editor opened the page
 *   at as an optimistic lock, and only then re-ingest. A teacher editing in the
 *   browser and a teacher pushing from a clone write the same files, and the
 *   loser of a race gets a 409, never a silent overwrite.
 *
 * One read surface serves the staff and the students (`readableClassroom`),
 * because two parallel surfaces would be two places to forget that a draft is
 * not for students.
 */
import { randomUUID } from "node:crypto";

import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { buildNav, homePage, journalRepoName, relativeHref, type NavPage } from "@hgc/domain";
import type { JournalPage, JournalPayload, JournalRepoInfo } from "@hgc/contracts";

import type { AppConfig } from "../config.js";
import {
  classroomJournals,
  classroomStaff,
  classrooms,
  journalAssets,
  journalPages,
  journals,
  organizations,
  users,
} from "../db/schema.js";
import { classroomTopics, publish } from "../events.js";
import { installationClient } from "../github/app.js";
import { inviteCollaborator } from "../github/collaborators.js";
import {
  assetContentType,
  assetUrl,
  auditJournal,
  ingestJournal,
  MAX_ASSET_BYTES,
} from "../journal/ingest.js";
import { renderPage } from "../journal/render.js";
import {
  createJournalRepo,
  deleteFile,
  JournalRepoError,
  putFile,
  resolveRepo,
  type CommitAuthor,
} from "../journal/repo.js";
import { slugify } from "./assignments/shared.js";
import { readableClassroom, teacherGuard } from "./guards.js";

/** The README a new journal starts with: the layout, in the repository itself. */
const SEED_README = `# Journal

This repository is the journal of a classroom on HEIG Classroom. Everything in
it is rendered for the students of that classroom, who never see the repository
itself.

## How it is organised

There is no configuration file: the layout of the repository IS the navigation.

\`\`\`
README.md              this page, the front page of the journal
010-basics/
  README.md            the landing page of the section, and its title
  010-variables.md
  020-pointers.md
  images/pointers.svg  referenced as ![](images/pointers.svg)
\`\`\`

- Pages are sorted by file name, so a numeric prefix decides the order. Use
  steps of ten (\`010-\`, \`020-\`) and inserting a page renumbers nothing.
- The prefix is never displayed. A page is titled by its \`title:\` front
  matter, else by its first \`#\` heading, else by its file name.
- \`README.md\` in a directory titles that section. A directory without one is
  a heading that opens nothing.
- Links and images are relative (\`images/p.svg\`, \`../010-basics/020-pointers.md\`),
  so the same markdown reads correctly here on GitHub and in the platform.

## Front matter

\`\`\`yaml
---
title: What is a pointer
date: 2026-10-01
draft: true              # staff only: prepare a page without publishing it
visible_from: 2026-10-08 # hidden from the students until then
---
\`\`\`

## Two ways to write it

Edit the pages in the platform, or clone this repository and push — both write
these files. Raw HTML is shown as text rather than rendered, and images must be
committed here: a page cannot pull one from another site.
`;

const PagePathParam = z.object({ id: z.uuid(), "*": z.string().min(1).max(400) });

/**
 * A path inside the journal, validated as a path and nothing else. Reads go to
 * the mirror (where a bad path simply matches no row), but writes become a
 * GitHub path, and `..` is how a journal would start writing outside itself.
 */
export function safeJournalPath(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!decoded || decoded.length > 400) return null;
  if (decoded.startsWith("/") || decoded.includes("\\")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(decoded)) return null;
  const parts = decoded.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return parts.join("/");
}

/** Only markdown files are pages; the rest of the tree is assets. */
function safePagePath(raw: string): string | null {
  const path = safeJournalPath(raw);
  return path && /\.md$/i.test(path) ? path : null;
}

/** What a student is allowed to see: published, and past its reveal date. */
export function visibleToStudents() {
  return and(
    eq(journalPages.draft, false),
    or(isNull(journalPages.visibleFrom), sql`${journalPages.visibleFrom} <= now()`),
  )!;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function repoInfo(journal: typeof journals.$inferSelect): JournalRepoInfo {
  return {
    id: journal.id,
    fullName: journal.fullName,
    ref: journal.ref,
    htmlUrl: `https://github.com/${journal.fullName}`,
    cloneUrl: `git@github.com:${journal.fullName}.git`,
    syncStatus: journal.syncStatus,
    syncError: journal.syncError,
    lastSyncedAt: iso(journal.lastSyncedAt),
    lastCommitSha: journal.lastCommitSha,
    // Nothing can be written before the mirror knows what it is writing over.
    editable: journal.syncStatus === "ok" && journal.lastCommitSha !== null,
  };
}

/** The journal attached to a classroom, with its organization. */
async function journalOf(app: FastifyInstance, classroomId: string) {
  const [row] = await app.db
    .select({ journal: journals, org: organizations })
    .from(classroomJournals)
    .innerJoin(journals, eq(classroomJournals.journalId, journals.id))
    .innerJoin(organizations, eq(journals.orgId, organizations.id))
    .where(eq(classroomJournals.classroomId, classroomId))
    .limit(1);
  return row ?? null;
}

export async function journalPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const requireTeacher = teacherGuard(app);
  const base = "/app/api/classrooms/:id/journal";

  /** The journal of a classroom the viewer may read, or null after a 404. */
  const readScope = async (req: FastifyRequest, reply: FastifyReply) => {
    const access = await readableClassroom(app, req, reply);
    if (!access) return null;
    const attached = await journalOf(app, access.room.id);
    return { ...access, attached };
  };

  /** Staff-only scope with a journal attached; 409 when there is none. */
  const writeScope = async (req: FastifyRequest, reply: FastifyReply) => {
    const access = await readableClassroom(app, req, reply);
    if (!access) return null;
    if (!access.staff) {
      await reply.code(403).send({ error: "forbidden" });
      return null;
    }
    const attached = await journalOf(app, access.room.id);
    if (!attached) {
      await reply.code(409).send({ error: "no_journal", message: "This classroom has no journal" });
      return null;
    }
    if (attached.org.installationId === null) {
      await reply.code(409).send({
        error: "app_not_installed",
        message: `GitHub App is not installed on ${attached.org.login}`,
      });
      return null;
    }
    return { ...access, journal: attached.journal, org: attached.org };
  };

  /** Who the commit is attributed to: the teacher, so `git log` names them. */
  const authorOf = async (userId: string): Promise<CommitAuthor | undefined> => {
    const [u] = await app.db
      .select({ given: users.givenName, family: users.familyName, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!u?.email) return undefined;
    const name = `${u.given ?? ""} ${u.family ?? ""}`.trim();
    return { name: name || u.email, email: u.email };
  };

  const client = (org: { installationId: number | null }) =>
    installationClient(config, org.installationId!);

  /**
   * Re-ingests right after a write, so the editor shows the saved state
   * without waiting for the webhook — which then arrives and is a no-op,
   * because the commit sha it carries is already the mirror's.
   */
  const reingest = async (journalId: string) => {
    try {
      await ingestJournal(app, config, journalId);
    } catch (err) {
      app.log.warn({ err, journalId }, "journal re-ingestion after a write failed");
    }
  };

  // ---------------------------------------------------------------- reading

  app.get(
    base,
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const scope = await readScope(req, reply);
      if (!scope) return reply;
      const { room, staff, attached } = scope;
      const [org] = await app.db
        .select()
        .from(organizations)
        .where(eq(organizations.id, room.orgId))
        .limit(1);

      if (!attached) {
        const payload: JournalPayload = {
          classroomId: room.id,
          classroomName: room.name,
          orgLogin: org?.login ?? "",
          staff,
          journal: null,
          nav: [],
          homePath: null,
          ...(staff
            ? {
                proposedName: journalRepoName(slugify(room.name) || "classroom"),
                appInstalled: org?.installationId !== null,
              }
            : {}),
        };
        return payload;
      }

      const rows = await app.db
        .select({
          path: journalPages.path,
          parentPath: journalPages.parentPath,
          sortKey: journalPages.sortKey,
          title: journalPages.title,
          draft: journalPages.draft,
          visibleFrom: journalPages.visibleFrom,
          warnings: journalPages.warnings,
        })
        .from(journalPages)
        .where(
          staff
            ? eq(journalPages.journalId, attached.journal.id)
            : and(eq(journalPages.journalId, attached.journal.id), visibleToStudents()),
        );
      const now = new Date();
      const hidden = rows
        .filter((r) => r.draft || (r.visibleFrom !== null && r.visibleFrom > now))
        .map((r) => r.path);
      const nav: NavPage[] = rows.map((r) => ({
        path: r.path,
        parentPath: r.parentPath,
        sortKey: r.sortKey,
        title: r.title,
      }));
      const payload: JournalPayload = {
        classroomId: room.id,
        classroomName: room.name,
        orgLogin: attached.org.login,
        staff,
        journal: repoInfo(attached.journal),
        nav: buildNav(nav),
        homePath: homePage(nav)?.path ?? null,
        ...(staff
          ? {
              appInstalled: attached.org.installationId !== null,
              hiddenCount: hidden.length,
              hiddenPaths: hidden,
              warningCount: rows.filter((r) => (r.warnings as string[]).length > 0).length,
            }
          : {}),
      };
      return payload;
    },
  );

  app.get(
    `${base}/pages/*`,
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const params = PagePathParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const path = safePagePath(params.data["*"]);
      if (!path) return reply.code(404).send({ error: "not_found" });
      const scope = await readScope(req, reply);
      if (!scope) return reply;
      if (!scope.attached) return reply.code(404).send({ error: "not_found" });
      const [page] = await app.db
        .select()
        .from(journalPages)
        .where(
          and(
            eq(journalPages.journalId, scope.attached.journal.id),
            eq(journalPages.path, path),
            ...(scope.staff ? [] : [visibleToStudents()]),
          ),
        )
        .limit(1);
      if (!page) return reply.code(404).send({ error: "not_found" });
      const hidden = page.draft || (page.visibleFrom !== null && page.visibleFrom > new Date());
      const payload: JournalPage = {
        path: page.path,
        title: page.title,
        html: page.html,
        toc: page.toc as JournalPage["toc"],
        updatedAt: page.updatedAt.toISOString(),
        hidden,
        draft: page.draft,
        visibleFrom: iso(page.visibleFrom),
        ...(scope.staff
          ? {
              markdown: page.markdown,
              blobSha: page.blobSha,
              warnings: page.warnings as string[],
            }
          : {}),
      };
      return payload;
    },
  );

  /**
   * Assets are journal-scoped and not classroom-scoped: the rendered HTML is
   * stored once and read by every classroom the journal is attached to, so a
   * classroom id in the URL would bake one cohort into the others' pages.
   * Access is still enrollment-based — the repository is private and this is
   * the only door to it.
   */
  app.get(
    "/app/api/journals/:jid/assets/*",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const params = z
        .object({ jid: z.uuid(), "*": z.string().min(1).max(400) })
        .safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const path = safeJournalPath(params.data["*"]);
      if (!path) return reply.code(404).send({ error: "not_found" });
      const me = req.user!.id;
      const [allowed] = await app.db
        .select({ id: classroomJournals.classroomId })
        .from(classroomJournals)
        .innerJoin(classrooms, eq(classroomJournals.classroomId, classrooms.id))
        .where(
          and(
            eq(classroomJournals.journalId, params.data.jid),
            or(
              eq(classrooms.teacherId, me),
              sql`EXISTS (SELECT 1 FROM ${classroomStaff} WHERE ${classroomStaff.classroomId} = ${classrooms.id} AND ${classroomStaff.userId} = ${me})`,
              sql`EXISTS (SELECT 1 FROM enrollments e WHERE e.classroom_id = ${classrooms.id} AND e.user_id = ${me} AND e.status = 'claimed')`,
            ),
          ),
        )
        .limit(1);
      if (!allowed && req.user!.role !== "admin") {
        return reply.code(404).send({ error: "not_found" });
      }
      const [asset] = await app.db
        .select()
        .from(journalAssets)
        .where(
          and(eq(journalAssets.journalId, params.data.jid), eq(journalAssets.path, path)),
        )
        .limit(1);
      if (!asset) return reply.code(404).send({ error: "not_found" });
      if (req.headers["if-none-match"] === `"${asset.blobSha}"`) return reply.code(304).send();
      return reply
        .header("content-type", asset.contentType)
        .header("etag", `"${asset.blobSha}"`)
        .header("cache-control", "private, max-age=0, must-revalidate")
        // An SVG committed by a teacher is still a document a browser would run
        // scripts from if it were opened directly: this makes that impossible
        // without refusing the format course diagrams come in.
        .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
        .header("x-content-type-options", "nosniff")
        .send(asset.data);
    },
  );

  // --------------------------------------------------------- the repository

  app.post(base, { preHandler: requireTeacher }, async (req, reply) => {
    const access = await readableClassroom(app, req, reply);
    if (!access) return reply;
    if (!access.staff) return reply.code(403).send({ error: "forbidden" });
    const body = z
      .object({ name: z.string().min(1).max(100).optional() })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    if (await journalOf(app, access.room.id)) {
      return reply.code(409).send({ error: "already_attached" });
    }
    const [org] = await app.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, access.room.orgId))
      .limit(1);
    if (!org || org.installationId === null) {
      return reply.code(409).send({ error: "app_not_installed" });
    }
    const proposed = journalRepoName(slugify(access.room.name) || "classroom");
    const name = body.data.name ? slugify(body.data.name) : proposed;
    if (!name) return reply.code(400).send({ error: "invalid_name" });

    const { octokit } = await client(org);
    let created;
    try {
      created = await createJournalRepo(octokit, {
        org: org.login,
        name,
        description: `Journal of ${access.room.name}`,
        readme: SEED_README,
      });
    } catch (err) {
      if (err instanceof JournalRepoError && err.code === "name_taken") {
        // Deterministic, so a retry of a creation that failed halfway computes
        // the same name instead of littering the organization.
        const fallback = journalRepoName(
          slugify(access.room.name) || "classroom",
          access.room.id.slice(0, 8),
        );
        if (name !== fallback) {
          return reply.code(409).send({
            error: "name_taken",
            message: `${org.login}/${name} already exists`,
            suggestion: fallback,
          });
        }
        throw err;
      }
      throw err;
    }

    const journalId = randomUUID();
    await app.db.insert(journals).values({
      id: journalId,
      orgId: org.id,
      githubRepoId: created.repoId,
      fullName: created.fullName,
      ref: created.defaultBranch,
      createdBy: req.user!.id,
    });
    await app.db.insert(classroomJournals).values({
      classroomId: access.room.id,
      journalId,
      attachedBy: req.user!.id,
    });
    await auditJournal(app, {
      userId: req.user!.id,
      action: "journal.create",
      journalId,
      payload: { fullName: created.fullName, classroomId: access.room.id },
    });
    await inviteStaff(app, octokit, org.login, name, access.room.id);
    await ingestJournal(app, config, journalId);
    return reply.code(201).send({ id: journalId, fullName: created.fullName });
  });

  /**
   * Attaches a repository that already exists — the way a journal is SHARED
   * between classrooms, and the only way an existing repository is ever taken
   * over. Creation never adopts on a name collision: adopting a repository
   * that already has content would render another course's material to the
   * wrong cohort.
   */
  app.post(`${base}/attach`, { preHandler: requireTeacher }, async (req, reply) => {
    const access = await readableClassroom(app, req, reply);
    if (!access) return reply;
    if (!access.staff) return reply.code(403).send({ error: "forbidden" });
    const body = z
      .object({
        fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
        ref: z.string().min(1).max(200).optional(),
        rootPath: z.string().max(200).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    if (await journalOf(app, access.room.id)) {
      return reply.code(409).send({ error: "already_attached" });
    }
    const [org] = await app.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, access.room.orgId))
      .limit(1);
    if (!org || org.installationId === null) {
      return reply.code(409).send({ error: "app_not_installed" });
    }
    // Only inside the classroom's own organization: the installation token has
    // no business reaching anywhere else, and a journal is course material of
    // this org.
    const [owner] = body.data.fullName.split("/") as [string, string];
    if (owner.toLowerCase() !== org.login.toLowerCase()) {
      return reply.code(400).send({
        error: "foreign_org",
        message: `The journal must live in ${org.login}`,
      });
    }
    const { octokit } = await client(org);
    let resolved;
    try {
      resolved = await resolveRepo(octokit, body.data.fullName);
    } catch (err) {
      if (err instanceof JournalRepoError) {
        return reply.code(404).send({ error: "not_found", message: err.message });
      }
      throw err;
    }
    const ref = body.data.ref ?? resolved.defaultBranch;
    const rootPath = (body.data.rootPath ?? "").replace(/^\/+|\/+$/g, "");
    // One mirror per (repository, ref): a journal already tracked at this ref
    // is REUSED, which is what makes sharing a course between classrooms free.
    const [existing] = await app.db
      .select()
      .from(journals)
      .where(and(eq(journals.githubRepoId, resolved.repoId), eq(journals.ref, ref)))
      .limit(1);
    const journalId = existing?.id ?? randomUUID();
    if (!existing) {
      await app.db.insert(journals).values({
        id: journalId,
        orgId: org.id,
        githubRepoId: resolved.repoId,
        fullName: resolved.fullName,
        ref,
        rootPath,
        createdBy: req.user!.id,
      });
    }
    await app.db.insert(classroomJournals).values({
      classroomId: access.room.id,
      journalId,
      attachedBy: req.user!.id,
    });
    await auditJournal(app, {
      userId: req.user!.id,
      action: "journal.attach",
      journalId,
      payload: { fullName: resolved.fullName, ref, classroomId: access.room.id, reused: !!existing },
    });
    const [, repoName] = resolved.fullName.split("/") as [string, string];
    await inviteStaff(app, octokit, org.login, repoName, access.room.id);
    await ingestJournal(app, config, journalId);
    return reply.code(201).send({ id: journalId, fullName: resolved.fullName, reused: !!existing });
  });

  /** Detaches the journal from the classroom. The repository is never touched. */
  app.delete(base, { preHandler: requireTeacher }, async (req, reply) => {
    const access = await readableClassroom(app, req, reply);
    if (!access) return reply;
    if (!access.staff) return reply.code(403).send({ error: "forbidden" });
    const attached = await journalOf(app, access.room.id);
    if (!attached) return reply.code(204).send();
    await app.db
      .delete(classroomJournals)
      .where(eq(classroomJournals.classroomId, access.room.id));
    // The mirror of a journal nobody reads any more is dead weight; the
    // repository, and therefore the content, is untouched.
    const [stillRead] = await app.db
      .select({ id: classroomJournals.classroomId })
      .from(classroomJournals)
      .where(eq(classroomJournals.journalId, attached.journal.id))
      .limit(1);
    if (!stillRead) await app.db.delete(journals).where(eq(journals.id, attached.journal.id));
    await auditJournal(app, {
      userId: req.user!.id,
      action: "journal.detach",
      journalId: attached.journal.id,
      payload: { classroomId: access.room.id, mirrorDropped: !stillRead },
    });
    return reply.code(204).send();
  });

  app.post(`${base}/refresh`, { preHandler: requireTeacher }, async (req, reply) => {
    const scope = await writeScope(req, reply);
    if (!scope) return reply;
    await auditJournal(app, {
      userId: req.user!.id,
      action: "journal.refresh",
      journalId: scope.journal.id,
    });
    const outcome = await ingestJournal(app, config, scope.journal.id);
    return reply.send(outcome ?? { pages: 0, assets: 0, oversized: [], commitSha: null });
  });

  /**
   * The rendered form of markdown that is not committed yet: the editor's
   * preview. It runs the INGESTION's renderer, against this journal's own
   * pages and assets, so what the author sees is what the students will get —
   * a preview built from a second, client-side markdown library would differ in
   * exactly the cases that matter (a link that does not resolve, an image
   * outside the repository, a formula that does not compile).
   */
  app.post(`${base}/preview`, { preHandler: requireTeacher }, async (req, reply) => {
    const body = z
      .object({ markdown: z.string().max(500_000), path: z.string().min(1).max(400) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const path = safePagePath(body.data.path);
    if (!path) return reply.code(400).send({ error: "invalid_path" });
    const scope = await writeScope(req, reply);
    if (!scope) return reply;
    const known = await app.db
      .select({ path: journalPages.path })
      .from(journalPages)
      .where(eq(journalPages.journalId, scope.journal.id));
    const pagePaths = new Set(known.map((p) => p.path));
    const assets = await app.db
      .select({ path: journalAssets.path })
      .from(journalAssets)
      .where(eq(journalAssets.journalId, scope.journal.id));
    const assetPaths = new Set(assets.map((a) => a.path));
    const rendered = renderPage(body.data.markdown, {
      pagePath: path,
      fallbackTitle: path.split("/").pop() ?? path,
      asset: (p) => (assetPaths.has(p) ? assetUrl(scope.journal.id, p) : null),
      page: (p) => (pagePaths.has(p) ? relativeHref(path, p) : null),
    });
    return reply.send({
      html: rendered.html,
      title: rendered.title,
      toc: rendered.toc,
      warnings: rendered.warnings,
      draft: rendered.draft,
      visibleFrom: rendered.visibleFrom?.toISOString() ?? null,
    });
  });

  // ---------------------------------------------------------------- writing

  app.put(`${base}/pages/*`, { preHandler: requireTeacher }, async (req, reply) => {
    const params = PagePathParam.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const path = safePagePath(params.data["*"]);
    if (!path) return reply.code(400).send({ error: "invalid_path" });
    const body = z
      .object({
        markdown: z.string().max(500_000),
        /** Blob sha the editor opened the page at; absent creates the file. */
        baseSha: z.string().min(1).max(64).optional(),
        message: z.string().min(1).max(200).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const scope = await writeScope(req, reply);
    if (!scope) return reply;
    const [, repoName] = scope.journal.fullName.split("/") as [string, string];
    const full = scope.journal.rootPath ? `${scope.journal.rootPath}/${path}` : path;
    try {
      const { octokit } = await client(scope.org);
      await putFile(octokit, {
        org: scope.org.login,
        repo: repoName,
        branch: scope.journal.ref,
        path: full,
        message: body.data.message ?? `Update ${path}`,
        content: Buffer.from(body.data.markdown, "utf8"),
        baseSha: body.data.baseSha,
        author: await authorOf(req.user!.id),
      });
    } catch (err) {
      if (err instanceof JournalRepoError) {
        return reply.code(err.code === "conflict" ? 409 : 400).send({
          error: err.code,
          message: err.message,
        });
      }
      throw err;
    }
    await auditJournal(app, {
      userId: req.user!.id,
      action: "journal.page.update",
      journalId: scope.journal.id,
      payload: { path },
    });
    await reingest(scope.journal.id);
    const [saved] = await app.db
      .select({ blobSha: journalPages.blobSha, title: journalPages.title })
      .from(journalPages)
      .where(and(eq(journalPages.journalId, scope.journal.id), eq(journalPages.path, path)))
      .limit(1);
    return reply.send({ path, blobSha: saved?.blobSha ?? null, title: saved?.title ?? null });
  });

  app.post(`${base}/pages`, { preHandler: requireTeacher }, async (req, reply) => {
    const body = z
      .object({
        path: z.string().min(1).max(400),
        title: z.string().min(1).max(200).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const path = safePagePath(body.data.path);
    if (!path) return reply.code(400).send({ error: "invalid_path" });
    const scope = await writeScope(req, reply);
    if (!scope) return reply;
    const [taken] = await app.db
      .select({ id: journalPages.id })
      .from(journalPages)
      .where(and(eq(journalPages.journalId, scope.journal.id), eq(journalPages.path, path)))
      .limit(1);
    if (taken) return reply.code(409).send({ error: "page_exists" });
    const title = body.data.title?.trim();
    const markdown = title ? `# ${title}\n` : "";
    const [, repoName] = scope.journal.fullName.split("/") as [string, string];
    const full = scope.journal.rootPath ? `${scope.journal.rootPath}/${path}` : path;
    try {
      const { octokit } = await client(scope.org);
      await putFile(octokit, {
        org: scope.org.login,
        repo: repoName,
        branch: scope.journal.ref,
        path: full,
        message: `Add ${path}`,
        content: Buffer.from(markdown, "utf8"),
        author: await authorOf(req.user!.id),
      });
    } catch (err) {
      if (err instanceof JournalRepoError) {
        return reply.code(err.code === "conflict" ? 409 : 400).send({ error: err.code, message: err.message });
      }
      throw err;
    }
    await auditJournal(app, {
      userId: req.user!.id,
      action: "journal.page.create",
      journalId: scope.journal.id,
      payload: { path },
    });
    await reingest(scope.journal.id);
    return reply.code(201).send({ path });
  });

  app.delete(`${base}/pages/*`, { preHandler: requireTeacher }, async (req, reply) => {
    const params = PagePathParam.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const path = safePagePath(params.data["*"]);
    if (!path) return reply.code(400).send({ error: "invalid_path" });
    const scope = await writeScope(req, reply);
    if (!scope) return reply;
    const [page] = await app.db
      .select({ blobSha: journalPages.blobSha })
      .from(journalPages)
      .where(and(eq(journalPages.journalId, scope.journal.id), eq(journalPages.path, path)))
      .limit(1);
    if (!page) return reply.code(404).send({ error: "not_found" });
    const [, repoName] = scope.journal.fullName.split("/") as [string, string];
    const full = scope.journal.rootPath ? `${scope.journal.rootPath}/${path}` : path;
    try {
      const { octokit } = await client(scope.org);
      await deleteFile(octokit, {
        org: scope.org.login,
        repo: repoName,
        branch: scope.journal.ref,
        path: full,
        message: `Remove ${path}`,
        baseSha: page.blobSha,
        author: await authorOf(req.user!.id),
      });
    } catch (err) {
      if (err instanceof JournalRepoError) {
        return reply.code(err.code === "conflict" ? 409 : 400).send({ error: err.code, message: err.message });
      }
      throw err;
    }
    await auditJournal(app, {
      userId: req.user!.id,
      action: "journal.page.delete",
      journalId: scope.journal.id,
      payload: { path },
    });
    await reingest(scope.journal.id);
    return reply.code(204).send();
  });

  /**
   * An image pasted or dropped in the editor. Raw binary, like the avatar
   * route: the platform has no multipart parser and one file per request is
   * all an editor ever needs.
   */
  app.post(
    `${base}/assets/*`,
    { preHandler: requireTeacher, bodyLimit: MAX_ASSET_BYTES },
    async (req, reply) => {
      const params = PagePathParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: "not_found" });
      const path = safeJournalPath(params.data["*"]);
      if (!path || /\.md$/i.test(path)) return reply.code(400).send({ error: "invalid_path" });
      const data = req.body as Buffer;
      if (!Buffer.isBuffer(data) || data.length === 0) {
        return reply.code(400).send({ error: "empty_body" });
      }
      const declared = (req.headers["content-type"] ?? "").split(";")[0]!.trim();
      if (declared !== assetContentType(path)) {
        return reply.code(415).send({
          error: "type_mismatch",
          message: `${path} does not match ${declared}`,
        });
      }
      const scope = await writeScope(req, reply);
      if (!scope) return reply;
      const [, repoName] = scope.journal.fullName.split("/") as [string, string];
      const full = scope.journal.rootPath ? `${scope.journal.rootPath}/${path}` : path;
      const [existing] = await app.db
        .select({ blobSha: journalAssets.blobSha })
        .from(journalAssets)
        .where(and(eq(journalAssets.journalId, scope.journal.id), eq(journalAssets.path, path)))
        .limit(1);
      try {
        const { octokit } = await client(scope.org);
        await putFile(octokit, {
          org: scope.org.login,
          repo: repoName,
          branch: scope.journal.ref,
          path: full,
          message: `Add ${path}`,
          content: data,
          baseSha: existing?.blobSha,
          author: await authorOf(req.user!.id),
        });
      } catch (err) {
        if (err instanceof JournalRepoError) {
          return reply
            .code(err.code === "conflict" ? 409 : err.code === "too_large" ? 413 : 400)
            .send({ error: err.code, message: err.message });
        }
        throw err;
      }
      await auditJournal(app, {
        userId: req.user!.id,
        action: "journal.asset.upload",
        journalId: scope.journal.id,
        payload: { path, bytes: data.length },
      });
      await reingest(scope.journal.id);
      return reply.code(201).send({ path });
    },
  );
}

/**
 * Invites the classroom's staff on the journal repository, so the expert path
 * (clone, edit, push) works without anyone touching GitHub's settings. Only
 * those who linked a GitHub account can be invited; the others simply keep
 * editing in the browser, which is the point of having two paths.
 */
async function inviteStaff(
  app: FastifyInstance,
  octokit: Awaited<ReturnType<typeof installationClient>>["octokit"],
  orgLogin: string,
  repoName: string,
  classroomId: string,
) {
  const people = await app.db
    .select({ login: users.githubLogin })
    .from(classrooms)
    .innerJoin(users, eq(users.id, classrooms.teacherId))
    .where(eq(classrooms.id, classroomId))
    .union(
      app.db
        .select({ login: users.githubLogin })
        .from(classroomStaff)
        .innerJoin(users, eq(users.id, classroomStaff.userId))
        .where(eq(classroomStaff.classroomId, classroomId)),
    );
  for (const { login } of people) {
    if (!login) continue;
    try {
      await inviteCollaborator(octokit, orgLogin, repoName, login, "push");
    } catch (err) {
      // A staff member who cannot be invited (refused invitations, a renamed
      // account) must not fail the creation of the journal.
      app.log.warn({ err, login, repoName }, "journal collaborator invitation failed");
    }
  }
  publish("journal", classroomTopics(classroomId));
}
