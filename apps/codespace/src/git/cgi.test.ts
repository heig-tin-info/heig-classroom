import { describe, expect, it } from "vitest";

import { CgiHeadScanner, CgiParseError, httpMetaVariable, parseCgiHead } from "./cgi.js";

describe("parseCgiHead", () => {
  it("reads the headers of a smart HTTP response", () => {
    const head = parseCgiHead(
      "Content-Type: application/x-git-upload-pack-advertisement\r\n" +
        "Cache-Control: no-cache, max-age=0, must-revalidate\r\n" +
        "Expires: Fri, 01 Jan 1980 00:00:00 GMT",
    );
    expect(head.statusCode).toBe(200);
    expect(head.headers).toEqual([
      ["Content-Type", "application/x-git-upload-pack-advertisement"],
      ["Cache-Control", "no-cache, max-age=0, must-revalidate"],
      ["Expires", "Fri, 01 Jan 1980 00:00:00 GMT"],
    ]);
  });

  it("turns Status: into an HTTP code and does not re-emit it", () => {
    const head = parseCgiHead("Status: 403 Forbidden\r\nContent-Type: text/plain");
    expect(head.statusCode).toBe(403);
    expect(head.headers.map(([n]) => n)).toEqual(["Content-Type"]);
  });

  it("accepts bare LF line endings", () => {
    expect(parseCgiHead("Status: 404 Not Found\nContent-Type: text/plain").statusCode).toBe(404);
  });

  it("joins a folded header back together", () => {
    const head = parseCgiHead("Content-Type: text/plain;\r\n  charset=utf-8");
    expect(head.headers).toEqual([["Content-Type", "text/plain; charset=utf-8"]]);
  });

  it("keeps duplicates (Set-Cookie)", () => {
    const head = parseCgiHead("Set-Cookie: a=1\r\nSet-Cookie: b=2");
    expect(head.headers).toHaveLength(2);
  });

  it("refuses a line without a colon and a nonsensical Status", () => {
    expect(() => parseCgiHead("not a header")).toThrow(CgiParseError);
    expect(() => parseCgiHead("Status: abc")).toThrow(CgiParseError);
  });
});

describe("CgiHeadScanner", () => {
  it("separates headers from body within a single chunk", () => {
    const scanner = new CgiHeadScanner();
    const found = scanner.push(Buffer.from("Content-Type: text/plain\r\n\r\n0000"));
    expect(found?.head.statusCode).toBe(200);
    expect(found?.rest.toString()).toBe("0000");
    expect(scanner.finished).toBe(true);
  });

  it("handles a separator split across two chunks", () => {
    const scanner = new CgiHeadScanner();
    expect(scanner.push(Buffer.from("Status: 403 Forbidden\r\n\r"))).toBeNull();
    const found = scanner.push(Buffer.from("\nrefused"));
    expect(found?.head.statusCode).toBe(403);
    expect(found?.rest.toString()).toBe("refused");
  });

  it("does not buffer the body: later bytes do not go through it again", () => {
    const scanner = new CgiHeadScanner();
    scanner.push(Buffer.from("Content-Type: x\n\nAAAA"));
    expect(() => scanner.push(Buffer.from("BBBB"))).toThrow(CgiParseError);
  });

  it("refuses an oversized header block instead of keeping it in memory", () => {
    const scanner = new CgiHeadScanner();
    expect(() => scanner.push(Buffer.alloc(70 * 1024, 0x41))).toThrow(/too large/);
  });
});

describe("httpMetaVariable", () => {
  it("follows the CGI convention", () => {
    expect(httpMetaVariable("Content-Encoding")).toBe("HTTP_CONTENT_ENCODING");
    expect(httpMetaVariable("git-protocol")).toBe("HTTP_GIT_PROTOCOL");
  });
});
