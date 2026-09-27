/**
 * Markdown -> HTML for one journal page, at INGESTION time (issue #45).
 *
 * The pipeline runs once per push, on the server, and what it produces is
 * stored. A student reading a page therefore downloads HTML and no markdown
 * library at all: `apps/web` carries none today and the reading path must keep
 * it that way (2 GB VM, phones in classrooms).
 *
 * Safety is by CONSTRUCTION, not by sanitisation. There is no DOMPurify here
 * and no jsdom in the image: instead every renderer below emits markup we
 * built ourselves, text goes through marked's escaping, and **raw HTML in the
 * markdown is escaped into visible text** rather than passed through. The
 * journal is staff-authored content rendered in every student's browser, and
 * "the author is a teacher" is not a trust boundary a browser knows about — a
 * borrowed push or a careless co-teacher must not turn into a classroom-wide
 * XSS. An author who typed `<div>` sees `<div>` on the page and one warning in
 * the staff view, which is the feedback that teaches the rule.
 *
 * KaTeX output is the one exception to "no generated markup we did not write",
 * and it is safe for the same reason: it is produced from the formula by a
 * library configured with `trust: false`, never copied out of the document.
 */
import { escapeHtml, highlight, resolveRelative } from "@hgc/domain";
import katex from "katex";
import { Marked, type Renderer, type Tokens } from "marked";
import { parse as parseYaml } from "yaml";

/** One heading of the page, for the in-page table of contents. */
export interface TocEntry {
  id: string;
  depth: number;
  text: string;
}

export interface RenderContext {
  /** Journal-relative path of the page being rendered. */
  pagePath: string;
  /** Title of last resort: the prettified file name. */
  fallbackTitle: string;
  /** Journal-relative asset path -> the URL the platform serves it at, or null. */
  asset: (path: string) => string | null;
  /** Journal-relative page path -> the in-app URL of that page, or null. */
  page: (path: string) => string | null;
  /**
   * How to phrase a reference that resolved to nothing. The default says the
   * path is not in the journal, which is the usual cause (a typo, a file never
   * committed); the ingestion overrides it for a file that IS there but is too
   * large to serve, because "not in the journal" would send the author looking
   * for the wrong mistake.
   */
  describeMissing?: (path: string) => string;
}

export interface RenderedPage {
  title: string;
  frontMatter: Record<string, unknown>;
  html: string;
  toc: TocEntry[];
  draft: boolean;
  visibleFrom: Date | null;
  /** What the author should know: nothing here stops a page from rendering. */
  warnings: string[];
}

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Splits the `---` block off the top of a page. A block that is not a mapping
 * (a list, a bare string, broken YAML) is reported and ignored rather than
 * guessed at: the page still renders, with its file name as its title.
 */
export function splitFrontMatter(source: string): {
  frontMatter: Record<string, unknown>;
  body: string;
  warnings: string[];
} {
  const m = FRONT_MATTER.exec(source);
  if (!m) return { frontMatter: {}, body: source, warnings: [] };
  const body = source.slice(m[0].length);
  try {
    const parsed = parseYaml(m[1]!) as unknown;
    if (parsed === null || parsed === undefined) return { frontMatter: {}, body, warnings: [] };
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return { frontMatter: {}, body, warnings: ["The front matter is not a list of keys."] };
    }
    return { frontMatter: parsed as Record<string, unknown>, body, warnings: [] };
  } catch (err) {
    return {
      frontMatter: {},
      body,
      warnings: [`The front matter is not valid YAML: ${(err as Error).message}`],
    };
  }
}

/** `draft: true`, `draft: "yes"`, `draft: 1` — anything a teacher may type. */
function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return /^(true|yes|y|on|1)$/i.test(value.trim());
  return false;
}

/**
 * `visible_from:` as a date. YAML already gives a `Date` for an unquoted
 * `2026-10-01 08:00`; a quoted string is parsed here. An unusable value is
 * reported and the page stays visible — hiding a page because its date is
 * misspelt is the wrong way round.
 */
