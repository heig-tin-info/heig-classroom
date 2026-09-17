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
const COOKIE_SECRET = "secret-de-test-assez-long";
const BEK_WIN = "aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff";
const BEK_MAC = "bbbb111122223333444455556666777788889999aaaabbbbccccddddeeeeffff";
const BEK_AUTRE_VERSION = "cccc111122223333444455556666777788889999aaaabbbbccccddddeeeeffff";

const A1 = {
  id: "a1",
  startUrl: `${ORIGIN}/exam/a1/start`,
  quitUrl: `${ORIGIN}/exam/a1/fini`,
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
  // Route de substitution du proxy : elle ne lit QUE le cookie (invariant 5).
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

  it("sert le fichier avec le type application/seb", async () => {
    const res = await app.inject({ method: "GET", url: "/exam/a1.seb" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe(SEB_CONTENT_TYPE);
    expect(res.headers["content-disposition"]).toContain("config.seb");
    expect(res.body.startsWith("<?xml")).toBe(true);
  });

  it("le fichier servi a bien la Config Key enregistrée pour le devoir", async () => {
    const res = await app.inject({ method: "GET", url: "/exam/a1.seb" });
    expect(configKeyOfSebFile(res.body)).toBe(ASSIGNMENT.configKey);
  });

  it("le fichier ne contient aucun BEK", async () => {
    const res = await app.inject({ method: "GET", url: "/exam/a1.seb" });
    for (const bek of [BEK_WIN, BEK_MAC]) expect(res.body).not.toContain(bek);
  });

  it("devoir inconnu : 404", async () => {
    expect((await app.inject({ method: "GET", url: "/exam/inconnu.seb" })).statusCode).toBe(404);
  });
});

describe("GET /exam/:assignmentId/start, vérificateur réel", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = build("real");
  });

  it("requête SEB valide : cookie posé et redirection", async () => {
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

  const refus: Array<[string, { url: string; headers: Record<string, string> }]> = [
    ["sans en-tête", { url: "/exam/a1/start", headers: {} }],
    [
      "en-tête forgé",
      {
        url: "/exam/a1/start",
        headers: { ...sebHeaders("/exam/a1/start"), [CONFIG_KEY_HEADER]: "00".repeat(32) },
      },
    ],
    [
      "hachage calculé sur une URL avec fragment",
      { url: "/exam/a1/start", headers: sebHeaders("/exam/a1/start#x") },
    ],
    [
      "query réordonnée",
      { url: "/exam/a1/start?b=2&a=1", headers: sebHeaders("/exam/a1/start?a=1&b=2") },
    ],
    [
      "BEK d'une autre version",
      { url: "/exam/a1/start", headers: sebHeaders("/exam/a1/start", BEK_AUTRE_VERSION) },
    ],
    ["en-tête de développement seul", { url: "/exam/a1/start", headers: { [DEV_HEADER]: "ok" } }],
  ];

  for (const [nom, requete] of refus) {
    it(`refuse (403, page explicite) : ${nom}`, async () => {
      const res = await app.inject({ method: "GET", ...requete });
      expect(res.statusCode).toBe(403);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain("Session hors Safe Exam Browser");
      expect(res.headers["set-cookie"]).toBeUndefined();
    });
  }

  it("un refus ne journalise jamais un BEK", async () => {
    const lignes: string[] = [];
    const app2 = Fastify({
      logger: {
        level: "trace",
        stream: { write: (chunk: string) => void lignes.push(chunk) },
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
      headers: sebHeaders("/exam/a1/start", BEK_AUTRE_VERSION),
    });
    const journal = lignes.join("");
    expect(journal).toContain("démarrage d'examen refusé");
    expect(journal).toContain("browser-exam-key-mismatch");
    for (const bek of [BEK_WIN, BEK_MAC, BEK_AUTRE_VERSION]) {
      expect(journal).not.toContain(bek);
    }
    // Ni le haché reçu, qui est une fonction du secret partagé.
    expect(journal).not.toContain(expectedHash(`${ORIGIN}/exam/a1/start`, BEK_AUTRE_VERSION));
    await app2.close();
  });

  it("devoir inconnu : 404", async () => {
    const res = await app.inject({ method: "GET", url: "/exam/inconnu/start" });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /exam/:assignmentId/start, vérificateur simulé", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = build("simulated");
  });

  it("X-Dev-SEB: ok suffit", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/exam/a1/start",
      headers: { [DEV_HEADER]: "ok" },
    });
    expect(res.statusCode).toBe(303);
  });

  it("refuse le même jeu de cas que le vérificateur réel", async () => {
    for (const [nom, requete] of [
      ["sans en-tête", { url: "/exam/a1/start", headers: {} }],
      [
        "en-têtes SEB seuls",
        { url: "/exam/a1/start", headers: sebHeaders("/exam/a1/start") },
      ],
      ["valeur inattendue", { url: "/exam/a1/start", headers: { [DEV_HEADER]: "yes" } }],
    ] as Array<[string, { url: string; headers: Record<string, string> }]>) {
      const res = await app.inject({ method: "GET", ...requete });
      expect(res.statusCode, nom).toBe(403);
      expect(res.body).toContain("Session hors Safe Exam Browser");
    }
  });
});

describe("le proxy ne lit que le cookie (invariant 5)", () => {
  it("cookie posé par /start : le proxy accepte", async () => {
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

  it("cookie valide depuis une autre adresse client : refusé", async () => {
    const app = build("real");
    const start = await app.inject({
      method: "GET",
      url: "/exam/a1/start",
      headers: sebHeaders("/exam/a1/start"),
      remoteAddress: "10.0.0.7",
    });
    const cookie = String(res0(start)).split(";")[0] as string;

    const memeAdresse = await app.inject({
      method: "GET",
      url: "/s/s-42/",
      headers: { cookie },
      remoteAddress: "10.0.0.7",
    });
    expect(memeAdresse.statusCode).toBe(200);

    const autreAdresse = await app.inject({
      method: "GET",
      url: "/s/s-42/",
      headers: { cookie },
      remoteAddress: "10.0.0.8",
    });
    expect(autreAdresse.statusCode).toBe(403);
    expect(autreAdresse.body).toContain("depuis un autre poste");
  });

  it("sans cookie, les en-têtes SEB ne servent à rien sur le proxy", async () => {
    const app = build("real");
    const res = await app.inject({
      method: "GET",
      url: "/s/s-42/",
      headers: sebHeaders("/s/s-42/"),
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Session hors Safe Exam Browser");
  });

  it("le cookie émis porte bien devoir, session et adresse", async () => {
    const app = build("real");
    const start = await app.inject({
      method: "GET",
      url: "/exam/a1/start",
      headers: sebHeaders("/exam/a1/start"),
      remoteAddress: "10.0.0.7",
    });
    const valeur = (String(res0(start)).split(";")[0] as string).slice(
      `${EXAM_COOKIE}=`.length,
    );
    const verdict = verifyExamCookie(valeur, {
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

/** Premier `Set-Cookie` d'une réponse injectée. */
function res0(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? String(raw[0]) : String(raw);
}
