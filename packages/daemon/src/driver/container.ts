import { randomBytes } from "node:crypto";
import Docker from "dockerode";
import { gatewayOf } from "../net/firewall.js";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { AgentConn } from "./agent.js";
import { AgentDriver } from "./agent-driver.js";
import type { CreateOptions, HostInfo, ResourceLimits } from "./types.js";
import { shellEscape } from "../util.js";
import { redactSecrets, safeRepoForLog } from "../audit.js";
import { log } from "../logger.js";

/**
 * Container driver — backs each sandbox with a long-lived OCI container via the
 * Docker Engine API. Maximum density and works identically on Linux and macOS
 * (Docker Desktop / colima / Apple `container`'s Docker-compatible endpoint).
 *
 * The container is named deterministically from the sandbox id. A static Linux
 * `hotcell-agent` runs as PID 1 and serves exec/files/process/terminal operations
 * over a per-sandbox Unix socket on Linux, or an authenticated loopback TCP port
 * on non-Linux Docker hosts where bind-mounted Unix sockets are not forwarded.
 * Docker remains responsible for lifecycle, workspace volumes, resource limits,
 * and networking.
 */
/** Egress-enforcement network settings, passed in from config by the driver factory. */
export interface EgressNetConfig {
  enforce: boolean;
  network: string;
  subnet: string;
  /** Pinned DNS resolver IP, or "" for Docker's embedded resolver. */
  dns: string;
}

const AGENT_TCP_PORT = 49173;

interface TcpAgentEndpoint {
  host: string;
  port: number;
  token: string;
}

export class ContainerDriver extends AgentDriver {
  readonly name = "container";
  private docker: Docker;
  private ensured = new Set<string>();
  private egress?: EgressNetConfig;
  private egressNetReady = false;
  private egressIpCache = new Map<string, string>();
  private egressIpCacheAt = 0;
  private egressIpRefresh?: Promise<void>;
  private readonly agentBaseDir: string;
  private readonly configuredAgentBin?: string;
  private readonly agentTransport: "unix" | "tcp";
  private readonly agentTcpEndpoints = new Map<string, TcpAgentEndpoint>();

  constructor(
    docker?: Docker,
    egress?: EgressNetConfig,
    agent?: { baseDir?: string; binaryPath?: string; transport?: "unix" | "tcp" },
  ) {
    super();
    this.docker = docker ?? new Docker();
    this.egress = egress;
    this.agentBaseDir = agent?.baseDir ?? join(tmpdir(), `hotcell-agent-${process.getuid?.() ?? "user"}`);
    this.configuredAgentBin = agent?.binaryPath;
    // Docker Desktop/Colima/OrbStack on macOS do not reliably forward AF_UNIX
    // sockets through bind mounts. Publish an authenticated loopback TCP port there.
    this.agentTransport = agent?.transport ?? (process.platform === "linux" ? "unix" : "tcp");
  }

  protected async openConn(id: string): Promise<AgentConn> {
    if (this.agentTransport === "tcp") {
      const endpoint = await this.resolveAgentTcpEndpoint(id);
      return AgentConn.connectTcp({ ...endpoint, timeoutMs: 15000 });
    }
    return AgentConn.connect({ path: this.agentSocketPath(id), timeoutMs: 15000 });
  }

  private async resolveAgentTcpEndpoint(id: string): Promise<TcpAgentEndpoint> {
    const cached = this.agentTcpEndpoints.get(id);
    if (cached) return cached;
    const inspect = await this.docker.getContainer(this.containerName(id)).inspect();
    return this.cacheAgentTcpEndpoint(id, inspect);
  }

  private async captureAgentTcpEndpoint(
    id: string,
    container: { inspect(): Promise<unknown> },
    token: string,
  ): Promise<void> {
    const inspect = await container.inspect();
    this.cacheAgentTcpEndpoint(id, inspect, token);
  }

