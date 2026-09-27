/**
 * How a file tree becomes a course navigation (issue #45).
 *
 * The journal has no manifest file: the repository's own layout IS the
 * structure, the way MkDocs reads a `docs/` directory when no `nav` is
 * configured. Everything here is that convention, as pure functions — the
 * server applies them at ingestion, and they are the part of the feature a
 * teacher can predict without reading any code:
 *
 *   README.md                  the front page
 *   010-basics/
 *     README.md                the landing page of the section
 *     010-variables.md
 *     020-pointers.md
 *     images/pointers.svg
 *   020-tooling/
 *     README.md
 *
 * - **Order** is alphabetical on the raw file name, the landing page first.
 *   Numeric prefixes are how a teacher takes control of it, in steps of ten so
 *   that inserting a page renumbers nothing.
 * - **Titles** never show the prefix: it is ordering, not naming.
 */

/** A markdown page. Anything else in the tree is an asset. */
export function isPageFile(path: string): boolean {
  return /\.md$/i.test(path);
}

/**
 * The landing page of its directory. `README.md` first because github.com
 * renders it when a teacher browses the directory there — the expert path gets
 * the section introduction for free — with `index.md` accepted as a synonym
 * for anyone coming from a static-site generator.
 */
export function isIndexFile(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return /^(readme|index)\.md$/i.test(name);
}

/** `010-pointers.md` -> `pointers`. Also eats `01_`, `1.` and `010 `. */
export function stripOrderPrefix(name: string): string {
  return name.replace(/^\d+\s*[-_.)\s]\s*/, "");
}

/**
 * The title shown when the file says nothing else: the file name without its
 * prefix and extension, dashes and underscores opened up, first letter
 * capitalised. `010-what-is-a-pointer.md` -> `What is a pointer`.
 */
