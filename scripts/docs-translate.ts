#!/usr/bin/env tsx
/**
 * docs-translate — generate the French documentation tree from the English one.
 *
 * English under `docs/` is the reference. French under `docs/fr/` is generated
 * by this script with the Claude API and committed to the repository, together
 * with a cache (`docs/.translation-cache.json`) so that editing one English
 * page does not retranslate the whole site.
 *
 * Usage:
 *   pnpm docs:translate                      translate everything that changed
 *   pnpm docs:translate --file docs/index.md only that page
 *   pnpm docs:translate --dry-run            report what would be translated
 *   pnpm docs:translate --check              exit 1 if a unit has no cached
 *                                            French text (CI; no API key)
 *   pnpm docs:translate --seed-from-existing record the French tree already on
 *                                            disk as the cached translation
 *                                            (first seed, or after a manual
 *                                            correction of a French page)
 *
 * Translation unit: one Markdown *section* — the preamble before the first
 * `## ` heading, then each `## ` heading with everything under it. Per-section
 * is the compromise between per-block (fine cache granularity, poor coherence)
 * and per-file (good coherence, one edit invalidates the whole page): a section
 * is small enough that a typo fix only costs one API call, and large enough
 * that the model keeps a consistent voice and can resolve the references inside
 * it. `## ` markers inside fenced code blocks never split a section.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DOCS_DIR = path.join(ROOT, "docs");
const FR_DIR = path.join(DOCS_DIR, "fr");
const CACHE_FILE = path.join(DOCS_DIR, ".translation-cache.json");
const GLOSSARY_FILE = path.join(DOCS_DIR, "i18n-glossary.md");

/** Overridable so a cheaper model can be used for a throwaway run. */
const MODEL = process.env.DOCS_TRANSLATE_MODEL ?? "claude-opus-5";
const MAX_TOKENS = 32000;
const CONCURRENCY = Number(process.env.DOCS_TRANSLATE_CONCURRENCY ?? "4");

/**
 * Markdown files under `docs/` that document the pipeline itself rather than
 * the product. They stay English-only; `extra.untranslated` in `zensical.toml`
 * hides the French entry of the language switch on them.
 */
const EXCLUDED = new Set(["TRANSLATION.md", "i18n-glossary.md"]);

const CACHE_VERSION = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Unit {
  /** Path of the English source, relative to `docs/`. */
  readonly file: string;
  /** Index of the section inside that file. */
  readonly index: number;
  /** The English Markdown of this section, without the trailing blank lines. */
  readonly text: string;
}

interface Cache {
  version: number;
  model: string;
  glossary: string;
  /** SHA-256 of (unit text + model + glossary hash) -> French Markdown. */
  entries: Record<string, string>;
}

interface Options {
  check: boolean;
  dryRun: boolean;
  seed: boolean;
  file: string | null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    check: false,
    dryRun: false,
    seed: false,
    file: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--check":
        options.check = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--seed-from-existing":
        options.seed = true;
        break;
      case "--file": {
        const value = argv[i + 1];
        if (value === undefined) {
          fail("--file requires a path, for example --file docs/index.md");
        }
        options.file = value;
        i += 1;
        break;
      }
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        fail(`unknown option: ${String(arg)} (try --help)`);
    }
  }
  return options;
}

function printHelp(): void {
  process.stdout.write(
    [
      "docs-translate — generate docs/fr/** from docs/** with the Claude API",
      "",
      "  --check                 exit 1 if any English unit has no up-to-date",
      "                          French translation in the cache (no API call)",
      "  --file <path>           restrict the run to one English page",
      "  --dry-run               list what would be translated, call nothing",
      "  --seed-from-existing    record the French files already on disk as the",
      "                          cached translation of their English units",
      "  --help                  this text",
      "",
      "Environment: ANTHROPIC_API_KEY (required except for --check, --dry-run",
      "and --seed-from-existing), DOCS_TRANSLATE_MODEL, DOCS_TRANSLATE_CONCURRENCY",
      "",
    ].join("\n"),
  );
}