  private cacheAgentTcpEndpoint(id: string, inspect: unknown, fallbackToken?: string): TcpAgentEndpoint {
    const details = inspect as {
      Config?: { Env?: string[] };
      NetworkSettings?: { Ports?: Record<string, Array<{ HostPort?: string }> | null> };
    };
    const tokenEntry = details.Config?.Env?.find((entry) => entry.startsWith("HOTCELL_AGENT_TOKEN="));
    const token = fallbackToken ?? tokenEntry?.slice("HOTCELL_AGENT_TOKEN=".length);
    const hostPort = details.NetworkSettings?.Ports?.[`${AGENT_TCP_PORT}/tcp`]?.[0]?.HostPort;
    const port = Number(hostPort);
    if (!token || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error(`container driver: missing authenticated TCP agent endpoint for sandbox ${id}`);
    }
    const endpoint = { host: "127.0.0.1", port, token };
    this.agentTcpEndpoints.set(id, endpoint);
    return endpoint;
  }

  private agentSocketDir(id: string): string {
    return join(this.agentBaseDir, id);
  }

  private agentSocketPath(id: string): string {
    return join(this.agentSocketDir(id), "a.sock");
  }

  private cleanupAgentSocket(id: string): void {
    this.agentTcpEndpoints.delete(id);
    rmSync(this.agentSocketDir(id), { recursive: true, force: true });
  }

  private async resolveAgentBinary(): Promise<string> {
    const override = this.configuredAgentBin ?? process.env.HOTCELL_AGENT_BIN;
    const info = override ? {} : await this.docker.info().catch(() => ({}));
    const rawArch = String((info as { Architecture?: string }).Architecture ?? process.arch).toLowerCase();
    const arch = /arm64|aarch64/.test(rawArch)
      ? "arm64"
      : /amd64|x86_64|x64/.test(rawArch)
        ? "amd64"
        : process.arch === "arm64" ? "arm64" : "amd64";
    const filename = `hotcell-agent-linux-${arch}`;
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidates = override
      ? [resolve(override)]
      : [
          resolve(moduleDir, "../../../../agent/dist", filename),
          join(moduleDir, "..", "agent-assets", filename),
        ];
    const binary = candidates.find((candidate) => existsSync(candidate));
    if (!binary) {
      throw new Error(
        `container driver: guest agent binary not found for ${rawArch}; run npm run build:agent from the source checkout or set HOTCELL_AGENT_BIN`,
      );
    }
    if ((statSync(binary).mode & 0o111) === 0) {
      throw new Error(`container driver: guest agent is not executable: ${binary}`);
    }
    return binary;
  }