function asDate(value: unknown): { date: Date | null; warning?: string } {
  if (value === null || value === undefined || value === "") return { date: null };
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? { date: null, warning: "`visible_from` is not a date." }
      : { date: value };
  }
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return { date: d };
  }
  return { date: null, warning: `\`visible_from\`: ${String(value)} is not a date.` };
}

/** Plain text of an inline token tree: what the table of contents shows. */
function plainText(tokens: readonly unknown[] | undefined): string {
  if (!tokens) return "";
  let out = "";
  for (const t of tokens as { tokens?: unknown[]; text?: string; raw?: string }[]) {
    if (t.tokens) out += plainText(t.tokens);
    else if (typeof t.text === "string") out += t.text;
  }
  return out;
}

/** Heading anchor: accent-folded, `[a-z0-9-]`, unique within the page. */
function headingId(text: string, taken: Set<string>): string {
  const base =
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "section";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** `https:`, `http:` and `mailto:` links leave the platform; nothing else does. */
const EXTERNAL = /^(https?|mailto):/i;

/**
 * The rendered page. One `Marked` instance per call, closed over the warnings
 * and the context: a shared instance would need the two to be globals, and the
 * ingestion of one page must not be able to leak into the next.
 */
export function renderPage(source: string, ctx: RenderContext): RenderedPage {
  const { frontMatter, body, warnings: fmWarnings } = splitFrontMatter(source);
  const warnings = [...fmWarnings];
  const toc: TocEntry[] = [];
  const ids = new Set<string>();
  let firstHeading: string | null = null;

  /** A reference to something in the repository, or null with a warning. */
  const resolve = (href: string, kind: "page" | "asset"): string | null => {
    const path = resolveRelative(ctx.pagePath, href);
    if (path === null) return null;
    const url = kind === "page" ? ctx.page(path) : ctx.asset(path);
    if (url === null) {
      warnings.push(
        ctx.describeMissing?.(path) ??
          `\`${href}\` points at ${path}, which is not in the journal.`,
      );
    }
    return url;
  };

  const marked = new Marked({
    gfm: true, // tables, task lists, strikethrough, autolinks
    breaks: false,
    renderer: {
      /**
       * Raw HTML never reaches the page: it is shown as the text the author
       * typed. One warning per page, not per tag — a page pasted out of Word
       * would otherwise report a hundred times.
       */
      html({ text }: Tokens.HTML | Tokens.Tag) {
        if (!warnings.includes(RAW_HTML_WARNING)) warnings.push(RAW_HTML_WARNING);
        return escapeHtml(text);
      },

      /** Fenced code: the language as a class, and the small tokenizer inside. */
      code({ text, lang }: Tokens.Code) {
        const tag = (lang ?? "").trim().split(/\s+/)[0] ?? "";
        const cls = tag ? ` class="language-${escapeHtml(tag.toLowerCase())}"` : "";
        return `<pre><code${cls}>${highlight(text, tag)}\n</code></pre>\n`;
      },

      /** Headings carry the anchor the table of contents and deep links use. */
      heading(this: Renderer, token: Tokens.Heading) {
        const text = plainText(token.tokens);
        const id = headingId(text, ids);
        if (token.depth === 1 && firstHeading === null) firstHeading = text;
        toc.push({ id, depth: token.depth, text });
        const inner = this.parser.parseInline(token.tokens);
        return `<h${token.depth} id="${id}">${inner}</h${token.depth}>\n`;
      },

      /**
       * An `<img>` can only come out of the repository. A relative path becomes
       * the platform's asset URL; an external one is dropped and leaves its alt
       * text behind, so the page still reads and the author sees that the image
       * did not take. Course material must not make 80 browsers call a third
       * party, and an image that lives in the repository also renders on
       * github.com — which is the whole point of the layout.
       */
      image({ href, title, text }: Tokens.Image) {
        const src = resolve(href ?? "", "asset");
        if (!src) {
          if (EXTERNAL.test((href ?? "").trim())) {
            warnings.push(`The image \`${href}\` is outside the journal: commit it instead.`);
          }
          return escapeHtml(text ?? "");
        }
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text ?? "")}"${titleAttr} loading="lazy">`;
      },

      /**
       * Three kinds of link, and nothing else: an in-page anchor, an external
       * `http(s)`/`mailto` one (new tab, no referrer), and a relative one —
       * a `.md` file becomes the in-app route of that page, any other file the
       * asset URL of that handout. A link that resolves nowhere keeps its text
       * and loses its href: a dead link must not become a link to the wrong
       * thing, and `javascript:` has no branch to fall into.
       */
      link(this: Renderer, { href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        const raw = (href ?? "").trim();
        if (raw.startsWith("#")) {
          return `<a href="${escapeHtml(raw)}"${titleAttr}>${inner}</a>`;
        }
        if (EXTERNAL.test(raw)) {
          return `<a href="${escapeHtml(raw)}"${titleAttr} target="_blank" rel="noreferrer">${inner}</a>`;
        }
        // The fragment is not part of the path: `020-pointers.md#stack` must
        // resolve the FILE and carry the anchor over to the in-app route.
        const cut = raw.indexOf("#");
        const path = cut === -1 ? raw : raw.slice(0, cut);
        const hash = cut === -1 ? "" : raw.slice(cut);
        const url = resolve(path, /\.md$/i.test(path) ? "page" : "asset");
        if (!url) return inner;
        return `<a href="${escapeHtml(url + hash)}"${titleAttr}>${inner}</a>`;
      },
    },
    extensions: [
      {
        name: "blockMath",
        level: "block",
        start: (src: string) => src.indexOf("$$"),
        tokenizer(src: string) {
          const m = /^\$\$([\s\S]+?)\$\$(?:[ \t]*(?:\r?\n|$))/.exec(src);
          return m ? { type: "blockMath", raw: m[0], text: m[1]!.trim() } : undefined;
        },
        renderer: (token: Tokens.Generic) => math(String(token.text ?? ""), true, warnings),
      },
      {
        name: "inlineMath",
        level: "inline",
        start: (src: string) => {
          const i = src.indexOf("$");
          return i === -1 ? undefined : i;
        },
        tokenizer(src: string) {
          const m = /^\$((?:[^$\\\n]|\\.)+?)\$/.exec(src);
          return m ? { type: "inlineMath", raw: m[0], text: m[1]! } : undefined;
        },
        renderer: (token: Tokens.Generic) => math(String(token.text ?? ""), false, warnings),
      },
    ],
  });

  const html = marked.parse(body) as string;
  const fmTitle = typeof frontMatter.title === "string" ? frontMatter.title.trim() : "";
  const { date: visibleFrom, warning } = asDate(frontMatter.visible_from);
  if (warning) warnings.push(warning);

  return {
    title: fmTitle || firstHeading || ctx.fallbackTitle,
    frontMatter,
    html,
    toc,
    draft: asBoolean(frontMatter.draft),
    visibleFrom,
    warnings,
  };
}

const RAW_HTML_WARNING =
  "Raw HTML is shown as text, not rendered: use markdown (see the journal README).";

/**
 * One formula. `throwOnError` is deliberately ON so the author gets a warning
 * instead of a red blob nobody reports; the broken source is kept visible as
 * code, which is what it is.
 */
function math(source: string, display: boolean, warnings: string[]): string {
  try {
    return katex.renderToString(source, {
      displayMode: display,
      throwOnError: true,
      strict: false,
      trust: false,
      output: "htmlAndMathml",
    });
  } catch (err) {
    warnings.push(`Formula \`${source}\`: ${(err as Error).message}`);
    const cls = display ? "md-math-error md-math-block" : "md-math-error";
    return `<code class="${cls}">${escapeHtml(source)}</code>`;
  }
}