function fail(message: string): never {
  process.stderr.write(`docs-translate: ${message}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Markdown splitting
// ---------------------------------------------------------------------------

/**
 * Split a Markdown document into sections: the preamble (front matter, title,
 * intro) and then one unit per `## ` heading. Fenced code blocks are opaque —
 * a `## ` inside a fence is a comment, not a heading.
 */
export function splitIntoUnits(file: string, source: string): Unit[] {
  const lines = source.split("\n");
  const chunks: string[][] = [[]];
  let fence: string | null = null;

  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] as string;
      if (fence === null) {
        fence = marker[0] as string;
      } else if (marker.startsWith(fence)) {
        fence = null;
      }
    }
    if (fence === null && /^##\s+\S/.test(line)) {
      chunks.push([]);
    }
    (chunks[chunks.length - 1] as string[]).push(line);
  }

  const units: Unit[] = [];
  for (const chunk of chunks) {
    const text = chunk.join("\n").replace(/\s+$/, "");
    if (text.length === 0) continue;
    units.push({ file, index: units.length, text });
  }
  return units;
}

/** Re-assemble a document from its translated units. */
function joinUnits(texts: readonly string[]): string {
  return `${texts.map((text) => text.replace(/\s+$/, "")).join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Cache key = SHA-256 of the English unit, the model id and the glossary hash,
 * joined by NUL so the three fields cannot be confused with one another.
 *
 * The source path is deliberately *not* part of the key: identical units (the
 * `## Status` section of thirteen ADRs, a shared warning) are translated once
 * and reused everywhere. Changing the model or a glossary entry invalidates
 * every key at once, which is the point — a new glossary must be applied to the
 * whole site, not only to the pages that happen to change next.
 */
export function cacheKey(
  unitText: string,
  model: string,
  glossaryHash: string,
): string {
  return sha256(`${unitText} ${model} ${glossaryHash}`);
}

function emptyCache(glossaryHash: string): Cache {
  return {
    version: CACHE_VERSION,
    model: MODEL,
    glossary: glossaryHash,
    entries: {},
  };
}

async function loadCache(glossaryHash: string): Promise<Cache> {
  if (!existsSync(CACHE_FILE)) return emptyCache(glossaryHash);
  const raw = await readFile(CACHE_FILE, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`${rel(CACHE_FILE)} is not valid JSON; delete it and re-seed`);
  }
  const cache = parsed as Partial<Cache>;
  if (cache.version !== CACHE_VERSION || typeof cache.entries !== "object") {
    return emptyCache(glossaryHash);
  }
  return {
    version: CACHE_VERSION,
    model: typeof cache.model === "string" ? cache.model : MODEL,
    glossary: typeof cache.glossary === "string" ? cache.glossary : glossaryHash,
    entries: (cache.entries ?? {}) as Record<string, string>,
  };
}

async function saveCache(cache: Cache): Promise<void> {
  // Sorted keys: the cache is committed, so its diff must stay readable.
  const entries = Object.keys(cache.entries)
    .sort()
    .reduce<Record<string, string>>((accumulator, key) => {
      accumulator[key] = cache.entries[key] as string;
      return accumulator;
    }, {});
  const payload = {
    version: cache.version,
    model: cache.model,
    glossary: cache.glossary,
    entries,
  };
  await writeFile(CACHE_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/** Every English page, as a path relative to `docs/`, sorted. */
async function listEnglishPages(): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (absolute === FR_DIR) continue;
        if (entry.name.startsWith(".")) continue;
        await walk(absolute);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      const relative = path.relative(DOCS_DIR, absolute);
      if (EXCLUDED.has(relative)) continue;
      found.push(relative);
    }
  }
  await walk(DOCS_DIR);
  return found.sort();
}

function rel(absolute: string): string {
  return path.relative(ROOT, absolute);
}

/** Normalise `--file docs/index.md`, `index.md` or an absolute path. */
function normaliseFileArgument(value: string): string {
  const absolute = path.isAbsolute(value)
    ? value
    : path.resolve(ROOT, value.startsWith("docs/") ? value : `docs/${value}`);
  const relative = path.relative(DOCS_DIR, absolute);
  if (relative.startsWith("..")) fail(`${value} is outside docs/`);
  return relative;
}

// ---------------------------------------------------------------------------
// Link rewriting
// ---------------------------------------------------------------------------

/**
 * Keep relative Markdown links working inside `docs/fr/`.
 *
 * The French tree mirrors the English one, so a relative link normally resolves
 * to the French twin without any change. When the twin does not exist (a page
 * that is not translated yet, or on purpose), the link is rewritten to point
 * back at the English original rather than 404.
 */
