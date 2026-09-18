/**
 * The only module of the portal that knows about Podman (analyse.md D8).
 *
 * Two rules that are not negotiable:
 *
 *  1. **Always `podman --remote --url unix:///run/podman/podman.sock`.**
 *     Without `--remote`, the binary silently falls back to local rootless,
 *     creates its containers in a pasta network namespace and everything
 *     measured afterwards is wrong (docs/setup-poste.md, pitfall 2).
 *  2. **The hardening options are those of
 *     `images/c-dev/run-hardened.sh`, taken as they are** (invariant 3).
 *     `runArgs()` returns them explicitly so that a test can compare them
 *     against the script.
 *
 * Added to those, for V1: `--network codespace --dns=none
 * --add-host portal.internal:<gateway>` (invariant 2) and the label
 * `heig-codespace.session=<id>`, which is **the** mark of a session. Any
 * container without that label is ignored by the engine — first and foremost
 * the anchor container `codespace-anchor` (label `heig-codespace.role=anchor`),
 * which keeps the `cs0` bridge up and must never be touched.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Label that marks a session container, and nothing else. */
export const SESSION_LABEL = "heig-codespace.session";

export interface EngineOptions {
  podmanUrl: string;
  network: string;
  gateway: string;
  seccompProfile: string;
  image: string;
  memory: string;
  cpus: string;
  pidsLimit: number;
  /** `crun` by default; `runsc` (gVisor) remains a parameter, cf. analyse.md D2. */
  runtime?: string;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

export interface RunRequest {
  sessionId: string;
  /** Container name; deterministic so that reconciliation can find it again. */
  name: string;
  /** `<VOLUMES_ROOT>/<student>/<assignment>/work`, mounted at `/work`. */
  workDir: string;
  /** Overrides `EngineOptions.image` when the assignment mandates another image. */
  image?: string;
  /**
   * Environment variables set on the container, in addition to those of the
   * image. **Invariant 1**: no secret ever gets in. The only caller is
   * `sessions/manager.ts`, which puts nothing there but the seven variables of
   * `CONTAINER_ENV_KEYS` (three `CODESPACE_*`: deadline, return URL, assignment
   * title; four `GIT_*`: the student's git identity) — a unit test asserts it.
   */
  env?: Record<string, string>;
}

export interface ContainerInfo {
  id: string;
  name: string;
  sessionId: string | null;
  state: string;
  ip: string | null;
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export interface Engine {
  /** Creates and starts the container, returns its id and its address. */
  run(req: RunRequest): Promise<ContainerInfo>;
  inspect(idOrName: string): Promise<ContainerInfo | null>;
  stop(idOrName: string, timeoutSeconds?: number): Promise<void>;
  rm(idOrName: string): Promise<void>;
  /** Only the containers carrying the session label. */
  listSessions(): Promise<ContainerInfo[]>;
  /** Waits for `GET http://<ip>:8080/healthz`. Returns the delay in ms. */
  waitHealthy(ip: string, timeoutMs: number): Promise<number>;
  /** `podman exec`; reserved for the tests and the end-to-end script. */
  exec(idOrName: string, argv: string[]): Promise<string>;
  /** The exact arguments of the `run`, so that a test can assert them. */
  runArgs(req: RunRequest): string[];
}

/** Minimal shape of what `podman inspect --format json` gives us back. */
interface PodmanInspect {
  Id?: string;
  Name?: string;
  State?: { Status?: string };
  Config?: { Labels?: Record<string, string> | null };
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string } | undefined>;
  };
}

