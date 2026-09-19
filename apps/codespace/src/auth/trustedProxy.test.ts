/**
 * `TRUSTED_PROXY_IPS` → Fastify's `trustProxy` (audit M1 of 2026-09-18,
 * docs/deploy.md § 6).
 *
 * The exam cookie is bound to `request.ip` (analyse.md D5). Behind the Caddy
 * of `deploy/Caddyfile` the portal only ever sees 127.0.0.1, so that binding
 * compares 127.0.0.1 with 127.0.0.1 for everyone and the "same workstation"
 * check can never fire. What is checked here is the whole point of the fix:
 * `request.ip` is the **forwarded** address when the hop is a trusted front
 * end, and the header is ignored when it is not.
 *
 * This is a property of the Fastify setting, not of our own code, and that is
 * exactly why it is worth a test: the setting is one line in `server.ts` and
 * a wrong shape (the boolean, a string instead of a list) fails silently.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

/** The same expression as `buildPortal` in `server.ts`, on a bare instance. */
function portalTrustProxy(env: NodeJS.ProcessEnv): boolean | string[] {
  const config = loadConfig(env);
  return config.TRUSTED_PROXY_IPS.length > 0 ? config.TRUSTED_PROXY_IPS : config.TRUST_PROXY;
}

async function ipSeenBy(
  trustProxy: boolean | string[],
  from: string,
  forwardedFor: string | undefined,
): Promise<string> {
  app = Fastify({ trustProxy, logger: false });
  app.get("/ip", async (request) => ({ ip: request.ip }));
  const response = await app.inject({
    method: "GET",
    url: "/ip",
    remoteAddress: from,
    ...(forwardedFor !== undefined ? { headers: { "x-forwarded-for": forwardedFor } } : {}),
  });
  return (response.json() as { ip: string }).ip;
}

describe("request.ip behind a trusted proxy", () => {
  const production = {
    NODE_ENV: "production",
    OIDC_CLIENT_SECRET: "real-secret",
    COOKIE_SECRET: "a-long-production-secret",
    EXAM_COOKIE_SECRET: "another-production-secret",
    SEB_VERIFIER: "real",
    SEB_PUBLIC_ORIGIN: "https://codespace.heig-vd.ch",
    TRUSTED_PROXY_IPS: "127.0.0.1",
  };

  it("the production configuration hands Fastify a list, not a boolean", () => {
    expect(portalTrustProxy(production)).toEqual(["127.0.0.1"]);
  });

  it("a request relayed by the trusted front end carries the student's address", async () => {
    // What Caddy does: it connects from 127.0.0.1 and appends the real client
    // to `X-Forwarded-For`.
    expect(await ipSeenBy(["127.0.0.1"], "127.0.0.1", "10.0.0.9")).toBe("10.0.0.9");
  });

  it("two workstations behind the same front end are two different addresses", async () => {
    const one = await ipSeenBy(["127.0.0.1"], "127.0.0.1", "10.0.0.9");
    await app.close();
    const other = await ipSeenBy(["127.0.0.1"], "127.0.0.1", "10.0.0.10");
    expect(one).not.toBe(other);
  });

  it("a header coming from an untrusted source is ignored", async () => {
    // The forged case: a client that reaches the portal directly, or a second
    // front end nobody declared. Its claim is not read.
    expect(await ipSeenBy(["127.0.0.1"], "203.0.113.7", "10.0.0.9")).toBe("203.0.113.7");
  });

  it("only the last untrusted hop of the chain is kept", async () => {
    // A client that prepends its own value to the header: Fastify walks the
    // chain from the right and stops at the first hop that is not trusted.
    expect(await ipSeenBy(["127.0.0.1"], "127.0.0.1", "10.9.9.9, 10.0.0.9")).toBe("10.0.0.9");
  });

  it("with no list at all, request.ip is the socket address", async () => {
    expect(await ipSeenBy(false, "127.0.0.1", "10.0.0.9")).toBe("127.0.0.1");
  });
});