  private async waitForAgent(id: string): Promise<void> {
    const deadline = Date.now() + 30000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const conn = await this.openConn(id);
        conn.close();
        return;
      } catch (err) {
        lastError = err;
        await sleep(100);
      }
    }
    throw new Error(
      `container driver: guest agent did not become ready for ${id}: ${String((lastError as Error)?.message ?? lastError)}`,
    );
  }

  private containerName(id: string): string {
    return `sbx-${id}`;
  }

  /** Deterministic name for the sandbox's persistent workspace volume. */
  private volumeName(id: string): string {
    return `sbx-${id}-workspace`;
  }

  async ping(): Promise<void> {
    try {
      await this.docker.ping();
    } catch (err) {
      throw new Error(
        `You need to start Docker first — launch Docker Desktop (or colima, or Apple 'container'), ` +
          `then run 'hotcell start' again. Already running on a non-default socket (colima, OrbStack, podman)? ` +
          `Point hotcell at it first: export DOCKER_HOST=unix://~/.colima/default/docker.sock ` +
          `(hotcell reads DOCKER_HOST, not the docker CLI's context). (underlying: ${(err as Error).message})`,
      );
    }
  }

  async hostInfo(): Promise<HostInfo> {
    const info = (await this.docker.info()) as { MemTotal?: number; NCPU?: number };
    return {
      memoryMb: Math.floor((info.MemTotal ?? 0) / (1024 * 1024)),
      cpus: info.NCPU ?? 0,
    };
  }

  /**
   * Startup reconcile of the egress network. Call once at boot when enforcement is
   * on, so a subnet collision surfaces immediately with an actionable message
   * rather than as a 422 on the first `create` (a terrible first impression under
   * load). No-op when enforcement is off.
   */
  async initEgress(): Promise<void> {
    if (this.egress?.enforce) await this.ensureEgressNetwork();
  }

  /** Map a logged firewall source IP back to the sandbox id Docker labeled on create. */
  async sandboxIdForEgressIp(ip: string): Promise<string | undefined> {
    if (!this.egress?.enforce) return undefined;
    if (Date.now() - this.egressIpCacheAt > 2_000) {
      this.egressIpRefresh ??= this.refreshEgressIpCache().finally(() => {
        this.egressIpRefresh = undefined;
      });
      await this.egressIpRefresh;
    }
    return this.egressIpCache.get(ip);
  }

  private async refreshEgressIpCache(): Promise<void> {
    type ContainerNetworkInfo = {
      Labels?: Record<string, string>;
      NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
    };
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: { network: [this.egress!.network] },
      }) as unknown as ContainerNetworkInfo[];
      const refreshed = new Map<string, string>();
      for (const container of containers) {
        const sandboxId = container.Labels?.["sbx.id"] ?? container.Labels?.["hotcell.id"];
        if (!sandboxId) continue;
        for (const network of Object.values(container.NetworkSettings?.Networks ?? {})) {
          if (network.IPAddress) refreshed.set(network.IPAddress, sandboxId);
        }
      }
      this.egressIpCache = refreshed;
      this.egressIpCacheAt = Date.now();
    } catch (err) {
      log.warn("could not refresh container IP map for egress audit", {
        error: String((err as Error)?.message ?? err),
      });
      this.egressIpCache = new Map();
      this.egressIpCacheAt = Date.now();
    }
  }

  /**
   * Ensure the egress-enforcement bridge network exists on the configured subnet
   * (idempotent). The subnet must match so the host firewall's `-s <subnet>` rules
   * apply, with the gateway pinned to `.1`. Reconciles a subnet collision:
   *   - our network already exists (409)     → adopt it;
   *   - an *idle, hotcell-managed* network squats the subnet (e.g. the pre-rename
   *     `sbx-egress` after an upgrade) → remove it and recreate;
   *   - a *foreign* network, or one with live containers, holds the subnet
   *     → fail loudly, naming it and the override flag. We never delete a network
   *     that a user might own or that is in use.
   */
  private async ensureEgressNetwork(): Promise<void> {
    if (!this.egress || this.egressNetReady) return;
    const { network, subnet } = this.egress;
    const gateway = gatewayOf(subnet);
    const create = () =>
      this.docker.createNetwork({
        Name: network,
        Driver: "bridge",
        CheckDuplicate: true,
        IPAM: { Driver: "default", Config: [{ Subnet: subnet, Gateway: gateway }] },
        Labels: { "sbx.managed": "true", "hotcell.managed": "true" },
      });
    try {
      await create();
      log.info("egress network created", { network, subnet });
    } catch (err) {
      if (isConflict(err)) {
        log.info("egress network already present — adopting", { network, subnet });
        this.egressNetReady = true; // 409 = our network already exists
        return;
      }
      if (isPoolOverlap(err)) {
        const { removed, blockers } = await this.reconcileSubnet(subnet, network);
        if (removed > 0 && blockers.length === 0) {
          await create();
          log.info("egress network recreated after clearing stale networks", { network, subnet, removed });
          this.egressNetReady = true;
          return;
        }
        throw new Error(
          `egress enforcement: subnet ${subnet} is already used by ${blockers.join(", ")} ` +
            `(not hotcell-managed, or with live containers) — refusing to delete it. ` +
            `Free that network, or set HOTCELL_EGRESS_SUBNET to an unused range.`,
        );
      }
      throw err;
    }
    this.egressNetReady = true;
  }

  /**
   * Resolve a subnet collision for `keepName`: remove idle hotcell-managed networks
   * squatting `subnet`, and report any that block us (foreign, or with live
   * containers) so the caller can fail with a clear message. Never removes a
   * network we don't recognise or that has attached containers.
   */
  private async reconcileSubnet(
    subnet: string,
    keepName: string,
  ): Promise<{ removed: number; blockers: string[] }> {
    let removed = 0;
    const blockers: string[] = [];
    let nets: Array<{
      Name?: string;
      Id?: string;
      Labels?: Record<string, string>;
      Containers?: Record<string, unknown>;
      IPAM?: { Config?: Array<{ Subnet?: string }> };
    }> = [];
    try {
      nets = (await this.docker.listNetworks()) as typeof nets;
    } catch {
      return { removed, blockers: ["(could not list Docker networks)"] };
    }
    for (const n of nets) {
      if (n.Name === keepName) continue;
      if (!n.IPAM?.Config?.some((c) => c.Subnet === subnet)) continue; // not on our subnet
      const managed = n.Labels?.["sbx.managed"] === "true" || n.Labels?.["hotcell.managed"] === "true";
      const idle = !n.Containers || Object.keys(n.Containers).length === 0;
      const label = `"${n.Name}"`;
      if (managed && idle && n.Id) {
        try {
          await this.docker.getNetwork(n.Id).remove();
          log.info("removed a stale hotcell-managed egress network on our subnet", { name: n.Name, subnet });
          removed++;
        } catch {
          blockers.push(`${label} (in use)`); // attached or racing — treat as a blocker
        }
      } else {
        blockers.push(managed ? `${label} (has live containers)` : `${label} (foreign network)`);
      }
    }
    return { removed, blockers };
  }

  /** Create the workspace volume if it does not already exist (idempotent). */
  private async ensureVolume(id: string): Promise<void> {
    const name = this.volumeName(id);
    await this.docker.createVolume({
      Name: name,
      Labels: { "sbx.managed": "true", "sbx.id": id },
    });
  }

  /** Pull the image if it is not already present locally. */
  private async ensureImage(image: string): Promise<void> {
    if (this.ensured.has(image)) return;
    const images = await this.docker.listImages({
      filters: { reference: [image] },
    });
    if (images.length === 0) {
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(image, (err: unknown, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          this.docker.modem.followProgress(stream, (doneErr: unknown) =>
            doneErr ? reject(doneErr) : resolve(),
          );
        });
      });
    }
    this.ensured.add(image);
  }

  async create(opts: CreateOptions): Promise<void> {
    opts.onProgress?.("launching container");
    await this.launchContainer(opts);
    if (opts.repo) {
      opts.onProgress?.("cloning repo");
      await this.cloneRepo(opts.id, opts.repo, opts.repoRef);
    }
    if (opts.setup?.length) opts.onProgress?.("running setup");
    await this.runSetup(opts.id, opts.setup ?? []);
  }

  /**
   * Clone a git repo into `/workspace` at create time so an agent comes up with
   * the code in place. Installs git first if the image lacks it (the default
   * slim image), then shallow-clones into a subdir named after the repo. A
   * failure throws — unlike best-effort `setup`, the agent needs the code.
   */
  private async cloneRepo(id: string, repo: string, ref?: string): Promise<void> {
    const refFlag = ref ? `--branch ${shellEscape(ref)} ` : "";
    const script =
      `if ! command -v git >/dev/null 2>&1; then apt-get update && apt-get install -y git >/dev/null 2>&1; fi\n` +
      `cd /workspace && git clone --depth 1 ${refFlag}${shellEscape(repo)}`;
    const { stdout, stderr, exitCode } = await this.execCapture(id, script);
    if (exitCode !== 0) {
      throw new Error(`git clone failed: ${redactSecrets((stderr || stdout).trim()) || `exit ${exitCode}`}`);
    }
    log.info("repo cloned", { sandbox: id, repo: safeRepoForLog(repo) });
  }

  /**
   * Run declarative setup commands in order, once, after the container starts.
   * Best-effort: a non-zero exit is logged but does not fail create. Kept out of
   * `launchContainer` on purpose so it does not re-fire on `start()`/resume.
   */
  private async runSetup(id: string, commands: string[]): Promise<void> {
    for (const command of commands) {
      const { stderr, exitCode } = await this.execCapture(id, command);
      if (exitCode === 0) {
        // Setup steps can carry credentials (the gateway-wired git remote embeds
        // the egress token; user steps may hold PATs): never log them raw.
        log.info("setup command ok", { sandbox: id, command: redactSecrets(command) });
      } else {
        log.warn("setup command failed (continuing)", {
          sandbox: id,
          command: redactSecrets(command),
          exitCode,
          stderr: redactSecrets(stderr.trim()),
        });
      }
    }
  }

  async start(opts: CreateOptions): Promise<void> {
    try {
      await this.launchContainer(opts);
    } catch (err: unknown) {
      // A 409 means the container already exists (already started) — treat as ok.
      if (!isConflict(err)) throw err;
    }
  }

  async stop(id: string): Promise<void> {
    // Remove the container but keep the workspace volume. With persistence the
    // data survives; without it, stop is effectively a destroy of the rootfs.
    await this.removeContainerIdempotent(this.containerName(id));
    this.cleanupAgentSocket(id);
  }

  /**
   * Force-remove a container, absorbing every "someone beat us to it" answer:
   * 404 (already gone) and 409 (a removal is already in progress — the idle
   * reaper and a client DELETE routinely race here, and surfacing that race as
   * a 500 once made a client read its own successful run as failed). On 409 we
   * wait for the winning removal to finish, so callers can safely reclaim
   * dependent resources like the workspace volume.
   */
  private async removeContainerIdempotent(name: string): Promise<void> {
    const container = this.docker.getContainer(name);
    try {
      await container.remove({ force: true });
    } catch (err: unknown) {
      if (isNotFound(err)) return;
      // We always remove with force, so a 409 can only mean removal-in-progress.
      if (!isConflict(err)) throw err;
      try {
        await container.wait({ condition: "removed" });
      } catch (waitErr: unknown) {
        // Vanishing mid-wait is the outcome we wanted.
        if (!isNotFound(waitErr)) throw waitErr;
      }
    }
  }

  /** Shared create/start path: mount the static agent and start it as PID 1. */
  private async launchContainer(opts: CreateOptions): Promise<void> {
    await this.ensureImage(opts.image);
    const agentBinary = await this.resolveAgentBinary();
    const persist = opts.persist ?? true;
    const useTcp = this.agentTransport === "tcp";
    const token = useTcp ? randomBytes(32).toString("hex") : undefined;
    if (persist) await this.ensureVolume(opts.id);
    // Under egress enforcement, put the sandbox on the dedicated bridge network
    // (whose egress is locked down by the host firewall) and pin its DNS resolver.
    const enforced = this.egress?.enforce === true;
    if (enforced) await this.ensureEgressNetwork();

    const socketDir = this.agentSocketDir(opts.id);
    if (!useTcp) {
      mkdirSync(socketDir, { recursive: true, mode: 0o700 });
      chmodSync(socketDir, 0o700);
      if (Buffer.byteLength(this.agentSocketPath(opts.id)) > 100) {
        this.cleanupAgentSocket(opts.id);
        throw new Error(`container driver: agent socket path is too long for sandbox ${opts.id}`);
      }
    }
    // These variables are reserved for the transport and cannot be user-overridden.
    const sandboxEnv = { ...opts.env };
    delete sandboxEnv.HOTCELL_AGENT_LISTEN;
    delete sandboxEnv.SBX_AGENT_LISTEN;
    delete sandboxEnv.HOTCELL_AGENT_TOKEN;
    delete sandboxEnv.SBX_AGENT_TOKEN;
    const env = Object.entries({
      ...sandboxEnv,
      HOTCELL_AGENT_LISTEN: useTcp
        ? `tcp://0.0.0.0:${AGENT_TCP_PORT}`
        : "unix:///run/hotcell/a.sock",
      ...(token ? { HOTCELL_AGENT_TOKEN: token } : {}),
    }).map(([k, v]) => `${k}=${v}`);
    const binds = [
      ...(persist ? [`${this.volumeName(opts.id)}:/workspace`] : []),
      `${agentBinary}:/hotcell-agent:ro`,
      ...(!useTcp ? [`${socketDir}:/run/hotcell`] : []),
    ];
    let created = false;
    try {
      const container = await this.docker.createContainer({
        name: this.containerName(opts.id),
        Image: opts.image,
        Entrypoint: ["/hotcell-agent"],
        Cmd: [],
        Env: env,
        Labels: { "sbx.managed": "true", "sbx.id": opts.id, ...opts.labels },
        WorkingDir: "/workspace",
        ...(useTcp ? { ExposedPorts: { [`${AGENT_TCP_PORT}/tcp`]: {} } } : {}),
        HostConfig: {
          AutoRemove: false,
          Binds: binds,
          ...(useTcp
            ? {
                PortBindings: {
                  [`${AGENT_TCP_PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "" }],
                },
              }
            : {}),
          ...(enforced ? { NetworkMode: this.egress!.network } : {}),
          ...(enforced && this.egress!.dns ? { Dns: [this.egress!.dns] } : {}),
          ExtraHosts: ["host.docker.internal:host-gateway"],
          ...resourceHostConfig(opts.limits),
        },
      });
      created = true;
      await container.start();
      if (useTcp) await this.captureAgentTcpEndpoint(opts.id, container, token!);
      await this.waitForAgent(opts.id);
    } catch (err) {
      if (created) {
        await this.removeContainerIdempotent(this.containerName(opts.id)).catch(() => {});
        this.cleanupAgentSocket(opts.id);
      } else if (!isConflict(err)) {
        this.cleanupAgentSocket(opts.id);
      }
      throw err;
    }
  }

  async destroy(id: string): Promise<void> {
    await this.removeContainerIdempotent(this.containerName(id));
    this.cleanupAgentSocket(id);
    // Drop the persistent volume too — destroy is irreversible.
    try {
      await this.docker.getVolume(this.volumeName(id)).remove({ force: true });
    } catch (err: unknown) {
      if (!isNotFound(err)) throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  return statusCode(err) === 404;
}

function isConflict(err: unknown): boolean {
  return statusCode(err) === 409;
}

/** Docker's 403 "Pool overlaps with other one on this address space" — a
 *  different network already owns the requested subnet. */
function isPoolOverlap(err: unknown): boolean {
  const msg =
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message?: unknown }).message)
      : String(err);
  return /pool overlaps/i.test(msg);
}

function statusCode(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "statusCode" in err
    ? (err as { statusCode?: number }).statusCode
    : undefined;
}

/**
 * Translate sandbox resource limits into Docker `HostConfig` cgroup fields.
 * Omits any limit that's 0/undefined so it stays unlimited. `cpus` → `NanoCpus`
 * (1 core = 1e9), `memoryMb` → `Memory` bytes, `pidsLimit` → `PidsLimit`.
 */
function resourceHostConfig(limits?: ResourceLimits): {
  Memory?: number;
  NanoCpus?: number;
  PidsLimit?: number;
} {
  const cfg: { Memory?: number; NanoCpus?: number; PidsLimit?: number } = {};
  if (limits?.memoryMb && limits.memoryMb > 0) {
    cfg.Memory = Math.round(limits.memoryMb * 1024 * 1024);
  }
  if (limits?.cpus && limits.cpus > 0) {
    cfg.NanoCpus = Math.round(limits.cpus * 1e9);
  }
  if (limits?.pidsLimit && limits.pidsLimit > 0) {
    cfg.PidsLimit = Math.round(limits.pidsLimit);
  }
  return cfg;
}