export function rewriteLinks(
  markdown: string,
  frFileRelative: string,
  frenchPages: ReadonlySet<string>,
): string {
  const fromDir = path.posix.dirname(frFileRelative);
  return markdown.replace(
    /(\]\()([^)\s]+?\.md)((?:#[^)\s]*)?)(\))/g,
    (whole, open: string, target: string, anchor: string, close: string) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) {
        return whole;
      }
      const resolved = path.posix.normalize(path.posix.join(fromDir, target));
      if (resolved.startsWith("..")) return whole;
      if (frenchPages.has(resolved)) return whole;
      // No French twin: climb out of docs/fr/ back to the English page.
      const english = path.posix.relative(
        path.posix.join("fr", fromDir),
        resolved,
      );
      return `${open}${english}${anchor}${close}`;
    },
  );
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

function systemPrompt(glossary: string): string {
  return [
    "You translate technical documentation from English into French.",
    "",
    "The English text is the reference; the French text you produce is",
    "published as the generated French version of the same documentation site",
    "(a GitHub-backed classroom for the TIN department at HEIG-VD).",
    "",
    "Hard rules:",
    "- Output ONLY the translated Markdown. No preamble, no explanation, no",
    "  code fence wrapping the whole answer.",
    "- Translate the whole unit. Never summarise, never drop or add content.",
    "- Preserve the Markdown structure exactly: heading levels, list markers,",
    "  table columns and rows, admonition syntax (`!!! note`, `!!! warning`",
    "  — the type keyword stays in English, the title and body are translated),",
    "  blank lines, indentation.",
    "- The content of fenced code blocks, inline code spans, HTML and Mermaid",
    "  diagrams is copied byte for byte. Never translate code, identifiers,",
    "  file paths, environment variables, command lines or URLs.",
    "- Front matter keys are kept; only human-readable values such as `title`",
    "  are translated.",
    "- Requirement and decision identifiers (AU-xx, GR-xx, NFR-xx, GH-xx,",
    "  ADR-xxx, US-xx) are copied verbatim and never renumbered.",
    "- Markdown link targets are copied verbatim; only the link text is",
    "  translated. An anchor pointing at a heading of this documentation is",
    "  updated to the slug of the translated heading.",
    "- Register: formal technical French, `vous` for the reader.",
    "",
    "Glossary — apply it strictly:",
    "",
    glossary,
  ].join("\n");
}

async function translateUnit(
  client: Anthropic,
  glossary: string,
  unit: Unit,
): Promise<string> {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [
      {
        type: "text",
        text: systemPrompt(glossary),
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          `Translate this section of \`docs/${unit.file}\` into French.`,
          "Answer with the translated Markdown only.",
          "",
          "<section>",
          unit.text,
          "</section>",
        ].join("\n"),
      },
    ],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new Error(
      `the model declined to translate ${unit.file} #${unit.index}`,
    );
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error(
      `translation of ${unit.file} #${unit.index} hit max_tokens; ` +
        "split the section or raise MAX_TOKENS",
    );
  }
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  if (text.length === 0) {
    throw new Error(`empty translation for ${unit.file} #${unit.index}`);
  }
  return stripAccidentalFence(text);
}

