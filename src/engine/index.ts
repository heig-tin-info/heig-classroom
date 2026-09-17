/**
 * Le seul module du portail qui connaisse Podman (analyse.md D8).
 *
 * Deux règles qui ne se négocient pas :
 *
 *  1. **Toujours `podman --remote --url unix:///run/podman/podman.sock`.**
 *     Sans `--remote`, le binaire bascule silencieusement en rootless local,
 *     crée ses conteneurs dans un espace réseau pasta et tout ce qu'on mesure
 *     ensuite est faux (docs/setup-poste.md, piège 2).
 *  2. **Les options de durcissement sont celles de
 *     `images/c-dev/run-hardened.sh`, reprises telles quelles** (invariant 3).
 *     `runArgs()` les rend explicitement pour qu'un test puisse les comparer
 *     au script.
 *
 * S'y ajoutent, pour V1 : `--network codespace --dns=none
 * --add-host portal.internal:<passerelle>` (invariant 2) et le label
 * `heig-codespace.session=<id>`, qui est **la** marque d'une session. Tout
 * conteneur sans ce label est ignoré par le moteur — au premier chef le
 * conteneur d'ancrage `codespace-anchor` (label `heig-codespace.role=anchor`),
 * qui maintient le pont `cs0` et ne doit jamais être touché.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Label qui marque un conteneur de session, et rien d'autre. */
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
  /** `crun` par défaut ; `runsc` (gVisor) reste un paramètre, cf. analyse.md D2. */
  runtime?: string;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

export interface RunRequest {
  sessionId: string;
  /** Nom du conteneur ; déterministe pour que la réconciliation le retrouve. */
  name: string;
  /** `<VOLUMES_ROOT>/<student>/<assignment>/work`, monté sur `/work`. */
  workDir: string;
  /** Écrase `EngineOptions.image` quand le devoir impose une autre image. */
  image?: string;
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
  /** Crée et démarre le conteneur, renvoie son identifiant et son adresse. */
  run(req: RunRequest): Promise<ContainerInfo>;
  inspect(idOrName: string): Promise<ContainerInfo | null>;
  stop(idOrName: string, timeoutSeconds?: number): Promise<void>;
  rm(idOrName: string): Promise<void>;
  /** Uniquement les conteneurs portant le label de session. */
  listSessions(): Promise<ContainerInfo[]>;
  /** Attend `GET http://<ip>:8080/healthz`. Renvoie le délai en ms. */
  waitHealthy(ip: string, timeoutMs: number): Promise<number>;
  /** `podman exec` ; réservé aux tests et au script de bout en bout. */
  exec(idOrName: string, argv: string[]): Promise<string>;
  /** Les arguments exacts du `run`, pour qu'un test puisse les affirmer. */
  runArgs(req: RunRequest): string[];
}

/** Forme minimale de ce que `podman inspect --format json` nous rend. */
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
        `podman ${args[0] ?? ""} a échoué : ${e.message ?? "erreur inconnue"}`,
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
      // La marque d'une session. Le ramasse-miettes et la réconciliation ne
      // regardent rien d'autre, donc l'ancrage leur est invisible.
      "--label",
      `${SESSION_LABEL}=${req.sessionId}`,
      "--label",
      "codespace.role=student",
      // --- durcissement, copié de images/c-dev/run-hardened.sh -------------
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
      // --- réseau clos, invariant 2 ----------------------------------------
      "--network",
      opts.network,
      "--dns=none",
      "--add-host",
      `portal.internal:${opts.gateway}`,
      // --- volume, analyse.md D6 -------------------------------------------
      // `:U` : avec --userns=auto l'UID mappé change à chaque démarrage, donc
      // Podman rechown l'arborescence vers la plage du conteneur. Ne jamais
      // retirer cette option pour simplifier un test.
      "-v",
      `${req.workDir}:/work:U`,
      req.image ?? opts.image,
    ];
  }

  return {
    runArgs,

    async run(req) {
      // Un conteneur homonyme resté d'un démarrage précédent empêcherait le
      // `run` ; la réconciliation l'a normalement déjà retiré.
      await podman(["rm", "-f", req.name], 30_000).catch(() => "");
      await podman(runArgs(req), 180_000);
      const info = await this.inspect(req.name);
      if (!info) throw new EngineError(`conteneur ${req.name} introuvable après run`, "");
      opts.log?.info(
        { sessionId: req.sessionId, container: info.id.slice(0, 12), ip: info.ip },
        "conteneur de session démarré",
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
        // `--filter label=` seul accepterait un conteneur au label vide ;
        // ce qui définit une session, c'est une valeur.
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
      throw new EngineError(`/healthz de ${ip} muet après ${timeoutMs} ms (${last})`, "");
    },

    async exec(idOrName, argv) {
      return podman(["exec", idOrName, ...argv], 300_000);
    },
  };
}
