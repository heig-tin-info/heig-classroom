/**
 * Minimal Apple property-list (plist) support, restricted to the subset that a
 * Safe Exam Browser `.seb` configuration file uses.
 *
 * Why hand-rolled rather than a dependency: the Config Key algorithm needs the
 * *declared* plist type of every leaf (an `<integer>` and a `<real>` do not
 * serialise the same way, a `<data>` is re-emitted as its Base64 text), and the
 * generic plist libraries of the ecosystem collapse everything onto JavaScript
 * primitives. Keeping the type tag is the whole point of this module.
 *
 * Reference for the subset: the plist DTD referenced by every `.seb` file,
 * <http://www.apple.com/DTDs/PropertyList-1.0.dtd>.
 */

/** A value of a SEB configuration, carrying its plist type. */
export type SebValue =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "real"; readonly value: number }
  /** `<data>`: the Base64 text exactly as it appears in the plist. */
  | { readonly kind: "data"; readonly value: string }
  /** `<date>`: the ISO 8601 text exactly as it appears in the plist. */
  | { readonly kind: "date"; readonly value: string }
  | { readonly kind: "array"; readonly value: readonly SebValue[] }
  | { readonly kind: "dict"; readonly value: SebDict };

/** A `<dict>`, as ordered entries: plist order is preserved until sorting. */
export type SebDict = ReadonlyArray<readonly [string, SebValue]>;

export const str = (value: string): SebValue => ({ kind: "string", value });
export const bool = (value: boolean): SebValue => ({ kind: "bool", value });
export const int = (value: number): SebValue => ({ kind: "integer", value });
export const real = (value: number): SebValue => ({ kind: "real", value });
export const data = (base64: string): SebValue => ({ kind: "data", value: base64 });
export const date = (iso: string): SebValue => ({ kind: "date", value: iso });
export const array = (value: readonly SebValue[]): SebValue => ({ kind: "array", value });
export const dict = (value: SebDict): SebValue => ({ kind: "dict", value });

export class PlistParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlistParseError";
  }
}

// --- Parsing ---------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }
    const named = ENTITIES[body];
    if (named === undefined) throw new PlistParseError(`Unknown XML entity &${body};`);
    return named;
  });
}

type Tag = { name: string; selfClosing: boolean; closing: boolean };

/**
 * A deliberately small scanner. It understands elements, self-closing
 * elements, attributes (ignored), comments, the XML declaration and the
 * doctype. It does not understand namespaces, CDATA or processing
 * instructions, none of which appear in a `.seb` file.
 */
class Scanner {
  private pos = 0;
  constructor(private readonly src: string) {}

  atEnd(): boolean {
    return this.pos >= this.src.length;
  }

  /** Skips whitespace, comments, `<?...?>` and `<!DOCTYPE ...>`. */
  skipTrivia(): void {
    for (;;) {
      while (this.pos < this.src.length && /\s/.test(this.src[this.pos] as string)) this.pos += 1;
      if (this.src.startsWith("<?", this.pos)) {
        const end = this.src.indexOf("?>", this.pos);
        if (end < 0) throw new PlistParseError("Unterminated <? ... ?>");
        this.pos = end + 2;
        continue;
      }
      if (this.src.startsWith("<!--", this.pos)) {
        const end = this.src.indexOf("-->", this.pos);
        if (end < 0) throw new PlistParseError("Unterminated comment");
        this.pos = end + 3;
        continue;
      }
      if (this.src.startsWith("<!", this.pos)) {
        const end = this.src.indexOf(">", this.pos);
        if (end < 0) throw new PlistParseError("Unterminated <! ... >");
        this.pos = end + 1;
        continue;
      }
      return;
    }
  }

