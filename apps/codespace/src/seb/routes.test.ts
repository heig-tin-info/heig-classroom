import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";

import { EXAM_COOKIE, verifyExamCookie } from "./examSession.js";
import {
  checkExamRequest,
  mapLookup,
  replyOutsideSeb,
  sebRoutes,
  type SebAssignment,
} from "./routes.js";
import { SEB_CONTENT_TYPE, configKeyOfSebFile, renderSebFile } from "./sebFile.js";
import {
  CONFIG_KEY_HEADER,
  DEV_HEADER,
  REQUEST_HASH_HEADER,
  createSebVerifier,
  expectedHash,
} from "./verify.js";

const ORIGIN = "https://codespace.heig-vd.ch";
const COOKIE_SECRET = "long-enough-test-secret";
const BEK_WIN = "aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff";
const BEK_MAC = "bbbb111122223333444455556666777788889999aaaabbbbccccddddeeeeffff";
const BEK_OTHER_VERSION = "cccc111122223333444455556666777788889999aaaabbbbccccddddeeeeffff";

const A1 = {
  id: "a1",
  startUrl: `${ORIGIN}/exam/a1/start`,
  quitUrl: `${ORIGIN}/exam/a1/done`,
  examKeySalt: "QJAqvg89YMP6JagAshUm6QqpqpsrVS9ZWUYjdZhfEao=",
} as const;

const ASSIGNMENT: SebAssignment = {
  ...A1,
  configKey: renderSebFile(A1).configKey,
  beks: [BEK_WIN, BEK_MAC],
};

function build(mode: "real" | "simulated"): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(sebRoutes, {
    lookup: mapLookup(new Map([[ASSIGNMENT.id, ASSIGNMENT]])),
    verifier: createSebVerifier({ mode, nodeEnv: "test", url: { publicOrigin: ORIGIN } }),
    cookieSecret: COOKIE_SECRET,
    cookieSecure: true,
    onStart: () => ({ sessionId: "s-42", redirectTo: "/s/s-42/" }),
  });
  // Stand-in route for the proxy: it reads ONLY the cookie (invariant 5).
  app.get("/s/:sessionId/", async (request, reply) => {
    const verdict = checkExamRequest(request, { secret: COOKIE_SECRET, assignmentId: "a1" });
    if (!verdict.ok) return replyOutsideSeb(reply, verdict);
    return reply.send({ ok: true, sessionId: verdict.claims.sessionId });
  });
  return app;
}

function sebHeaders(url: string, bek = BEK_MAC): Record<string, string> {
  const absolute = `${ORIGIN}${url}`;
  return {
    [CONFIG_KEY_HEADER]: expectedHash(absolute, ASSIGNMENT.configKey),
    [REQUEST_HASH_HEADER]: expectedHash(absolute, bek),
  };
}

describe("GET /exam/:assignmentId.seb", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = build("real");
  });

  it("serves the file with the application/seb type", async () => {
    const res = await app.inject({ method: "GET", url: "/exam/a1.seb" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe(SEB_CONTENT_TYPE);
    expect(res.headers["content-disposition"]).toContain("config.seb");
    expect(res.body.startsWith("<?xml")).toBe(true);
  });

  it("the file served does carry the Config Key recorded for the assignment", async () => {
    const res = await app.inject({ method: "GET", url: "/exam/a1.seb" });
    expect(configKeyOfSebFile(res.body)).toBe(ASSIGNMENT.configKey);
  });

  it("the file contains no BEK", async () => {
    const res = await app.inject({ method: "GET", url: "/exam/a1.seb" });
    for (const bek of [BEK_WIN, BEK_MAC]) expect(res.body).not.toContain(bek);
  });

  it("unknown assignment: 404", async () => {
    expect((await app.inject({ method: "GET", url: "/exam/unknown.seb" })).statusCode).toBe(404);
  });
});

