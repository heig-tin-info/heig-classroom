/**
 * The Git surface of the portal: `git http-backend` behind Fastify.
 *
 * Three things matter here, all from analyse.md 3.1 and the invariants:
 *
 *  1. Authentication is the *source address*. The portal knows which address
 *     it gave to which container on the `codespace` bridge; anything else is
 *     403. No token ever enters the student container (invariant 1). The
 *     nftables rules (P2) are the second half of this; the check below is
 *     the first, because a bind address is undone by an environment variable
 *     (analyse.md 4.1).
 *  2. The Git protocol is not reimplemented. `git http-backend` has spoken
 *     it for twenty years; the portal only sets CGI variables and pipes.
 *  3. Nothing is buffered. A packfile goes from the socket to the child's
 *     stdin and back out as it arrives.
 *
 * This plugin is deliberately *not* wrapped in `fastify-plugin`: it needs
 * its own content-type parser (Git bodies are `application/x-git-*`, which
 * no default parser knows) and its own 404, and it listens on a dedicated
 * port, apart from the other surfaces of the portal.
 */
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import Fastify from "fastify";

import { CgiHeadScanner, type CgiHead } from "./cgi.js";
import { diffRefs, recordPush, type PushEventStore, type RelayScheduler } from "./pushEvents.js";
import { refSnapshot, stagingPaths } from "./staging.js";
import type { GitService, SessionLookup, StagingSession } from "./types.js";

/** The `codespace` subnet (CLAUDE.md invariant 2). */
export const DEFAULT_CLIENT_CIDR = "10.77.0.0/24";