export function prettifyName(path: string): string {
  const base = (path.split("/").pop() ?? "").replace(/\.md$/i, "");
  const words = stripOrderPrefix(base).replace(/[-_]+/g, " ").trim();
  if (!words) return base || "Untitled";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What the navigation sorts siblings on: a rank, then the raw file name
 * lowercased — raw, so the numeric prefix still decides, which is the whole
 * point of writing one. The landing page of a directory takes rank `0` and
 * therefore comes before its pages, which is the reading order of a section.
 *
 * The rank is a printable digit and not a control character: this value is
 * stored in a Postgres `text` column, and `text` cannot hold a NUL byte at all
 * (`invalid byte sequence for encoding "UTF8": 0x00`).
 */
export function navSortKey(path: string): string {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  return `${isIndexFile(path) ? "0" : "1"}:${name}`;
}

/** The directory holding a path; "" at the root. */
export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * Resolves a relative reference written in a page against that page's own
 * directory, the way a reader of the repository would: this is what makes
 * `![](images/pointers.svg)` and `[see](../010-basics/020-pointers.md)` render
 * both on github.com and in the platform.
 *
 * Returns null for anything that is not a plain relative path inside the tree:
 * an absolute path, a URL, a Windows path, or a `../` chain that climbs out of
 * the repository. Null means "do not link it", never "link it somewhere else".
 */
export function resolveRelative(fromPage: string, href: string): string | null {
  const raw = href.trim();
  if (!raw || raw.startsWith("/") || raw.startsWith("#") || raw.includes("\\")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null; // has a scheme
  const out: string[] = parentOf(fromPage).split("/").filter(Boolean);
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null; // climbs above the root
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.length === 0 ? null : out.join("/");
}

/** A page as the navigation needs it, before its content is known. */
export interface PagePlacement {
  path: string;
  parentPath: string;
  sortKey: string;
  /** Prefix-stripped, prettified file name: the title of last resort. */
  fallbackTitle: string;
  /** True for the landing page of its directory. */
  index: boolean;
}

/**
 * Where one file sits in the navigation. `rootPath` is the sub-directory the
 * journal lives in, stripped from the paths the navigation exposes so that
 * moving a journal into a `docs/` folder does not rename every page.
 */
export function placePage(repoPath: string, rootPath = ""): PagePlacement | null {
  if (!isPageFile(repoPath)) return null;
  const prefix = rootPath ? `${rootPath.replace(/\/+$/, "")}/` : "";
  if (prefix && !repoPath.startsWith(prefix)) return null;
  const path = repoPath.slice(prefix.length);
  if (!path) return null;
  return {
    path,
    parentPath: parentOf(path),
    sortKey: navSortKey(path),
    fallbackTitle: prettifyName(path),
    index: isIndexFile(path),
  };
}

/** A node of the navigation tree the API hands to the web app. */
export interface NavNode {
  /** Path of the page, or of the directory for a section with no landing page. */
  path: string;
  title: string;
  /** The page to open when the entry is clicked; null for a bare section. */
  pagePath: string | null;
  children: NavNode[];
}

/** The minimum a page must expose to be placed in the navigation. */
export interface NavPage {
  path: string;
  parentPath: string;
  sortKey: string;
  title: string;
}

/**
 * The navigation tree of a journal: pages nested under the directory they sit
 * in, each level sorted on the file or directory name — raw, so a numeric
 * prefix decides, which is the whole point of writing one.
 *
 * A landing page is never an entry of its own: the one at the root IS the
 * journal's home page (the view shows it as such, not as a first chapter), and
 * the one in a directory NAMES that directory's section. A section without a
 * landing page is a heading that opens nothing rather than a hole in the tree.
 */
export function buildNav(pages: readonly NavPage[]): NavNode[] {
  const byParent = new Map<string, NavPage[]>();
  for (const p of pages) {
    const list = byParent.get(p.parentPath);
    if (list) list.push(p);
    else byParent.set(p.parentPath, [p]);
  }
  // Every directory that holds at least one page, at any depth: a directory
  // holding only assets (`images/`) is not a section.
  const dirs = new Set<string>();
  for (const p of pages) {
    const parts = p.parentPath.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }

  /** Last segment of a path: what siblings are compared on, pages and sections alike. */
  const segment = (path: string) => (path.split("/").pop() ?? "").toLowerCase();

  const nodesFor = (parent: string): NavNode[] => {
    const out: NavNode[] = [];
    for (const page of byParent.get(parent) ?? []) {
      if (isIndexFile(page.path)) continue; // home page, or names its section
      out.push({ path: page.path, title: page.title, pagePath: page.path, children: [] });
    }
    for (const dir of dirs) {
      if (parentOf(dir) !== parent || dir === parent) continue;
      const landing = (byParent.get(dir) ?? []).find((p) => isIndexFile(p.path));
      out.push({
        path: dir,
        title: landing ? landing.title : prettifyName(dir),
        pagePath: landing ? landing.path : null,
        children: nodesFor(dir),
      });
    }
    return out.sort((a, b) => {
      const ka = segment(a.path);
      const kb = segment(b.path);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  };

  return nodesFor("");
}

/** The front page of a journal: the landing page at the root, if there is one. */
export function homePage<T extends { path: string }>(pages: readonly T[]): T | undefined {
  return pages.find((p) => parentOf(p.path) === "" && isIndexFile(p.path));
}

/**
 * The href one page uses to link another, RELATIVE to the linking page.
 *
 * Relative and not absolute, because the same rendered HTML is read by every
 * classroom the journal is attached to, and stored once: an absolute
 * `/classrooms/<id>/journal/...` would bake one classroom into a page the
 * others read. A relative href resolves against whatever the view is mounted
 * on — which is also exactly how the same link works when the repository is
 * browsed on github.com.
 *
 * `from` and `to` are journal-relative page paths. The result is resolved by
 * the browser against the directory of `from`, so the router only has to read
 * the resulting pathname.
 */
export function relativeHref(from: string, to: string): string {
  const fromDir = parentOf(from).split("/").filter(Boolean);
  const toParts = to.split("/").filter(Boolean);
  let common = 0;
  while (common < fromDir.length && common < toParts.length - 1 && fromDir[common] === toParts[common]) {
    common += 1;
  }
  const up = fromDir.length - common;
  const down = toParts.slice(common).join("/");
  // No `../` to climb and nothing to descend into means a sibling: `./` keeps
  // it a relative reference even when the file name looks like a scheme.
  return up === 0 ? `./${down}` : `${"../".repeat(up)}${down}`;
}