  peekTag(): Tag | null {
    this.skipTrivia();
    if (!this.src.startsWith("<", this.pos)) return null;
    const end = this.src.indexOf(">", this.pos);
    if (end < 0) throw new PlistParseError("Unterminated tag");
    const raw = this.src.slice(this.pos + 1, end).trim();
    const closing = raw.startsWith("/");
    const selfClosing = raw.endsWith("/");
    const body = raw.replace(/^\//, "").replace(/\/$/, "").trim();
    const name = (body.split(/\s/, 1)[0] ?? "").toLowerCase();
    if (name === "") throw new PlistParseError("Empty tag name");
    return { name, selfClosing, closing };
  }

  /** Consumes the tag last returned by {@link peekTag}. */
  consumeTag(): Tag {
    const tag = this.peekTag();
    if (!tag) throw new PlistParseError("Expected a tag");
    this.pos = this.src.indexOf(">", this.pos) + 1;
    return tag;
  }

  /** Reads raw text up to the next `<`. */
  readText(): string {
    const next = this.src.indexOf("<", this.pos);
    const end = next < 0 ? this.src.length : next;
    const text = this.src.slice(this.pos, end);
    this.pos = end;
    return text;
  }
}

function expectClose(scanner: Scanner, name: string): void {
  const tag = scanner.consumeTag();
  if (!tag.closing || tag.name !== name) {
    throw new PlistParseError(`Expected </${name}>, found <${tag.closing ? "/" : ""}${tag.name}>`);
  }
}

function parseValue(scanner: Scanner): SebValue {
  const tag = scanner.consumeTag();
  if (tag.closing) throw new PlistParseError(`Unexpected </${tag.name}>`);

  switch (tag.name) {
    case "true":
      if (!tag.selfClosing) expectClose(scanner, "true");
      return bool(true);
    case "false":
      if (!tag.selfClosing) expectClose(scanner, "false");
      return bool(false);
    case "string": {
      if (tag.selfClosing) return str("");
      const text = decodeEntities(scanner.readText());
      expectClose(scanner, "string");
      return str(text);
    }
    case "integer": {
      if (tag.selfClosing) throw new PlistParseError("<integer/> has no value");
      const text = scanner.readText().trim();
      expectClose(scanner, "integer");
      const value = Number.parseInt(text, 10);
      if (!Number.isFinite(value)) throw new PlistParseError(`Bad <integer>: ${text}`);
      return int(value);
    }
    case "real": {
      if (tag.selfClosing) throw new PlistParseError("<real/> has no value");
      const text = scanner.readText().trim();
      expectClose(scanner, "real");
      const value = Number.parseFloat(text);
      if (!Number.isFinite(value)) throw new PlistParseError(`Bad <real>: ${text}`);
      return real(value);
    }
    case "data": {
      if (tag.selfClosing) return data("");
      // The plist format allows the Base64 payload to be wrapped over several
      // lines; SEB writes it on one. property_list.php trims it, we drop every
      // whitespace character, which is the same thing for a one-line payload.
      const text = scanner.readText().replace(/\s+/g, "");
      expectClose(scanner, "data");
      return data(text);
    }
    case "date": {
      if (tag.selfClosing) throw new PlistParseError("<date/> has no value");
      const text = scanner.readText().trim();
      expectClose(scanner, "date");
      return date(text);
    }
    case "array": {
      if (tag.selfClosing) return array([]);
      const items: SebValue[] = [];
      for (;;) {
        const next = scanner.peekTag();
        if (!next) throw new PlistParseError("Unterminated <array>");
        if (next.closing) break;
        items.push(parseValue(scanner));
      }
      expectClose(scanner, "array");
      return array(items);
    }
    case "dict": {
      if (tag.selfClosing) return dict([]);
      const entries: Array<readonly [string, SebValue]> = [];
      for (;;) {
        const next = scanner.peekTag();
        if (!next) throw new PlistParseError("Unterminated <dict>");
        if (next.closing) break;
        if (next.name !== "key") throw new PlistParseError(`Expected <key>, found <${next.name}>`);
        const keyTag = scanner.consumeTag();
        let key = "";
        if (!keyTag.selfClosing) {
          key = decodeEntities(scanner.readText());
          expectClose(scanner, "key");
        }
        entries.push([key, parseValue(scanner)] as const);
      }
      expectClose(scanner, "dict");
      return dict(entries);
    }
    default:
      throw new PlistParseError(`Unsupported plist element <${tag.name}>`);
  }
}

/**
 * Parses an unencrypted `.seb` file (plist XML) into a {@link SebValue}.
 * The root must be a `<dict>`, which is what SEB always writes.
 */
export function parsePlist(xml: string): SebValue {
  const scanner = new Scanner(xml);
  const root = scanner.peekTag();
  if (!root) throw new PlistParseError("Not an XML document");
  if (root.name !== "plist") throw new PlistParseError("Root element is not <plist>");
  scanner.consumeTag();
  const value = parseValue(scanner);
  expectClose(scanner, "plist");
  if (value.kind !== "dict") throw new PlistParseError("The <plist> root value must be a <dict>");
  return value;
}

/** Same as {@link parsePlist} but reports whether the document is usable. */
export function isValidSebConfig(xml: string): boolean {
  try {
    parsePlist(xml);
    return true;
  } catch {
    return false;
  }
}

// --- Serialising -----------------------------------------------------------

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderValue(value: SebValue, indent: string): string {
  switch (value.kind) {
    case "string":
      return value.value === ""
        ? `${indent}<string></string>`
        : `${indent}<string>${escapeXml(value.value)}</string>`;
    case "bool":
      return `${indent}<${value.value ? "true" : "false"}/>`;
    case "integer":
      return `${indent}<integer>${value.value.toFixed(0)}</integer>`;
    case "real":
      return `${indent}<real>${renderReal(value.value)}</real>`;
    case "data":
      return `${indent}<data>${value.value}</data>`;
    case "date":
      return `${indent}<date>${value.value}</date>`;
    case "array": {
      if (value.value.length === 0) return `${indent}<array/>`;
      const body = value.value.map((item) => renderValue(item, `${indent}  `)).join("\n");
      return `${indent}<array>\n${body}\n${indent}</array>`;
    }
    case "dict": {
      if (value.value.length === 0) return `${indent}<dict/>`;
      const body = value.value
        .map(
          ([key, child]) =>
            `${indent}  <key>${escapeXml(key)}</key>\n${renderValue(child, `${indent}  `)}`,
        )
        .join("\n");
      return `${indent}<dict>\n${body}\n${indent}</dict>`;
    }
  }
}

/** Renders a `<real>`: an integral value keeps a decimal part, as plist does. */
function renderReal(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/** Renders a {@link SebValue} as a complete plist XML document. */
export function toPlistXml(root: SebValue): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    renderValue(root, ""),
    "</plist>",
    "",
  ].join("\n");
}
