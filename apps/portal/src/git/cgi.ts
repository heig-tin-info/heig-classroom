/**
 * The CGI half of the Git channel: turning `git http-backend`'s stdout into
 * an HTTP status and headers, without buffering the body.
 *
 * `git http-backend` writes RFC 3875 CGI output: header lines, a blank line,
 * then the payload. There is no status line — a non-200 answer comes as a
 * `Status: 403 Forbidden` header. The body can be a gigabyte of packfile, so
 * the scanner only ever holds the header block and hands back the first
 * fragment of body that arrived with it.
 */

export interface CgiHead {
  statusCode: number;
  /** Header pairs in emission order; duplicates (Set-Cookie) preserved. */
  headers: [string, string][];
}

/** Headers larger than this are a bug or an attack, not a CGI response. */
const MAX_HEAD_BYTES = 64 * 1024;

export class CgiParseError extends Error {}

/**
 * Parses a complete, body-less CGI header block.
 *
 * `Status:` sets the HTTP status and is not forwarded (it is a CGI header,
 * not an HTTP one). Everything else is forwarded as-is: `Content-Type`,
 * `Cache-Control`, `Expires` and `Pragma` are what make a Git client trust
 * the smart protocol answer.
 */
export function parseCgiHead(block: string): CgiHead {
  const head: CgiHead = { statusCode: 200, headers: [] };
  const lines: string[] = [];
  for (const raw of block.split(/\r?\n/)) {
    if (raw === "") continue;
    // RFC 7230 obs-fold: a leading space continues the previous header.
    if (/^[ \t]/.test(raw) && lines.length > 0) {
      lines[lines.length - 1] += " " + raw.trim();
      continue;
    }
    lines.push(raw);
  }
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new CgiParseError(`en-tête CGI illisible : ${line.slice(0, 80)}`);
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") {
      const code = Number.parseInt(value.slice(0, 3), 10);
      if (!Number.isInteger(code) || code < 100 || code > 599) {
        throw new CgiParseError(`Status CGI invalide : ${value}`);
      }
      head.statusCode = code;
      continue;
    }
    head.headers.push([name, value]);
  }
  return head;
}

/** Offset just past the first `\n\n` or `\r\n\r\n`, or -1. */
function findSeparator(buf: Buffer, from: number): { end: number; blockEnd: number } | null {
  for (let i = Math.max(0, from); i < buf.length - 1; i += 1) {
    if (buf[i] !== 0x0a) continue;
    if (buf[i + 1] === 0x0a) return { end: i + 2, blockEnd: i };
    if (buf[i + 1] === 0x0d && buf[i + 2] === 0x0a) return { end: i + 3, blockEnd: i };
  }
  return null;
}

/**
 * Incremental scanner: feed it stdout chunks until it returns a head.
 * `rest` is body bytes that came in the same chunk and must be written out
 * before the stream is piped.
 */
export class CgiHeadScanner {
  private buf: Buffer = Buffer.alloc(0);
  private scanned = 0;
  private done = false;

  push(chunk: Buffer): { head: CgiHead; rest: Buffer } | null {
    if (this.done) throw new CgiParseError("scanner CGI déjà terminé");
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    // A separator can straddle two chunks, so back up two bytes.
    const found = findSeparator(this.buf, this.scanned - 2);
    if (!found) {
      if (this.buf.length > MAX_HEAD_BYTES) {
        throw new CgiParseError("bloc d'en-têtes CGI trop grand");
      }
      this.scanned = this.buf.length;
      return null;
    }
    this.done = true;
    const head = parseCgiHead(this.buf.subarray(0, found.blockEnd).toString("latin1"));
    const rest = this.buf.subarray(found.end);
    this.buf = Buffer.alloc(0);
    return { head, rest };
  }

  /** True once a head has been produced. */
  get finished(): boolean {
    return this.done;
  }
}

/**
 * CGI meta-variables for an incoming HTTP header, per RFC 3875 §4.1.18:
 * `Content-Encoding` becomes `HTTP_CONTENT_ENCODING`, which is exactly what
 * `git http-backend` reads to inflate a gzipped request body.
 */
export function httpMetaVariable(headerName: string): string {
  return "HTTP_" + headerName.toUpperCase().replace(/-/g, "_");
}
