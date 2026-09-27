/*
 * A deliberately small code tokenizer for fenced blocks.
 *
 * Vendored from ~/heig-quiz (`apps/web/src/markdown/highlight.ts`), unchanged
 * except for this note: it is pure, has no dependency and no DOM, so the
 * server can use it at ingestion and the browser editor can use the same
 * token offsets for its ProseMirror decorations. One copy, two readers.
 *
 * Not a highlighter: Prism or Shiki would add 30–100 kB to a bundle a student
 * downloads on a phone, to colour four or five lines of C. Four token classes
 * — comment, string, number, keyword — carry the whole readability gain of
 * syntax colour; everything past that is decoration. Unknown languages fall
 * through to escaped text, which is the correct answer for a block of shell
 * output.
 */

/** Keywords per language family. One list per family, not per language. */
const KEYWORDS = {
  c: "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while NULL",
  cpp: "auto bool break case catch char class const constexpr continue default delete do double else enum explicit export extern false float for friend goto if inline int long namespace new nullptr operator private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while",
  js: "as async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield",
  python: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield",
  rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
  sql: "and as asc by create delete desc distinct drop from group having insert inner into join left limit not null on or order outer select set table update values where",
} as const;

/** Language tag of a fence -> the keyword family it borrows. */
const FAMILY: Record<string, keyof typeof KEYWORDS> = {
  c: "c",
  h: "c",
  cpp: "cpp",
  "c++": "cpp",
  hpp: "cpp",
  cc: "cpp",
  js: "js",
  javascript: "js",
  jsx: "js",
  ts: "js",
  typescript: "js",
  tsx: "js",
  json: "js",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  sql: "sql",
};

/** Line-comment opener per family; `/* … *\/` blocks are handled for the C ones. */
const LINE_COMMENT: Record<keyof typeof KEYWORDS, string> = {
  c: "//",
  cpp: "//",
  js: "//",
  python: "#",
  rust: "//",
  sql: "--",
};

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** HTML-escapes a plain-text run. Every token below goes through it. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** The language family a fence tag maps to, or null for "just escape it". */
function languageFamily(lang: string | undefined | null): keyof typeof KEYWORDS | null {
  if (!lang) return null;
  const tag = lang.trim().toLowerCase().split(/\s+/)[0] ?? "";
  return FAMILY[tag] ?? null;
}

/**
 * One coloured run inside a fenced block: OFFSETS INTO THE RAW TEXT, and the
 * class the stylesheet already styles under `.md-body` (`tok-com`, `tok-str`,
 * `tok-kw`, `tok-num`).
 *
 * Offsets and not strings, because this tokenizer has two readers: the
 * rendering pipeline, which turns them into `<span>`s (`highlight` below), and
 * an editor, which turns them into ProseMirror decorations over a text it does
 * not own. A decoration is a position range; a highlighter that only returns
 * HTML cannot serve it.
 */
export interface CodeToken {
  /** Offset of the first character of the run, in the raw code. */
  from: number;
  /** Offset one past its last character. */
  to: number;
  /** `tok-com` | `tok-str` | `tok-kw` | `tok-num`. */
  cls: string;
}

/**
 * The four token classes of one fenced block, in document order and never
 * overlapping. The scan is a single left-to-right pass, so a keyword inside a
 * string or a comment stays inside it — the one mistake a regex-per-class
 * approach always makes. An unknown language has no tokens at all, which is
 * the correct answer for a block of shell output.
 */
export function tokenize(code: string, lang?: string | null): CodeToken[] {
  const family = languageFamily(lang);
  if (!family) return [];
  const keywords = new Set(KEYWORDS[family].split(" "));
  const lineComment = LINE_COMMENT[family];
  const blockComments = family !== "python" && family !== "sql";
  const out: CodeToken[] = [];
  const token = (cls: string, from: number, to: number) => {
    if (to > from) out.push({ from, to, cls: `tok-${cls}` });
  };

  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i);
    if (rest.startsWith(lineComment)) {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      token("com", i, stop);
      i = stop;
      continue;
    }
    if (blockComments && rest.startsWith("/*")) {
      const end = code.indexOf("*/", i + 2);
      const stop = end === -1 ? code.length : end + 2;
      token("com", i, stop);
      i = stop;
      continue;
    }
    const quote = code[i]!;
    if (quote === '"' || quote === "'" || (quote === "`" && family === "js")) {
      let j = i + 1;
      while (j < code.length && code[j] !== quote) j += code[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, code.length);
      token("str", i, stop);
      i = stop;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (word) {
      const text = word[0];
      if (keywords.has(text)) token("kw", i, i + text.length);
      i += text.length;
      continue;
    }
    const num = /^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest);
    if (num) {
      token("num", i, i + num[0].length);
      i += num[0].length;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * Escaped HTML for one fenced block: the token spans of `tokenize`, everything
 * between them as escaped text. Safe to concatenate into a document: every run
 * it emits is escaped, the spans are the only markup, and their class is one
 * of the four constants above.
 */
export function highlight(code: string, lang?: string | null): string {
  const tokens = tokenize(code, lang);
  if (tokens.length === 0) return escapeHtml(code);
  let out = "";
  let last = 0;
  for (const { from, to, cls } of tokens) {
    if (from > last) out += escapeHtml(code.slice(last, from));
    out += `<span class="${cls}">${escapeHtml(code.slice(from, to))}</span>`;
    last = to;
  }
  return out + escapeHtml(code.slice(last));
}
