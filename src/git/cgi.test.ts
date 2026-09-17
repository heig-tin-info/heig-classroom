import { describe, expect, it } from "vitest";

import { CgiHeadScanner, CgiParseError, httpMetaVariable, parseCgiHead } from "./cgi.js";

describe("parseCgiHead", () => {
  it("lit les en-têtes d'une réponse smart HTTP", () => {
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

  it("transforme Status: en code HTTP et ne le réémet pas", () => {
    const head = parseCgiHead("Status: 403 Forbidden\r\nContent-Type: text/plain");
    expect(head.statusCode).toBe(403);
    expect(head.headers.map(([n]) => n)).toEqual(["Content-Type"]);
  });

  it("accepte les fins de ligne en LF seul", () => {
    expect(parseCgiHead("Status: 404 Not Found\nContent-Type: text/plain").statusCode).toBe(404);
  });

  it("recolle un en-tête replié", () => {
    const head = parseCgiHead("Content-Type: text/plain;\r\n  charset=utf-8");
    expect(head.headers).toEqual([["Content-Type", "text/plain; charset=utf-8"]]);
  });

  it("garde les doublons (Set-Cookie)", () => {
    const head = parseCgiHead("Set-Cookie: a=1\r\nSet-Cookie: b=2");
    expect(head.headers).toHaveLength(2);
  });

  it("refuse une ligne sans deux-points et un Status absurde", () => {
    expect(() => parseCgiHead("pas un en-tete")).toThrow(CgiParseError);
    expect(() => parseCgiHead("Status: abc")).toThrow(CgiParseError);
  });
});

describe("CgiHeadScanner", () => {
  it("sépare en-têtes et corps dans un seul morceau", () => {
    const scanner = new CgiHeadScanner();
    const found = scanner.push(Buffer.from("Content-Type: text/plain\r\n\r\n0000"));
    expect(found?.head.statusCode).toBe(200);
    expect(found?.rest.toString()).toBe("0000");
    expect(scanner.finished).toBe(true);
  });

  it("supporte un séparateur coupé entre deux morceaux", () => {
    const scanner = new CgiHeadScanner();
    expect(scanner.push(Buffer.from("Status: 403 Forbidden\r\n\r"))).toBeNull();
    const found = scanner.push(Buffer.from("\nrefusé"));
    expect(found?.head.statusCode).toBe(403);
    expect(found?.rest.toString()).toBe("refusé");
  });

  it("ne bufferise pas le corps : les octets suivants ne repassent pas par lui", () => {
    const scanner = new CgiHeadScanner();
    scanner.push(Buffer.from("Content-Type: x\n\nAAAA"));
    expect(() => scanner.push(Buffer.from("BBBB"))).toThrow(CgiParseError);
  });

  it("refuse un bloc d'en-têtes démesuré au lieu de le garder en mémoire", () => {
    const scanner = new CgiHeadScanner();
    expect(() => scanner.push(Buffer.alloc(70 * 1024, 0x41))).toThrow(/trop grand/);
  });
});

describe("httpMetaVariable", () => {
  it("suit la convention CGI", () => {
    expect(httpMetaVariable("Content-Encoding")).toBe("HTTP_CONTENT_ENCODING");
    expect(httpMetaVariable("git-protocol")).toBe("HTTP_GIT_PROTOCOL");
  });
});
