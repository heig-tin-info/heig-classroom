# ADR-015 — The classroom journal: GitHub holds the content, Postgres holds a read model

## Status

Accepted (2026-09-27, issue #45). Reading, writing and ingestion implemented on the same day;
the rich WYSIWYG editing surface is deferred, see "Consequences".

## Context

A classroom needs a place for course material — lecture notes, code examples, figures,
formulas, handouts. Until now the only content a classroom carried was its assignments, so
everything else lived outside the platform and students had two addresses for one course.

The platform already stores plenty *about* repositories: their provisioning state, their head
commit, their grades. The journal is the first time it would store **content**, and that
raises a question the rest of the product never had to answer: where does a page actually
live?

Two teachers were in the room, and they are not the same person:

- the one who wants a Notion-like editor and does not care that there is a git repository
  under it;
- the one who would rather clone the thing, write in their own editor, and push.

Serving only the first is what Moodle does, and it locks the material inside the platform.
Serving only the second is a static-site generator, which the students would have to be sent
to. Serving both from two content models would be two sources of truth and a merge problem.

## Decision

**The journal is a private GitHub repository of the classroom's organization. GitHub is
authoritative for the content; Postgres holds a rendered read model, rebuilt from a push or
from a browser save.**

1. **The repository is the content.** One markdown file per page, the repository's own layout
   is the navigation (MkDocs-style: alphabetical order, numeric prefixes for control,
   `README.md` as the landing page of a directory). No manifest file, no cell records, no
   identifiers injected into the markdown — a file a human edits in `vim` must stay a file a
   human edits in `vim`.
2. **Postgres is a read model, never the thing a teacher edits.** `journal_pages` holds the
   markdown, the rendered HTML, the table of contents and the blob sha it was rendered from.
   A page view is one `SELECT` and never a GitHub call, which is what makes the feature
   affordable on a 1 vCPU / 2 GB VM shared with the production database.
3. **Rendering happens once, at ingestion, on the server.** The reading path carries no
   markdown library at all. Raw HTML in the markdown is **escaped into visible text** rather
   than sanitised, so the output is safe by construction and the image needs no DOM-based
   sanitiser.
4. **Nothing is cloned server-side.** The Contents and Trees API only. Assignment provisioning
   shells out to `git` into a temporary directory, which is right for pushing a history; a
   journal only needs single files and one tree listing.
5. **Writes go to GitHub first, with an optimistic lock.** The blob sha the editor opened the
   page at travels with the save; GitHub answers 409 if someone pushed in between. The platform
   never compares contents and never merges: the loser of a race is told, and their draft is
   kept in their browser.
6. **Creation never adopts an existing repository.** `provisionStudentRepo` treats a 422 as
   "step already done" and adopts, which is right for a repository it alone writes to. Here it
   would hand a classroom whatever material sat under that name. Attaching an existing
   repository is a separate, deliberate action — and it is also how one journal serves several
   classrooms.
7. **One mirror per (repository, ref).** Two classrooms sharing a journal share the row; a
   classroom pinned to last semester's branch gets its own row on the same repository.

## Alternatives considered

- **Content in Postgres, with an export to a repository later.** Cheaper to write, and wrong
  in the long run: retrofitting git-as-truth onto database-as-truth means two sources of truth
  and a conflict semantics invented after the fact. If git is the destination, going there
  first is the cheaper path.
- **Cells with identifiers, Notion-style, serialised to markdown.** The "cells" of the feature
  request are an *editing* affordance, and an editor provides them without persisting them.
  Serialising them would mean `<!-- cell:a3f -->` markers throughout the file: illegible in the
  repository and destroyed by the first hand edit.
- **Rendering on read, client-side.** It would put a markdown parser, KaTeX and a sanitiser in
  the bundle of every student and re-render the same page on every view. Rendering at ingestion
  costs the same work once per push.
- **Cloning the repository to render it.** Disk and a git process per classroom on a VM that
  has neither to spare.

## Consequences

- A GitHub outage degrades the journal to **read-only** instead of breaking it: the mirror
  answers every read.
- The rendering pipeline is a **second markdown implementation** in the organization, next to
  the one in `~/heig-quiz`. The pure pieces are shared by copy (`codeHighlight.ts` is vendored
  into `packages/domain`), the rest is not. This is accepted, with the seam named: the editing
  component takes `value` / `onChange` / `onUploadImage`, which is exactly the shape of the
  Tiptap surface of the quiz. Vendoring that surface requires decoupling it *there* first, in
  another repository, so this change ships the source editor plus a server-rendered preview and
  leaves the WYSIWYG one to a follow-up.
- Reordering a page is a **rename**, because the order lives in the file names. Steps of ten
  make it rare; when it happens the Trees API applies it as one commit.
- A repository is a poor blob store: every revision of an image stays in it forever. Assets are
  capped at 5 MB, and only the ones a page actually references are downloaded and cached.
- The staff must be collaborators on the journal repository for the expert path to work. The
  platform invites them; students never are — the repository is private and the platform is its
  only reader.