export function createEngine(opts: EngineOptions): Engine {
  const base = ["--remote", "--url", opts.podmanUrl];

  async function podman(args: string[], timeoutMs = 120_000): Promise<string> {
    try {
      const { stdout } = await execFileAsync("podman", [...base, ...args], {
        maxBuffer: 16 * 1024 * 1024,
        timeout: timeoutMs,
      });
      return stdout;
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new EngineError(
        `podman ${args[0] ?? ""} failed: ${e.message ?? "unknown error"}`,
        e.stderr ?? "",
      );
    }
  }

  function infoFrom(raw: PodmanInspect): ContainerInfo {
    const labels = raw.Config?.Labels ?? {};
    const networks = raw.NetworkSettings?.Networks ?? {};
    const own = networks[opts.network];
    return {
      id: raw.Id ?? "",
      name: (raw.Name ?? "").replace(/^\//, ""),
      sessionId: labels[SESSION_LABEL] ?? null,
      state: raw.State?.Status ?? "unknown",
      ip: own?.IPAddress && own.IPAddress !== "" ? own.IPAddress : null,
    };
  }

  function runArgs(req: RunRequest): string[] {
    return [
      "run",
      "-d",
      "--name",
      req.name,
      // The mark of a session. The garbage collector and reconciliation look
      // at nothing else, so the anchor is invisible to them.
      "--label",
      `${SESSION_LABEL}=${req.sessionId}`,
      "--label",
      "codespace.role=student",
      // --- hardening, copied from images/c-dev/run-hardened.sh -------------
      "--userns=auto",
      "--cap-drop=ALL",
      "--security-opt",
      "no-new-privileges",
      "--security-opt",
      `seccomp=${opts.seccompProfile}`,
      "--read-only",
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      "/run:rw,nosuid,nodev,mode=1777",
      "--tmpfs",
      "/home/student/.cache:rw,nosuid,nodev,mode=1777",
      "--pids-limit",
      String(opts.pidsLimit),
      "--memory",
      opts.memory,
      "--cpus",
      opts.cpus,
      ...(opts.runtime ? ["--runtime", opts.runtime] : []),
      // --- closed network, invariant 2 -------------------------------------
      "--network",
      opts.network,
      "--dns=none",
      "--add-host",
      `portal.internal:${opts.gateway}`,
      // --- container environment, invariant 1 ------------------------------
      // Nothing but what the caller set, and the caller puts no secret in it.
      // `-e KEY=value` rather than `--env-file`: the list must stay readable in
      // `podman inspect` and in the arguments returned here.
      ...Object.entries(req.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      // --- volume, analyse.md D6 -------------------------------------------
      // `:U`: with --userns=auto the mapped UID changes at every start, so
      // Podman rechowns the tree to the container's range. Never remove this
      // option in order to make a test simpler.
      "-v",
      `${req.workDir}:/work:U`,
      req.image ?? opts.image,
    ];
  }

  return {
    runArgs,

    async run(req) {
      // A same-named container left over from an earlier start would prevent
      // the `run`; reconciliation has normally removed it already.
      await podman(["rm", "-f", req.name], 30_000).catch(() => "");
      await podman(runArgs(req), 180_000);
      const info = await this.inspect(req.name);
      if (!info) throw new EngineError(`container ${req.name} not found after run`, "");
      opts.log?.info(
        { sessionId: req.sessionId, container: info.id.slice(0, 12), ip: info.ip },
        "session container started",
      );
      return info;
    },

    async inspect(idOrName) {
      const out = await podman(["inspect", idOrName, "--format", "json"], 30_000).catch(
        () => "",
      );
      if (out.trim() === "") return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(out);
      } catch {
        return null;
      }
      const list = Array.isArray(parsed) ? (parsed as PodmanInspect[]) : [parsed as PodmanInspect];
      const first = list[0];
      return first ? infoFrom(first) : null;
    },

    async stop(idOrName, timeoutSeconds = 5) {
      await podman(["stop", "-t", String(timeoutSeconds), idOrName], 60_000).catch(() => "");
    },

    async rm(idOrName) {
      await podman(["rm", "-f", idOrName], 60_000).catch(() => "");
    },

    async listSessions() {
      const out = await podman([
        "ps",
        "--all",
        "--filter",
        `label=${SESSION_LABEL}`,
        "--format",
        "json",
      ]);
      if (out.trim() === "") return [];
      const rows = JSON.parse(out) as Array<{
        Id?: string;
        Names?: string[];
        State?: string;
        Labels?: Record<string, string> | null;
      }>;
      const infos: ContainerInfo[] = [];
      for (const row of rows) {
        const sessionId = row.Labels?.[SESSION_LABEL];
        // `--filter label=` alone would accept a container with an empty
        // label; what defines a session is a value.
        if (!sessionId) continue;
        const detailed = await this.inspect(row.Id ?? row.Names?.[0] ?? "");
        infos.push(
          detailed ?? {
            id: row.Id ?? "",
            name: row.Names?.[0] ?? "",
            sessionId,
            state: row.State ?? "unknown",
            ip: null,
          },
        );
      }
      return infos;
    },

    async waitHealthy(ip, timeoutMs) {
      const started = Date.now();
      const deadline = started + timeoutMs;
      let last = "";
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://${ip}:8080/healthz`, {
            signal: AbortSignal.timeout(1500),
          });
          if (res.ok) {
            await res.arrayBuffer();
            return Date.now() - started;
          }
          last = `HTTP ${res.status}`;
        } catch (err) {
          last = String((err as Error).message ?? err);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new EngineError(`/healthz of ${ip} silent after ${timeoutMs} ms (${last})`, "");
    },

    async exec(idOrName, argv) {
      return podman(["exec", idOrName, ...argv], 300_000);
    },
  };
}