describe("GET /exam/:assignmentId/start, real verifier", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = build("real");
  });

  it("valid SEB request: cookie set and redirection", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/exam/a1/start",
      headers: sebHeaders("/exam/a1/start"),
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers["location"]).toBe("/s/s-42/");
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toContain(`${EXAM_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
  });

  const refusals: Array<[string, { url: string; headers: Record<string, string> }]> = [
    ["no header", { url: "/exam/a1/start", headers: {} }],
    [
      "forged header",
      {
        url: "/exam/a1/start",
        headers: { ...sebHeaders("/exam/a1/start"), [CONFIG_KEY_HEADER]: "00".repeat(32) },
      },
    ],
    [
      "hash computed over a URL with a fragment",
      { url: "/exam/a1/start", headers: sebHeaders("/exam/a1/start#x") },
    ],
    [
      "reordered query",
      { url: "/exam/a1/start?b=2&a=1", headers: sebHeaders("/exam/a1/start?a=1&b=2") },
    ],
    [
      "BEK of another version",
      { url: "/exam/a1/start", headers: sebHeaders("/exam/a1/start", BEK_OTHER_VERSION) },
    ],
    ["development header alone", { url: "/exam/a1/start", headers: { [DEV_HEADER]: "ok" } }],
  ];

  for (const [name, request] of refusals) {
    it(`refuses (403, explicit page): ${name}`, async () => {
      const res = await app.inject({ method: "GET", ...request });
      expect(res.statusCode).toBe(403);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain("Session hors Safe Exam Browser");
      expect(res.headers["set-cookie"]).toBeUndefined();
    });
  }

  it("a refusal never logs a BEK", async () => {
    const lines: string[] = [];
    const app2 = Fastify({
      logger: {
        level: "trace",
        stream: { write: (chunk: string) => void lines.push(chunk) },
      },
    });
    app2.register(sebRoutes, {
      lookup: mapLookup(new Map([[ASSIGNMENT.id, ASSIGNMENT]])),
      verifier: createSebVerifier({
        mode: "real",
        nodeEnv: "test",
        url: { publicOrigin: ORIGIN },
      }),
      cookieSecret: COOKIE_SECRET,
      onStart: () => ({ sessionId: "s-42", redirectTo: "/s/s-42/" }),
    });
    await app2.inject({
      method: "GET",
      url: "/exam/a1/start",
      headers: sebHeaders("/exam/a1/start", BEK_OTHER_VERSION),
    });
    const log = lines.join("");
    expect(log).toContain("exam start refused");
    expect(log).toContain("browser-exam-key-mismatch");
    for (const bek of [BEK_WIN, BEK_MAC, BEK_OTHER_VERSION]) {
      expect(log).not.toContain(bek);
    }
    // Nor the hash that was received, which is a function of the shared secret.
    expect(log).not.toContain(expectedHash(`${ORIGIN}/exam/a1/start`, BEK_OTHER_VERSION));
    await app2.close();
  });

  it("unknown assignment: 404", async () => {
    const res = await app.inject({ method: "GET", url: "/exam/unknown/start" });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /exam/:assignmentId/start, simulated verifier", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = build("simulated");
  });

  it("X-Dev-SEB: ok is enough", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/exam/a1/start",
      headers: { [DEV_HEADER]: "ok" },
    });
    expect(res.statusCode).toBe(303);
  });

  it("refuses the same set of cases as the real verifier", async () => {
    for (const [name, request] of [
      ["no header", { url: "/exam/a1/start", headers: {} }],
      [
        "SEB headers alone",
        { url: "/exam/a1/start", headers: sebHeaders("/exam/a1/start") },
      ],
      ["unexpected value", { url: "/exam/a1/start", headers: { [DEV_HEADER]: "yes" } }],
    ] as Array<[string, { url: string; headers: Record<string, string> }]>) {
      const res = await app.inject({ method: "GET", ...request });
      expect(res.statusCode, name).toBe(403);
      expect(res.body).toContain("Session hors Safe Exam Browser");
    }
  });
});

describe("the proxy reads only the cookie (invariant 5)", () => {
  it("cookie set by /start: the proxy accepts", async () => {
    const app = build("real");
    const start = await app.inject({
      method: "GET",
      url: "/exam/a1/start",
      headers: sebHeaders("/exam/a1/start"),
    });
    const cookie = String(res0(start)).split(";")[0] as string;
    const proxy = await app.inject({ method: "GET", url: "/s/s-42/", headers: { cookie } });
    expect(proxy.statusCode).toBe(200);
    expect(proxy.json()).toEqual({ ok: true, sessionId: "s-42" });
  });

  it("valid cookie from another client address: refused", async () => {
    const app = build("real");
    const start = await app.inject({
      method: "GET",
      url: "/exam/a1/start",
      headers: sebHeaders("/exam/a1/start"),
      remoteAddress: "10.0.0.7",
    });
    const cookie = String(res0(start)).split(";")[0] as string;

    const sameAddress = await app.inject({
      method: "GET",
      url: "/s/s-42/",
      headers: { cookie },
      remoteAddress: "10.0.0.7",
    });
    expect(sameAddress.statusCode).toBe(200);

    const otherAddress = await app.inject({
      method: "GET",
      url: "/s/s-42/",
      headers: { cookie },
      remoteAddress: "10.0.0.8",
    });
    expect(otherAddress.statusCode).toBe(403);
    expect(otherAddress.body).toContain("depuis un autre poste");
  });

  it("without a cookie, the SEB headers are useless on the proxy", async () => {
    const app = build("real");
    const res = await app.inject({
      method: "GET",
      url: "/s/s-42/",
      headers: sebHeaders("/s/s-42/"),
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Session hors Safe Exam Browser");
  });

  it("the issued cookie does carry assignment, session and address", async () => {
    const app = build("real");
    const start = await app.inject({
      method: "GET",
      url: "/exam/a1/start",
      headers: sebHeaders("/exam/a1/start"),
      remoteAddress: "10.0.0.7",
    });
    const value = (String(res0(start)).split(";")[0] as string).slice(
      `${EXAM_COOKIE}=`.length,
    );
    const verdict = verifyExamCookie(value, {
      secret: COOKIE_SECRET,
      clientAddress: "10.0.0.7",
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.claims.assignmentId).toBe("a1");
      expect(verdict.claims.sessionId).toBe("s-42");
      expect(verdict.claims.clientAddress).toBe("10.0.0.7");
    }
  });
});

/** First `Set-Cookie` of an injected response. */
function res0(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? String(raw[0]) : String(raw);
}