export interface GitBackendOptions {
  sessions: SessionLookup;
  volumesRoot: string;
  store: PushEventStore;
  /** Absent: pushes are recorded and stay local. */
  relay?: RelayScheduler;
  /** Addresses allowed to speak to this surface at all. */
  clientCidr?: string;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Source address
// ---------------------------------------------------------------------------

/** Node reports an IPv4 peer on a dual-stack socket as `::ffff:10.77.0.2`. */
export function normalizeIp(ip: string): string {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return v4 ? (v4[1] as string) : ip;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    value = value * 256 + byte;
  }
  return value;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const [network, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  const base = ipv4ToInt(network ?? "");
  const addr = ipv4ToInt(normalizeIp(ip));
  if (base === null || addr === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((base & mask) >>> 0) === ((addr & mask) >>> 0);
}

export type SourceDecision =
  | { ok: true }
  | { ok: false; reason: "off-bridge" | "wrong-session" };

/**
 * Two conditions, both necessary: the address belongs to the `codespace`
 * bridge (so a request from the host, from localhost or from anywhere else
 * on the machine is refused), and it is the address of *this* session (so
 * one container cannot push into another's repository, even before the
 * nftables ICC rule is loaded).
 */
export function authorizeSource(
  clientIp: string,
  session: Pick<StagingSession, "containerIp">,
  cidr: string = DEFAULT_CLIENT_CIDR,
): SourceDecision {
  const ip = normalizeIp(clientIp);
  if (!ipInCidr(ip, cidr)) return { ok: false, reason: "off-bridge" };
  if (ip !== normalizeIp(session.containerIp)) return { ok: false, reason: "wrong-session" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Service and policy
// ---------------------------------------------------------------------------

/**
 * Which Git service a request asks for. Dumb-protocol paths (`HEAD`,
 * `objects/…`, `info/packs`) are reads, so they answer to the same policy as
 * `upload-pack`.
 */
export function requestedService(
  method: string,
  rest: string,
  query: Record<string, unknown>,
): GitService {
  const path = rest.replace(/^\/+/, "");
  if (path === "info/refs") {
    return query["service"] === "git-receive-pack" ? "git-receive-pack" : "git-upload-pack";
  }
  if (method === "POST" && path === "git-receive-pack") return "git-receive-pack";
  if (method === "POST" && path === "git-upload-pack") return "git-upload-pack";
  return "git-upload-pack";
}

/**
 * `receive-pack` is always allowed: a student must be able to submit even
 * when the forge is down, and even in exam mode. `upload-pack` follows the
 * assignment — and refusing it protects nothing by itself (analyse.md 3.2);
 * what protects the exam is what the portal *put* in the staging repository.
 */
export function serviceAllowed(service: GitService, session: Pick<StagingSession, "uploadPack">) {
  return service === "git-receive-pack" || session.uploadPack;
}

// ---------------------------------------------------------------------------
// CGI environment
// ---------------------------------------------------------------------------

/** Request headers forwarded to the CGI, and nothing else. */
const FORWARDED_HEADERS = [
  // `git http-backend` inflates the body itself when this says gzip.
  ["content-encoding", "HTTP_CONTENT_ENCODING"],
  // Protocol v2 negotiation.
  ["git-protocol", "HTTP_GIT_PROTOCOL"],
] as const;

export interface BackendEnvInput {
  projectRoot: string;
  pathInfo: string;
  method: string;
  queryString: string;
  remoteAddr: string;
  headers: Record<string, string | string[] | undefined>;
}

export function backendEnv(input: BackendEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    // No developer `~/.gitconfig`, no system config: what the portal serves
    // must not depend on the machine it runs on.
    HOME: "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1",
    GATEWAY_INTERFACE: "CGI/1.1",
    SERVER_PROTOCOL: "HTTP/1.1",
    GIT_PROJECT_ROOT: input.projectRoot,
    // The staging repository has no `git-daemon-export-ok`; access control is
    // the source address, one layer up.
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: input.pathInfo,
    REQUEST_METHOD: input.method,
    QUERY_STRING: input.queryString,
    REMOTE_ADDR: input.remoteAddr,
    // Reflog identity of the pushes landing in the staging repository.
    GIT_COMMITTER_NAME: "codespace-portal",
    GIT_COMMITTER_EMAIL: "portal@codespace.local",
  };
  const contentType = input.headers["content-type"];
  if (typeof contentType === "string") env["CONTENT_TYPE"] = contentType;
  const contentLength = input.headers["content-length"];
  // Absent (chunked): http-backend reads stdin to EOF, which is what the
  // handler gives it.
  if (typeof contentLength === "string") env["CONTENT_LENGTH"] = contentLength;
  for (const [header, variable] of FORWARDED_HEADERS) {
    const value = input.headers[header];
    if (typeof value === "string") env[variable] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

function deny(reply: FastifyReply, code: number, message: string) {
  // text/plain, one line: this is what `git` prints to the student.
  return reply
    .code(code)
    .header("content-type", "text/plain; charset=utf-8")
    .header("cache-control", "no-cache")
    .send(message + "\n");
}

export const gitBackendPlugin: FastifyPluginAsync<GitBackendOptions> = async (app, opts) => {
  const cidr = opts.clientCidr ?? DEFAULT_CLIENT_CIDR;

  // Git bodies are `application/x-git-upload-pack-request` and friends. The
  // parser hands the raw stream over untouched: nothing is buffered, and a
  // gzipped body reaches `git http-backend` still compressed, which is what
  // HTTP_CONTENT_ENCODING tells it to expect.
  app.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

  app.all<{ Params: { sessionId: string; "*": string } }>(
    "/git/:sessionId/*",
    async (request, reply) => {
      const { sessionId } = request.params;
      const rest = request.params["*"] ?? "";
      const session = await opts.sessions.bySessionId(sessionId);
      const clientIp = normalizeIp(request.ip);

      if (!session) {
        request.log.warn({ sessionId, clientIp }, "dépôt de transit inconnu");
        return deny(reply, 404, "session inconnue");
      }
      const decision = authorizeSource(clientIp, session, cidr);
      if (!decision.ok) {
        request.log.warn(
          { sessionId, clientIp, expected: session.containerIp, reason: decision.reason },
          "accès au canal Git refusé",
        );
        return deny(reply, 403, "adresse source non autorisée pour cette session");
      }
      const service = requestedService(request.method, rest, request.query as Record<string, unknown>);
      if (!serviceAllowed(service, session)) {
        request.log.info({ sessionId, service }, "upload-pack désactivé pour ce devoir");
        return deny(
          reply,
          403,
          "la récupération (fetch/clone) est désactivée pour ce devoir ; le push reste autorisé",
        );
      }

      return serve(request, reply, opts, session, rest, service);
    },
  );
};

async function serve(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: GitBackendOptions,
  session: StagingSession,
  rest: string,
  service: GitService,
): Promise<FastifyReply> {
  const paths = stagingPaths(opts.volumesRoot, session.student, session.assignment);
  const queryString = request.url.includes("?") ? request.url.slice(request.url.indexOf("?") + 1) : "";

  // Snapshot *before* the child runs: this is the only moment the previous
  // ref values are still visible.
  const before = service === "git-receive-pack" ? await refSnapshot(paths.gitDir) : null;

  const child = spawn("git", ["http-backend"], {
    env: backendEnv({
      projectRoot: paths.dir,
      pathInfo: "/staging.git/" + rest.replace(/^\/+/, ""),
      method: request.method,
      queryString,
      remoteAddr: normalizeIp(request.ip),
      headers: request.headers as Record<string, string | string[] | undefined>,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const body = new PassThrough();
  const scanner = new CgiHeadScanner();
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => {
    if (stderr.length < 8192) stderr += c.toString();
  });

  const head = await new Promise<CgiHead>((resolve, reject) => {
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (scanner.finished) {
        if (!body.write(chunk)) child.stdout.pause();
        return;
      }
      try {
        const found = scanner.push(chunk);
        if (!found) return;
        settled = true;
        resolve(found.head);
        if (found.rest.length > 0 && !body.write(found.rest)) child.stdout.pause();
      } catch (err) {
        settled = true;
        reject(err as Error);
      }
    });
    body.on("drain", () => child.stdout.resume());
    child.stdout.on("end", () => body.end());
    child.on("error", (err) => {
      if (!settled) reject(err);
      else body.destroy(err);
    });
    child.on("close", (code) => {
      if (!settled) {
        reject(new Error(`git http-backend a quitté avec ${code} : ${stderr.slice(0, 500)}`));
      }
    });
  }).catch((err: Error) => {
    request.log.error({ err: err.message, stderr }, "échec de git http-backend");
    return null;
  });

  if (!head) {
    child.kill("SIGKILL");
    return deny(reply, 500, "canal Git indisponible");
  }

  // The body flows while this is wired up; nothing waits for the child.
  if (service === "git-receive-pack" && head.statusCode < 400 && before) {
    child.on("close", (code) => {
      if (code !== 0) return;
      void afterReceivePack(request, opts, session, paths.gitDir, before);
    });
  }

  reply.code(head.statusCode);
  for (const [name, value] of head.headers) reply.header(name, value);
  // The request body only matters to POSTs; `pipe` ends stdin at EOF, which
  // is how http-backend knows a chunked body is over.
  if (request.method === "POST" || request.method === "PUT") request.raw.pipe(child.stdin);
  else child.stdin.end();
  return reply.send(body);
}

/**
 * Invariant 7, at the one place it can be enforced: refs are re-read, one
 * `PushEvent` per changed ref is written, and only then is the relay told.
 */
async function afterReceivePack(
  request: FastifyRequest,
  opts: GitBackendOptions,
  session: StagingSession,
  gitDir: string,
  before: Map<string, string>,
): Promise<void> {
  try {
    const after = await refSnapshot(gitDir);
    const changes = diffRefs(before, after);
    if (changes.length === 0) return;
    const rows = await recordPush(
      {
        store: opts.store,
        ...(opts.relay ? { relay: opts.relay } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      },
      session,
      changes,
    );
    request.log.info(
      { sessionId: session.sessionId, refs: rows.map((r) => r.ref) },
      "push enregistré",
    );
  } catch (err) {
    request.log.error(
      { sessionId: session.sessionId, err: String((err as Error).message ?? err) },
      "enregistrement du push impossible",
    );
  }
}

export interface GitServerOptions extends GitBackendOptions {
  /**
   * Bind address. The target is the bridge gateway and nothing else
   * (analyse.md 4.1): P2 keeps an anchor container attached to `codespace`,
   * so the `cs0` bridge and 10.77.0.254 exist permanently and the portal can
   * bind them. `0.0.0.0` remains the fallback for a machine where the bridge
   * has no address yet, and the source-address check (`authorizeSource`)
   * holds either way — a bind address is undone by an environment variable.
   */
  host?: string;
  port?: number;
  logger?: boolean | object;
}

/** Gateway of the `codespace` bridge (CLAUDE.md invariant 2). */
export const DEFAULT_GIT_HOST = "10.77.0.254";
export const DEFAULT_GIT_PORT = 9418;

/** The dedicated Git listener, separate from the portal's other surfaces. */
export function createGitServer(opts: GitServerOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  void app.register(gitBackendPlugin, opts);
  return app;
}

/**
 * Builds the listener and binds it, preferring the bridge gateway and
 * falling back to `0.0.0.0` when that address is not on the machine
 * (`EADDRNOTAVAIL`: the bridge exists only while a container is attached).
 * Returns the address actually served, which the caller should log.
 */
export async function startGitServer(
  opts: GitServerOptions,
): Promise<{ app: FastifyInstance; host: string; port: number }> {
  const app = createGitServer(opts);
  const port = opts.port ?? Number(process.env["CODESPACE_GIT_PORT"] ?? DEFAULT_GIT_PORT);
  const preferred = opts.host ?? process.env["CODESPACE_GATEWAY"] ?? DEFAULT_GIT_HOST;
  try {
    await app.listen({ port, host: preferred });
    return { app, host: preferred, port };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EADDRNOTAVAIL" && code !== "EINVAL") {
      await app.close();
      throw err;
    }
    await app.listen({ port, host: "0.0.0.0" });
    return { app, host: "0.0.0.0", port };
  }
}