/** Some answers wrap the whole document in a fence; undo that. */
function stripAccidentalFence(text: string): string {
  const match = /^```(?:markdown|md)?\n([\s\S]*)\n```$/.exec(text.trim());
  return match ? (match[1] as string) : text;
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<Array<{ item: T; value?: R; error?: unknown }>> {
  const results: Array<{ item: T; value?: R; error?: unknown }> = [];
  let cursor = 0;
  async function run(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      try {
        results.push({ item, value: await worker(item) });
      } catch (error) {
        results.push({ item, error });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run),
  );
  return results;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

interface Page {
  readonly file: string;
  readonly units: readonly Unit[];
}

async function readPages(files: readonly string[]): Promise<Page[]> {
  const pages: Page[] = [];
  for (const file of files) {
    const source = await readFile(path.join(DOCS_DIR, file), "utf8");
    pages.push({ file, units: splitIntoUnits(file, source) });
  }
  return pages;
}

/** `--check`: every English unit must have a cached French text. */
function runCheck(pages: readonly Page[], cache: Cache, glossaryHash: string): number {
  const missing: string[] = [];
  for (const page of pages) {
    if (!existsSync(path.join(FR_DIR, page.file))) {
      missing.push(`docs/fr/${page.file} (whole page missing)`);
      continue;
    }
    for (const unit of page.units) {
      const key = cacheKey(unit.text, MODEL, glossaryHash);
      if (cache.entries[key] === undefined) {
        missing.push(
          `docs/${page.file} § ${headingOf(unit)} (no cached translation)`,
        );
      }
    }
  }
  if (missing.length === 0) {
    process.stdout.write(
      `docs-translate: up to date — ${pages.length} pages, ` +
        `${pages.reduce((n, p) => n + p.units.length, 0)} units, ` +
        `${Object.keys(cache.entries).length} cached translations\n`,
    );
    return 0;
  }
  process.stderr.write(
    [
      "docs-translate: the French documentation is out of date.",
      "",
      ...missing.map((entry) => `  - ${entry}`),
      "",
      "English under docs/ is the reference and French under docs/fr/ is",
      "generated. Regenerate it locally and commit the result:",
      "",
      "    export ANTHROPIC_API_KEY=...",
      "    pnpm docs:translate",
      "",
      "If you corrected a French page by hand instead, record it with:",
      "",
      "    pnpm docs:translate --seed-from-existing",
      "",
    ].join("\n"),
  );
  return 1;
}

function headingOf(unit: Unit): string {
  const first = unit.text.split("\n", 1)[0] ?? "";
  return first.replace(/^#+\s*/, "").slice(0, 60) || `unit ${unit.index}`;
}

/**
 * `--seed-from-existing`: pair each English unit with the unit of the same
 * index in the French twin already on disk and record it as cached. Used for
 * the first seed of the tree and after a hand correction of a French page.
 */
async function runSeed(
  pages: readonly Page[],
  cache: Cache,
  glossaryHash: string,
  dryRun: boolean,
): Promise<number> {
  let recorded = 0;
  const problems: string[] = [];
  for (const page of pages) {
    const frPath = path.join(FR_DIR, page.file);
    if (!existsSync(frPath)) {
      problems.push(`docs/fr/${page.file} does not exist — nothing to seed`);
      continue;
    }
    const frUnits = splitIntoUnits(page.file, await readFile(frPath, "utf8"));
    if (frUnits.length !== page.units.length) {
      problems.push(
        `docs/fr/${page.file} has ${frUnits.length} sections but ` +
          `docs/${page.file} has ${page.units.length}; the two must have the ` +
          "same '## ' structure before they can be paired",
      );
      continue;
    }
    for (const [index, unit] of page.units.entries()) {
      const key = cacheKey(unit.text, MODEL, glossaryHash);
      const french = (frUnits[index] as Unit).text;
      if (cache.entries[key] === french) continue;
      if (!dryRun) cache.entries[key] = french;
      recorded += 1;
    }
  }
  process.stdout.write(
    `docs-translate: ${dryRun ? "would record" : "recorded"} ${recorded} ` +
      `translation units from the existing docs/fr/ tree\n`,
  );
  if (problems.length > 0) {
    process.stderr.write(
      ["docs-translate: could not seed everything:", ...problems.map((p) => `  - ${p}`), ""].join("\n"),
    );
    return 1;
  }
  if (!dryRun) {
    cache.model = MODEL;
    cache.glossary = glossaryHash;
    await saveCache(cache);
  }
  return 0;
}

/** Default mode: translate what is missing and write `docs/fr/**`. */
async function runTranslate(
  pages: readonly Page[],
  cache: Cache,
  glossary: string,
  glossaryHash: string,
  dryRun: boolean,
): Promise<number> {
  const pending: Unit[] = [];
  for (const page of pages) {
    for (const unit of page.units) {
      const key = cacheKey(unit.text, MODEL, glossaryHash);
      if (cache.entries[key] === undefined) pending.push(unit);
    }
  }

  process.stdout.write(
    `docs-translate: ${pages.length} pages, ` +
      `${pages.reduce((n, p) => n + p.units.length, 0)} units, ` +
      `${pending.length} to translate with ${MODEL}\n`,
  );

  if (dryRun) {
    for (const unit of pending) {
      process.stdout.write(`  would translate docs/${unit.file} § ${headingOf(unit)}\n`);
    }
    return 0;
  }

  const failures: Array<{ unit: Unit; error: unknown }> = [];

  if (pending.length > 0) {
    if (!process.env.ANTHROPIC_API_KEY) {
      process.stderr.write(
        [
          "docs-translate: ANTHROPIC_API_KEY is not set, and " +
            `${pending.length} units are not in the cache.`,
          "Export a key from https://console.anthropic.com/ and run again:",
          "",
          "    export ANTHROPIC_API_KEY=sk-ant-...",
          "    pnpm docs:translate",
          "",
        ].join("\n"),
      );
      return 2;
    }
    const client = new Anthropic();
    let done = 0;
    const results = await mapLimit(pending, CONCURRENCY, async (unit) => {
      const french = await translateUnit(client, glossary, unit);
      done += 1;
      process.stdout.write(
        `  [${done}/${pending.length}] docs/${unit.file} § ${headingOf(unit)}\n`,
      );
      return french;
    });
    for (const result of results) {
      if (result.error !== undefined) {
        failures.push({ unit: result.item, error: result.error });
        continue;
      }
      cache.entries[cacheKey(result.item.text, MODEL, glossaryHash)] =
        result.value as string;
    }
    cache.model = MODEL;
    cache.glossary = glossaryHash;
    await saveCache(cache);
  }

  // Write every page whose units are all available, then fix relative links.
  const written: string[] = [];
  const frenchPages = new Set<string>();
  const drafts = new Map<string, string>();
  for (const page of pages) {
    const texts: string[] = [];
    let complete = true;
    for (const unit of page.units) {
      const french = cache.entries[cacheKey(unit.text, MODEL, glossaryHash)];
      if (french === undefined) {
        complete = false;
        break;
      }
      texts.push(french);
    }
    if (!complete) continue;
    drafts.set(page.file, joinUnits(texts));
    frenchPages.add(page.file.split(path.sep).join("/"));
  }
  // Pages that already exist on disk also count as French twins for links.
  for (const existing of await listFrenchPages()) frenchPages.add(existing);

  for (const [file, draft] of drafts) {
    const target = path.join(FR_DIR, file);
    await mkdir(path.dirname(target), { recursive: true });
    const posixFile = file.split(path.sep).join("/");
    await writeFile(target, rewriteLinks(draft, posixFile, frenchPages), "utf8");
    written.push(`docs/fr/${posixFile}`);
  }

  process.stdout.write(`docs-translate: wrote ${written.length} French pages\n`);

  if (failures.length > 0) {
    process.stderr.write(
      [
        "",
        `docs-translate: ${failures.length} units failed:`,
        ...failures.map(
          ({ unit, error }) =>
            `  - docs/${unit.file} § ${headingOf(unit)}: ` +
            (error instanceof Error ? error.message : String(error)),
        ),
        "",
        "Everything else was translated and cached; run the command again to",
        "retry only the failures.",
        "",
      ].join("\n"),
    );
    return 1;
  }
  return 0;
}

async function listFrenchPages(): Promise<string[]> {
  if (!existsSync(FR_DIR)) return [];
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.name.endsWith(".md")) {
        found.push(path.relative(FR_DIR, absolute).split(path.sep).join("/"));
      }
    }
  }
  await walk(FR_DIR);
  return found;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(GLOSSARY_FILE)) {
    fail(`missing glossary: ${rel(GLOSSARY_FILE)}`);
  }
  const glossary = await readFile(GLOSSARY_FILE, "utf8");
  const glossaryHash = sha256(glossary);

  let files = await listEnglishPages();
  if (options.file !== null) {
    const only = normaliseFileArgument(options.file);
    if (!files.includes(only)) {
      fail(`${options.file} is not a translatable page under docs/`);
    }
    files = [only];
  }
  if (files.length === 0) fail("no English pages found under docs/");

  const pages = await readPages(files);
  const cache = await loadCache(glossaryHash);

  if (cache.model !== MODEL || cache.glossary !== glossaryHash) {
    process.stdout.write(
      "docs-translate: the model or the glossary changed — every unit is " +
        "retranslated\n",
    );
  }

  if (options.check) return runCheck(pages, cache, glossaryHash);
  if (options.seed) return runSeed(pages, cache, glossaryHash, options.dryRun);
  return runTranslate(pages, cache, glossary, glossaryHash, options.dryRun);
}

// `stat` is imported for its side effect of failing early on a broken docs dir.
await stat(DOCS_DIR).catch(() => fail("docs/ not found"));
process.exitCode = await main();
