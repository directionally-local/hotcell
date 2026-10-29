import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import {
  closeSync,
  createWriteStream,
  existsSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { totalmem, cpus as osCpus } from "node:os";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AgentConn } from "./agent.js";
import { AgentDriver } from "./agent-driver.js";
import {
  buildFcApiCalls,
  buildSnapshotCreateCall,
  buildSnapshotLoadCall,
  FC_DEFAULT_BOOT_ARGS,
  FC_PAUSE_VM,
  FC_START_ACTION,
  FcApi,
  type FcNetSpec,
  fcTapSetupCommands,
  fcTapTeardownCommands,
  fcVsockConnect,
  rewriteSnapshotPaths,
} from "./fc-api.js";
import { VzImageCache } from "./vz-image.js";
import type {
  CreateOptions,
  CreateTemplateOptions,
  ForkOptions,
  HostInfo,
  ResourceLimits,
  TemplateInfo,
} from "./types.js";
import { redactSecrets } from "../audit.js";
import { log } from "../logger.js";

/** Config the driver factory hands the Firecracker driver (subset of daemon config). */
export interface FcConfig {
  /** Path to the `firecracker` binary. */
  fcBin: string;
  /** Guest Linux kernel (uncompressed vmlinux, per-arch). */
  kernel: string;
  /** Prebuilt base rootfs (ext4 with the agent as PID 1) for the sentinel images. */
  rootfs: string;
  /** Per-sandbox VM state dir (disks, sockets). */
  stateDir: string;
  /** Initial sparse size of a new workspace disk, in GiB. */
  diskGb: number;
  /** Cache dir for OCI→ext4 converted rootfs images + the blank workspace template. */
  imageCacheDir: string;
  /** Target platform for OCI→ext4 conversion (default matches the host arch). */
  platform?: string;
  /** Warm-pool size: keep N pre-booted spare microVMs for instant adoption (0 = off). */
  warmPool?: number;
  /** Image the warm pool pre-boots (a plain create of this image adopts a spare). */
  poolImage?: string;
  /**
   * Resource shape the pool's spares boot with. Adoption requires the create's
   * resolved limits to EQUAL this shape (a looser match would hand out a VM
   * bigger than admission control charged for). Pass the daemon's default
   * limits so plain creates stay pool-eligible.
   */
  poolLimits?: ResourceLimits;
  /**
   * Egress gateway port for the guest relay (0/unset = no relay). The guest gets
   * a loopback listener on this port whose connections tunnel over vsock to the
   * host and on to `egressHost:egressPort` — the NIC-less guest's only way out.
   */
  egressPort?: number;
  /** Host the egress gateway listens on (default 127.0.0.1). */
  egressHost?: string;
}

/** Concurrent warm-pool spare boots: refill fast, but leave CPU for foreground creates. */
const FILL_CONCURRENCY = 4;

/** Live per-sandbox microVM: the `firecracker` process + its API + vsock sockets. */
interface FcVm {
  proc: ChildProcess;
  apiSock: string;
  vsockUds: string;
  workspaceImg: string;
  stateDir: string;
  /** TAP/NAT networking parameters, when the sandbox opted into a NIC. */
  net?: FcNetSpec;
}

const AGENT_VSOCK_PORT = 1024; // the in-guest agent listens here (matches VZ)

/**
 * What a template directory holds. The daemon's SQLite row is the index; this
 * file is what the driver needs to restore a clone without the daemon.
 */
export interface FcTemplateMeta {
  name: string;
  image: string;
  limits: ResourceLimits;
  createdAt: string;
  sourceSandboxId?: string;
  /** Disk files copied into the template dir (relative names). */
  disks: string[];
  /** Absolute state dir the snapshot was taken in — rewritten per clone. */
  sourceDir: string;
}

/** Disks a template may carry. `workspace.img` is always present; a private
 *  writable rootfs is only there when the source sandbox had one. */
const TEMPLATE_DISKS = ["workspace.img", "rootfs.img"] as const;

/** Read a template's `meta.json`. Throws a caller-actionable error when the
 *  directory or file is missing (a stale daemon row, or a hand-deleted dir). */
export function readTemplateMeta(templateDir: string): FcTemplateMeta {
  const path = join(templateDir, "meta.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`template metadata missing at ${path} (was the template deleted?)`);
  }
  return JSON.parse(raw) as FcTemplateMeta;
}

/**
 * Materialize one clone of a template into `cloneDir`: copy the vmstate and the
 * disks, hard-link the memory file, and rewrite the snapshot's embedded paths.
 *
 * The memory file is **hard-linked, not copied** — Firecracker maps it
 * copy-on-write (`MAP_PRIVATE`), so every clone reads the same inode and writes
 * only its own private pages. That is what makes a fork cost ~0 bytes and
 * milliseconds instead of a gigabyte copy. Disks are reflinked (CoW on
 * btrfs/xfs) or copied, because guest writes must land in the clone's own file.
 *
 * Exported so the host-agnostic check can exercise the layout without KVM.
 */
export function prepareForkClone(
  templateDir: string,
  cloneDir: string,
): { vmstate: string; memFile: string } {
  const meta = readTemplateMeta(templateDir);
  const vmstate = join(cloneDir, "snapshot.vmstate");
  const memFile = join(cloneDir, "snapshot.mem");
  cloneFile(join(templateDir, "snapshot.vmstate"), vmstate);
  linkOrClone(join(templateDir, "snapshot.mem"), memFile);
  for (const disk of meta.disks) cloneFile(join(templateDir, disk), join(cloneDir, disk));
  // The vmstate pins the template's absolute paths; point them at this clone.
  writeFileSync(vmstate, rewriteSnapshotPaths(readFileSync(vmstate, "utf8"), templateDir, cloneDir));
  return { vmstate, memFile };
}


/**
 * Firecracker microVM driver (Linux, KVM). Each sandbox is a Firecracker microVM:
 * the driver spawns `firecracker`, configures it over its HTTP-API-over-unix-socket
 * (boot source / machine-config / drives / vsock), boots it, and reaches the
 * in-guest `sbx-agent` over virtio-vsock — the **same agent and wire protocol the
 * Apple VZ driver uses**, so the entire agent-served surface (exec/files/processes/
 * ports/terminal/stats/backup) is inherited from {@link AgentDriver} unchanged.
 *
 * **Host requirement:** `/dev/kvm` + the `firecracker` binary. All the code here is
 * host-agnostic and compiles/unit-tests anywhere (see `check:fc`); only the live
 * boot needs a KVM (or nested-virt) Linux host, gated behind `smoke:fc`.
 */
export class FirecrackerDriver extends AgentDriver {
  readonly name = "firecracker";
  private vms = new Map<string, FcVm>();
  private images: VzImageCache;
  private pool: FcVm[] = [];
  private poolTarget: number;
  private poolSeq = 0;
  private tapSeq = 0;
  private inFlightFills = 0;
  private fillBackoffUntil = 0;
  private fillBackoffMs = 0; // doubles per consecutive boot failure, resets on success
  /**
   * Every live VMM this driver spawned. Firecracker ignores stdin, so — unlike
   * the VZ helper, which exits on stdin EOF — a VMM survives `process.exit()`.
   * The process-exit hook SIGKILLs the set so a daemon restart (or a test
   * harness exiting mid-boot) can't strand gigabyte-sized zombie VMs that the
   * next daemon's capacity ledger will never see.
   */
  private readonly liveVmms = new Set<ChildProcess>();
  private readonly killLiveVmms = () => {
    for (const p of this.liveVmms) {
      try {
        p.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };
  private readonly poolImage: string;
  private readonly poolLimits: ResourceLimits;
  private readonly poolDir: string;

  constructor(private readonly cfg: FcConfig) {
    super();
    // The OCI→ext4 converter + staged guest files live under `helpers/hotcell-vz`
    // (shared with the VZ driver: same rootfs artifact, same agent-as-init).
    const vzDir = join(dirname(dirname(cfg.rootfs)));
    this.images = new VzImageCache({
      vzDir: vzDir.endsWith("guest") ? dirname(vzDir) : "helpers/hotcell-vz",
      cacheDir: cfg.imageCacheDir,
      prebuiltRootfs: cfg.rootfs,
      // Convert OCI images for the host arch (the guest runs on this KVM host).
      platform: cfg.platform ?? (process.arch === "arm64" ? "linux/arm64" : "linux/amd64"),
    });
    this.poolTarget = Math.max(0, cfg.warmPool ?? 0);
    this.poolImage = cfg.poolImage ?? "base";
    this.poolLimits = cfg.poolLimits ?? {};
    this.poolDir = join(cfg.stateDir, "_pool");
    process.once("exit", this.killLiveVmms);
    if (this.poolTarget > 0) {
      // Clear stale slots from a previous run (their VMMs died with the daemon).
      try {
        rmSync(this.poolDir, { recursive: true, force: true });
      } catch {
        /* not there */
      }
      this.fillPool();
    }
  }

  // --- lifecycle ------------------------------------------------------------

  async create(opts: CreateOptions): Promise<void> {
    opts.onProgress?.("booting vm");
    await this.launch(opts);
    if (opts.setup?.length) opts.onProgress?.("running setup");
    for (const command of opts.setup ?? []) {
      const code = await this.exec(opts.id, command, {}, () => {}).catch(() => -1);
      // Setup steps can carry credentials (the gateway-wired git remote embeds
      // the egress token; user steps may hold PATs): never log them raw.
      if (code === 0) log.info("setup command ok", { sandbox: opts.id, command: redactSecrets(command) });
      else log.warn("setup command failed (continuing)", { sandbox: opts.id, command: redactSecrets(command), code });
    }
  }

  async start(opts: CreateOptions): Promise<void> {
    await this.launch(opts);
  }

  /** Bring a sandbox live: adopt a warm-pool spare when eligible (instant), else
   *  resume its snapshot, else cold-boot. Then apply the sandbox env. */
  private async launch(opts: CreateOptions): Promise<void> {
    const id = opts.id;
    if (this.vms.has(id)) return;
    const stateDir = join(this.cfg.stateDir, id);

    // Warm-pool adoption — must run before the canonical dir is created, since
    // adoption makes that path a symlink to the spare's slot dir.
    if (this.tryAdopt(opts)) {
      if (opts.env && Object.keys(opts.env).length) {
        await this.withConn(id, (c) => c.setEnv(opts.env!));
      }
      log.info("firecracker VM up", { sandbox: id, warm: true });
      return;
    }

    mkdirSync(stateDir, { recursive: true });

    // If a snapshot exists from a fast-pause, resume from it (guest RAM + device
    // state restored — no kernel boot; background processes come back live).
    const vmstate = join(stateDir, "snapshot.vmstate");
    const memFile = join(stateDir, "snapshot.mem");
    if (existsSync(vmstate) && existsSync(memFile)) {
      try {
        await this.resumeFromSnapshot(id, stateDir, vmstate, memFile);
        log.info("firecracker VM resumed from snapshot", { sandbox: id });
        return;
      } catch (err) {
        // A snapshot that won't load must never brick the sandbox: discard it and
        // cold-boot (workspace intact — `snapshot()` synced the guest fs first;
        // only live RAM/process state is lost).
        log.warn("snapshot restore failed; discarding it and cold-booting", {
          sandbox: id,
          error: (err as Error).message,
        });
        for (const f of [vmstate, memFile]) rmQuiet(f);
      }
    }

    const vm = await this.bootMicroVm({
      id,
      stateDir,
      image: opts.image,
      limits: opts.limits,
      networked: opts.networked,
      writableRootfs: opts.writableRootfs,
      cpuset: opts.cpuset,
    });
    this.vms.set(id, vm);
    try {
      if (opts.env && Object.keys(opts.env).length) {
        await this.withConn(id, (c) => c.setEnv(opts.env!));
      }
    } catch (err) {
      this.vms.delete(id);
      await killAndWait(vm.proc);
      throw err;
    }
    log.info("firecracker VM up", { sandbox: id });
  }

  /**
   * Cold-boot a microVM in `stateDir` and wait for its in-guest agent, returning
   * the live FcVm. Shared by the launch path and the warm-pool filler. Does not
   * touch `this.vms` or apply sandbox env — the caller owns those.
   */
  private async bootMicroVm(p: {
    id: string;
    stateDir: string;
    image: string;
    limits?: CreateOptions["limits"];
    networked?: boolean;
    writableRootfs?: boolean;
    cpuset?: string;
  }): Promise<FcVm> {
    mkdirSync(p.stateDir, { recursive: true });
    let rootfs = await this.images.ensureRootfs(p.image);

    // Opt-in NAT networking: give the guest a real eth0 (host TAP + masquerade).
    // Default posture is no NIC (egress over vsock only).
    const net = p.networked ? this.setupTap(p.id) : undefined;

    // Private writable rootfs so the guest can write to `/` (apt, node into
    // /opt, …). Implied by `networked` ("trusted VM" mode) or opted into alone
    // via `writableRootfs` (contained: no NIC, egress via vsock only). The
    // default shared rootfs is read-only. Cloned + grown once per sandbox.
    let rootfsReadOnly = true;
    if (p.networked || p.writableRootfs) {
      const priv = join(p.stateDir, "rootfs.img");
      if (!existsSync(priv)) {
        cloneFile(rootfs, priv);
        growExt4(priv, 8);
      }
      rootfs = priv;
      rootfsReadOnly = false;
    }

    // First boot only: give the sandbox its own workspace disk (clone the blank
    // pre-formatted template; else a sparse file the guest formats).
    const workspaceImg = join(p.stateDir, "workspace.img");
    if (!existsSync(workspaceImg)) {
      let blank: string | null = null;
      try {
        blank = await this.images.ensureBlankWorkspace(this.cfg.diskGb);
      } catch (err) {
        log.warn("blank workspace build failed; guest will format a sparse disk", {
          sandbox: p.id,
          error: (err as Error).message,
        });
      }
      if (blank) cloneFile(blank, workspaceImg);
      else ensureSparseFile(workspaceImg, this.cfg.diskGb * 1024 ** 3);
    }

    const cpus = p.limits?.cpus ? Math.max(1, Math.ceil(p.limits.cpus)) : 2;
    const memMib = p.limits?.memoryMb && p.limits.memoryMb > 0 ? p.limits.memoryMb : 1024;
    const pidsMax = p.limits?.pidsLimit && p.limits.pidsLimit > 0 ? p.limits.pidsLimit : 0;
    const bootArgs = pidsMax > 0 ? `${FC_DEFAULT_BOOT_ARGS} hotcell.pids=${pidsMax} sbx.pids=${pidsMax}` : FC_DEFAULT_BOOT_ARGS;

    const configureAndBoot = async (): Promise<FcVm> => {
      const vm = await this.spawnVmm(p.stateDir, p.cpuset);
      try {
        const api = new FcApi(vm.apiSock);
        await api.applyAll(
          buildFcApiCalls({
            kernelPath: this.cfg.kernel,
            rootfsPath: rootfs,
            workspacePath: workspaceImg,
            vcpus: cpus,
            memMib,
            vsockUds: vm.vsockUds,
            bootArgs,
            net,
            rootfsReadOnly,
          }),
        );
        await api.call(FC_START_ACTION);
        vm.net = net;
        return vm;
      } catch (err) {
        await killAndWait(vm.proc);
        throw err;
      }
    };
    const vm = await this.withOneRetry(p.id, configureAndBoot, "boot");
    try {
      await this.waitForAgent(vm);
      // Cold boots need the in-guest side of the egress relay started (after a
      // snapshot resume it's already alive in the restored RAM).
      if (this.cfg.egressPort && this.cfg.egressPort > 0) {
        const { socket, leftover } = await fcVsockConnect(vm.vsockUds, AGENT_VSOCK_PORT, 15000);
        const conn = await AgentConn.attach(socket, leftover, 15000);
        try {
          await conn.egressListen(this.cfg.egressPort);
        } finally {
          conn.close();
        }
      }
    } catch (err) {
      await killAndWait(vm.proc);
      throw err;
    }
    return vm;
  }

  // --- opt-in NAT networking --------------------------------------------------

  /**
   * Create a host TAP device + masquerade NAT for a networked sandbox and return
   * its `FcNetSpec`. Each sandbox gets a private /30 (gateway .1 = host TAP, guest
   * .2). The guest may only go out the default-route interface: no host services,
   * no cloud metadata, no other TAPs/bridges (see `fcTapRules`). Requires the
   * daemon to run with CAP_NET_ADMIN (root). Idempotent per id.
   */
  private setupTap(id: string): FcNetSpec {
    const idx = (this.tapSeq++ % 250) + 2; // 2..251, avoids .0/.1 collisions
    const tap = `hct${idx}`;
    const net: FcNetSpec = {
      tap,
      guestMac: `02:fc:00:00:00:${idx.toString(16).padStart(2, "0")}`,
      guestIp: `172.16.${idx}.2`,
      gatewayIp: `172.16.${idx}.1`,
      mask: "255.255.255.252",
    };
    const ext = this.defaultRouteIface();
    const sh = (cmd: string) => execFileSync("bash", ["-lc", cmd], { stdio: "ignore" });
    try {
      for (const cmd of fcTapSetupCommands(net, ext)) sh(cmd);
      log.info("firecracker: NAT networking up", { sandbox: id, tap, guestIp: net.guestIp });
    } catch (err) {
      this.teardownTap(net); // don't strand a half-installed rule set
      throw new Error(`firecracker: TAP/NAT setup failed (needs root/CAP_NET_ADMIN): ${(err as Error).message}`);
    }
    return net;
  }

  /** Tear down a sandbox's TAP device + NAT rules. Best-effort. */
  private teardownTap(net: FcNetSpec): void {
    const ext = this.defaultRouteIface();
    for (const cmd of fcTapTeardownCommands(net, ext)) {
      try {
        execFileSync("bash", ["-lc", cmd], { stdio: "ignore" });
      } catch {
        /* best-effort */
      }
    }
  }

  private _extIface?: string;
  /** The host's default-route interface (for NAT masquerade), cached. */
  private defaultRouteIface(): string {
    if (this._extIface) return this._extIface;
    try {
      const out = execFileSync("bash", ["-lc", "ip -o -4 route show to default | awk '{print $5; exit}'"])
        .toString()
        .trim();
      this._extIface = out || "eth0";
    } catch {
      this._extIface = "eth0";
    }
    return this._extIface;
  }

  // --- warm pool --------------------------------------------------------------

  /** Spares currently ready for adoption (used by checks). */
  poolSize(): number {
    return this.pool.length;
  }

  /** Pool footprint for admission control. */
  poolStats(): { spares: number; reservedMb: number } {
    // Charged at TARGET, not momentary fill: a spare below target is owed — its
    // replacement boots without re-admission — so the budget must stay reserved
    // across the adopt→refill window, the concurrency cap, and failure backoffs.
    // Per-spare charge = the shape's cap, else the boot-path default memMib.
    const perSpareMb = this.poolLimits.memoryMb || 1024;
    return { spares: this.pool.length, reservedMb: this.poolTarget * perSpareMb };
  }

  /** Adoption requires the create's resolved limits to equal the pool shape exactly. */
  private poolShapeMatches(want?: ResourceLimits): boolean {
    return (
      (want?.memoryMb ?? 0) === (this.poolLimits.memoryMb ?? 0) &&
      (want?.cpus ?? 0) === (this.poolLimits.cpus ?? 0) &&
      (want?.pidsLimit ?? 0) === (this.poolLimits.pidsLimit ?? 0)
    );
  }

  /**
   * Adopt a pre-booted spare for `opts` when eligible — a plain create of the
   * pool image with default limits and no prior state. Adoption moves nothing:
   * the canonical state dir becomes a **symlink** to the spare's slot dir, so
   * every path the daemon joins under it resolves correctly while the absolute
   * slot paths Firecracker recorded at boot (drives, vsock UDS) stay real — which
   * keeps a later `snapshot()`/restore of the adopted VM loadable (`/snapshot/load`
   * re-opens the boot-time paths embedded in the vmstate).
   */
  private tryAdopt(opts: CreateOptions): boolean {
    if (this.poolTarget <= 0) return false;
    const canonical = join(this.cfg.stateDir, opts.id);
    const imageOk = opts.image === this.poolImage;
    const shapeOk = this.poolShapeMatches(opts.limits);
    const fresh = !existsSync(canonical);
    if (!imageOk || !shapeOk || !fresh) {
      // An idle pool that never adopts is a misconfiguration operators must see.
      if (this.pool.length > 0 && fresh) {
        log.info("warm pool: create not eligible for adoption", {
          sandbox: opts.id,
          reason: imageOk
            ? "limits differ from the pool shape"
            : `image ${opts.image} != pool ${this.poolImage}`,
        });
      }
      return false;
    }

    const spare = this.pool.shift();
    if (!spare) {
      this.fillPool(); // none ready — warm up for next time
      return false;
    }
    mkdirSync(dirname(canonical), { recursive: true });
    symlinkSync(spare.stateDir, canonical);
    this.vms.set(opts.id, spare);
    this.fillPool(); // replenish in the background
    log.info("firecracker adopted a warm-pool microVM", { sandbox: opts.id });
    return true;
  }

  /**
   * Top the pool up to its target with bounded-parallel spare boots. Serial
   * refill (~2.5 s/guest) drains far slower than creates arrive; parallel boots
   * refill at ~FILL_CONCURRENCY× that rate while leaving CPU headroom for
   * foreground creates.
   */
  private fillPool(): void {
    if (this.poolTarget <= 0 || Date.now() < this.fillBackoffUntil) return;
    const missing = this.poolTarget - this.pool.length - this.inFlightFills;
    const spawn = Math.min(missing, FILL_CONCURRENCY - this.inFlightFills);
    for (let i = 0; i < spawn; i++) void this.fillOne();
  }

  private async fillOne(): Promise<void> {
    this.inFlightFills++;
    const n = ++this.poolSeq;
    try {
      const vm = await this.bootMicroVm({
        id: `pool-${n}`,
        stateDir: join(this.poolDir, `slot-${n}`),
        image: this.poolImage,
        limits: this.poolLimits,
      });
      if (this.poolTarget <= 0) {
        // Drained while booting: destroy the orphan instead of leaking it.
        await killAndWait(vm.proc).catch(() => {});
        try {
          rmSync(vm.stateDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        return;
      }
      this.pool.push(vm);
      log.info("warm pool: spare microVM ready", { size: this.pool.length, target: this.poolTarget });
      this.fillBackoffMs = 0; // healthy again — reset the failure backoff
    } catch (err) {
      // Exponential backoff (5s → 60s cap) against spawn-storms, with an unref'd
      // retry timer so the pool heals to target on its own — without one, a
      // single failure would suppress every sibling refill until the next
      // create happened to call fillPool.
      this.fillBackoffMs = Math.min(Math.max(this.fillBackoffMs * 2, 5000), 60_000);
      this.fillBackoffUntil = Date.now() + this.fillBackoffMs;
      log.warn("warm pool: spare boot failed", {
        error: (err as Error).message,
        retryInMs: this.fillBackoffMs,
      });
      setTimeout(() => this.fillPool(), this.fillBackoffMs + 50).unref();
    } finally {
      this.inFlightFills--;
      this.fillPool(); // keep topping up until the target is met
    }
  }

  /** Tear down all spare microVMs (e.g. on daemon shutdown). Idempotent. */
  async drainPool(): Promise<void> {
    this.poolTarget = 0;
    const spares = this.pool.splice(0);
    for (const vm of spares) await killAndWait(vm.proc);
    try {
      rmSync(this.poolDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  /** Spawn a fresh VMM process for `stateDir` and wait for its API socket. */
  private async spawnVmm(stateDir: string, cpuset?: string): Promise<FcVm> {
    const apiSock = join(stateDir, "fc-api.sock");
    const vsockUds = join(stateDir, "vsock.sock");
    for (const s of [apiSock, vsockUds]) rmQuiet(s);
    // Optional host-core pinning: constrain firecracker (and its vCPU threads) to
    // a fixed cpuset via taskset — keeps a guest on one CCD / shared L3 for stable
    // benchmark topology. Falls through to an unpinned spawn when cpuset is unset.
    const proc = cpuset
      ? spawn("taskset", ["-c", cpuset, this.cfg.fcBin, "--api-sock", apiSock], { stdio: ["ignore", "pipe", "pipe"] })
      : spawn(this.cfg.fcBin, ["--api-sock", apiSock], { stdio: ["ignore", "pipe", "pipe"] });
    this.liveVmms.add(proc);
    proc.once("exit", () => this.liveVmms.delete(proc));
    proc.stdout.pipe(createWriteStream(join(stateDir, "console.log"), { flags: "a" }));
    proc.stderr.pipe(createWriteStream(join(stateDir, "console.log"), { flags: "a" }));
    const vm: FcVm = { proc, apiSock, vsockUds, workspaceImg: join(stateDir, "workspace.img"), stateDir };
    this.startEgressRelay(vm);
    try {
      await waitForFile(apiSock, 5000); // firecracker creates the API socket on startup
    } catch (err) {
      await killAndWait(proc);
      throw err;
    }
    return vm;
  }

  /**
   * Host side of the guest egress relay. When the guest dials vsock port P,
   * firecracker connects to the unix socket `<vsockUds>_P` — so we listen there
   * and splice every such connection to the egress gateway. Set up per-VMM
   * (boot, snapshot-load, and pool spares alike) before the guest can dial;
   * torn down automatically with the VMM process.
   */
  private startEgressRelay(vm: FcVm): void {
    const port = this.cfg.egressPort;
    if (!port || port <= 0) return;
    const path = `${vm.vsockUds}_${port}`;
    rmQuiet(path);
    const srv = createNetServer((guest) => {
      const up = netConnect(port, this.cfg.egressHost ?? "127.0.0.1");
      const close = (): void => {
        guest.destroy();
        up.destroy();
      };
      guest.pipe(up);
      up.pipe(guest);
      guest.on("error", close);
      up.on("error", close);
      guest.on("close", close);
      up.on("close", close);
    });
    srv.on("error", (err) =>
      log.warn("egress relay listener error", { path, error: String(err) }),
    );
    srv.listen(path);
    vm.proc.once("exit", () => {
      srv.close();
      rmQuiet(path);
    });
  }

  /**
   * Run a VMM bring-up step, retrying once on a fresh process. Rationale: a VMM
   * spawned immediately after the previous one's SIGKILL can die silently before
   * serving its API (a transient KVM/VMM teardown race seen on nested-virt
   * hosts, ~ECONNRESET mid-configure); a single respawn reliably clears it.
   */
  private async withOneRetry<T>(id: string, step: () => Promise<T>, what: string): Promise<T> {
    try {
      return await step();
    } catch (err) {
      log.warn(`firecracker ${what} failed; retrying once on a fresh VMM`, {
        sandbox: id,
        error: (err as Error).message,
      });
      try {
        return await step();
      } catch (err2) {
        throw new Error(`firecracker: VM ${what} failed: ${(err2 as Error).message}`);
      }
    }
  }

  /** Poll the guest vsock until the agent answers its Hello, or time out. */
  private async waitForAgent(vm: FcVm, timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      if (vm.proc.exitCode !== null) {
        throw new Error(`firecracker exited (code ${vm.proc.exitCode}) before the agent came up`);
      }
      try {
        const { socket, leftover } = await fcVsockConnect(vm.vsockUds, AGENT_VSOCK_PORT, 2000);
        const conn = await AgentConn.attach(socket, leftover, 2000);
        conn.close();
        return;
      } catch (err) {
        lastErr = err;
        await sleep(400);
      }
    }
    throw new Error(`firecracker: agent never came up: ${String((lastErr as Error)?.message ?? lastErr)}`);
  }

  /** Boot a fresh VMM and load the saved snapshot into it (no kernel boot). The
   *  snapshot pins the vsock UDS path; firecracker re-binds it on load (stale
   *  socket files are cleared by `spawnVmm`). */
  private async resumeFromSnapshot(
    id: string,
    stateDir: string,
    vmstate: string,
    memFile: string,
  ): Promise<void> {
    const loadSnapshot = async (): Promise<FcVm> => {
      const vm = await this.spawnVmm(stateDir);
      try {
        await new FcApi(vm.apiSock).call(buildSnapshotLoadCall(vmstate, memFile));
        return vm;
      } catch (err) {
        await killAndWait(vm.proc);
        throw err;
      }
    };
    const vm = await this.withOneRetry(id, loadSnapshot, "snapshot load");

    this.vms.set(id, vm);
    try {
      await this.waitForAgent(vm);
    } catch (err) {
      this.vms.delete(id);
      await killAndWait(vm.proc);
      throw err;
    }
    // One-shot: guest state diverges the moment the VM resumes, so a second load
    // from these files would resurrect a stale past. Unlinking is safe — the VMM
    // maps the memory file privately (copy-on-write).
    for (const f of [vmstate, memFile]) rmQuiet(f);
  }

  /** A live VM can always be snapshot-paused (KVM snapshots have no OS gate). */
  canSnapshot(id: string): boolean {
    return this.vms.has(id);
  }

  /**
   * Fast-pause (B7): pause the vCPUs, write a Full Firecracker snapshot (device
   * state + guest RAM) into the sandbox's state dir, and tear the VMM down. The
   * next `start` resumes from it **without a kernel boot** — background
   * processes/servers come back live. Same contract as the VZ driver's
   * `snapshot()`: the guest fs is synced first, so if the later restore has to
   * fall back to a cold boot the workspace is still intact.
   */
  async snapshot(id: string): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`firecracker: sandbox ${id} is not running`);
    await this.exec(id, "sync", {}, () => {}).catch(() => {});
    const api = new FcApi(vm.apiSock);
    await api.call(FC_PAUSE_VM);
    await api.call(
      buildSnapshotCreateCall(join(vm.stateDir, "snapshot.vmstate"), join(vm.stateDir, "snapshot.mem")),
    );
    this.vms.delete(id);
    await killAndWait(vm.proc); // state saved; free the compute
    for (const s of [vm.apiSock, vm.vsockUds]) rmQuiet(s);
  }

  // --- templates + snapshot fork ---------------------------------------------

  /** Where a named template's snapshot + disks live. */
  private templateDir(name: string): string {
    return join(this.cfg.stateDir, "_templates", name);
  }

  /**
   * Capture a live sandbox as a reusable template.
   *
   * The guest is paused, a Full snapshot is written, and the snapshot plus the
   * disks it references are copied into the template dir with the embedded paths
   * rewritten to point there. The **source sandbox is then resumed from its own
   * snapshot**, so capturing is non-destructive: it keeps running with its
   * processes intact and the caller sees no pause.
   *
   * The template must never contain a live gateway token — the daemon mints a
   * per-sandbox token at create time and injects it through the agent, so the
   * snapshot only ever holds the source sandbox's own (revocable) token.
   */
  async createTemplate(opts: CreateTemplateOptions): Promise<TemplateInfo> {
    const vm = this.vms.get(opts.sourceId);
    if (!vm) throw new Error(`firecracker: sandbox ${opts.sourceId} is not running`);
    if (vm.net) {
      // The guest's NIC (TAP name, MAC, IP, default route) is baked into the
      // snapshot, so every clone would land on the source's TAP with the same
      // address. Refuse rather than hand out colliding clones.
      throw new Error(
        "firecracker: cannot capture a template from a networked sandbox " +
          "(the guest's NIC configuration is baked into the snapshot)",
      );
    }
    const srcVmstate = join(vm.stateDir, "snapshot.vmstate");
    const srcMem = join(vm.stateDir, "snapshot.mem");

    await this.exec(opts.sourceId, "sync", {}, () => {}).catch(() => {});
    const api = new FcApi(vm.apiSock);
    await api.call(FC_PAUSE_VM);
    await api.call(buildSnapshotCreateCall(srcVmstate, srcMem));
    this.vms.delete(opts.sourceId);
    await killAndWait(vm.proc);
    for (const s of [vm.apiSock, vm.vsockUds]) rmQuiet(s);

    const dir = this.templateDir(opts.name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    cloneFile(srcVmstate, join(dir, "snapshot.vmstate"));
    cloneFile(srcMem, join(dir, "snapshot.mem"));
    const disks: string[] = [];
    for (const disk of TEMPLATE_DISKS) {
      const src = join(vm.stateDir, disk);
      if (!existsSync(src)) continue;
      cloneFile(src, join(dir, disk));
      disks.push(disk);
    }
    // Point the template's copy at itself, so a fork only has to rewrite
    // templateDir → cloneDir (never the source sandbox's dir).
    writeFileSync(
      join(dir, "snapshot.vmstate"),
      rewriteSnapshotPaths(readFileSync(join(dir, "snapshot.vmstate"), "utf8"), vm.stateDir, dir),
    );
    const meta: FcTemplateMeta = {
      name: opts.name,
      image: opts.image,
      limits: opts.limits,
      createdAt: new Date().toISOString(),
      sourceSandboxId: opts.sourceId,
      disks,
      sourceDir: vm.stateDir,
    };
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    const sizeBytes = dirSize(dir);

    // Resume the source from its own snapshot — capturing must not disturb it.
    await this.resumeFromSnapshot(opts.sourceId, vm.stateDir, srcVmstate, srcMem);
    const resumed = this.vms.get(opts.sourceId);
    if (resumed && vm.net) resumed.net = vm.net; // keep the TAP teardown wired
    log.info("firecracker template captured", {
      template: opts.name,
      sandbox: opts.sourceId,
      sizeBytes,
    });
    return {
      name: meta.name,
      image: meta.image,
      limits: meta.limits,
      createdAt: meta.createdAt,
      sizeBytes,
      sourceSandboxId: meta.sourceSandboxId,
    };
  }

  /**
   * Bring a sandbox live by restoring a template into a fresh VMM — no kernel
   * boot, no setup, no clone. Each clone gets its own state dir, its own disks,
   * and a fresh guest identity (see {@link reseedGuest}).
   */
  async fork(opts: ForkOptions): Promise<void> {
    const id = opts.id;
    if (this.vms.has(id)) return;
    const dir = this.templateDir(opts.template);
    const meta = readTemplateMeta(dir); // fail before touching the state dir
    const stateDir = join(this.cfg.stateDir, id);
    mkdirSync(stateDir, { recursive: true });
    const { vmstate, memFile } = prepareForkClone(dir, stateDir);

    const loadSnapshot = async (): Promise<FcVm> => {
      const vm = await this.spawnVmm(stateDir, opts.cpuset);
      try {
        await new FcApi(vm.apiSock).call(buildSnapshotLoadCall(vmstate, memFile));
        return vm;
      } catch (err) {
        await killAndWait(vm.proc);
        throw err;
      }
    };
    const vm = await this.withOneRetry(id, loadSnapshot, "snapshot fork");
    this.vms.set(id, vm);
    try {
      await this.waitForAgent(vm);
      // One-shot, like a resume: the guest diverges the moment it runs, so a
      // later `start` must cold-boot rather than resurrect this stale past.
      for (const f of [vmstate, memFile]) rmQuiet(f);
      await this.reseedGuest(id, opts);
      if (opts.env && Object.keys(opts.env).length) {
        await this.withConn(id, (c) => c.setEnv(opts.env!));
      }
    } catch (err) {
      this.vms.delete(id);
      await killAndWait(vm.proc);
      throw err;
    }
    log.info("firecracker VM forked from template", {
      sandbox: id,
      template: opts.template,
      image: meta.image,
    });
  }

  /**
   * Give a restored clone a fresh identity. Clones share the template's RAM at
   * fork time, so without this every clone would report the same hostname and
   * machine-id and — worse — share the kernel CRNG state, making their random
   * numbers mutually predictable. The agent reseeds the CRNG, sets the hostname
   * and machine-id, and fixes the clock to the host's wall time.
   *
   * Protected so the host-agnostic check can stub the guest round-trip.
   */
  protected async reseedGuest(id: string, _opts: ForkOptions): Promise<void> {
    await this.withConn(id, (c) =>
      c.reseed({
        hostname: `hotcell-${id}`,
        machineId: randomUUID(),
        unixTime: Math.floor(Date.now() / 1000),
      }),
    );
  }

  /** Delete a template and its on-disk snapshot. Idempotent. */
  async deleteTemplate(name: string): Promise<void> {
    rmSync(this.templateDir(name), { recursive: true, force: true });
  }

  /** Firecracker can capture and restore snapshot templates. */
  supportsTemplates(): boolean {
    return true;
  }

  async stop(id: string): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) return;
    // Flush the guest fs so workspace writes survive the abrupt teardown.
    await this.exec(id, "sync", {}, () => {}).catch(() => {});
    this.vms.delete(id);
    await killAndWait(vm.proc); // tears down the microVM; workspace.img persists
    for (const s of [vm.apiSock, vm.vsockUds]) rmQuiet(s);
    if (vm.net) this.teardownTap(vm.net);
  }

  async destroy(id: string): Promise<void> {
    await this.stop(id);
    const canonical = join(this.cfg.stateDir, id);
    try {
      // An adopted sandbox's canonical dir is a symlink to its warm-pool slot:
      // remove the real slot dir first, then the link itself.
      if (lstatSync(canonical).isSymbolicLink()) {
        rmSync(readlinkSync(canonical), { recursive: true, force: true });
        unlinkSync(canonical);
      } else {
        rmSync(canonical, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  }

  // --- agent transport ------------------------------------------------------

  /** Open a fresh AgentConn to the guest over Firecracker's vsock UDS (CONNECT
   *  handshake → the live socket carries the agent wire protocol). */
  protected async openConn(id: string): Promise<AgentConn> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`firecracker: sandbox ${id} is not running`);
    const { socket, leftover } = await fcVsockConnect(vm.vsockUds, AGENT_VSOCK_PORT, 15000);
    return AgentConn.attach(socket, leftover, 15000);
  }

  // --- host probes ----------------------------------------------------------

  async ping(): Promise<void> {
    if (!existsSync("/dev/kvm")) {
      throw new Error(
        "The firecracker driver needs a Linux host with KVM at /dev/kvm (bare metal or a " +
          "nested-virtualization VM, e.g. GCE N2/C3), which isn't present here. " +
          "Switch drivers with 'hotcell setup' (or HOTCELL_DRIVER=container).",
      );
    }
    try {
      execFileSync(this.cfg.fcBin, ["--version"], { stdio: "ignore" });
    } catch (err) {
      throw new Error(
        `Can't run the firecracker binary at "${this.cfg.fcBin}" — install firecracker on PATH ` +
          `or set HOTCELL_FC_BIN, then run 'hotcell start' again. (underlying: ${(err as Error).message})`,
      );
    }
  }

  async hostInfo(): Promise<HostInfo> {
    // Prefer /proc on Linux; fall back to the os module elsewhere (e.g. building
    // on a Mac, where this driver can't actually boot but should still report).
    let memoryMb = Math.round(totalmem() / (1024 * 1024));
    try {
      const meminfo = readFileSync("/proc/meminfo", "utf8");
      const m = /MemTotal:\s+(\d+)\s+kB/.exec(meminfo);
      if (m) memoryMb = Math.round(Number(m[1]) / 1024);
    } catch {
      /* not Linux; use totalmem() */
    }
    return { memoryMb, cpus: osCpus().length };
  }
}

/** Remove a file, ignoring a missing one. */
function rmQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* not there */
  }
}

/** SIGKILL a VMM and wait until the process has actually exited, so the next
 *  spawn never overlaps the previous VM's kernel-side teardown. */
function killAndWait(proc: ChildProcess, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill("SIGKILL");
  });
}

/** Copy `src`→`dst`, preferring a CoW reflink (btrfs/xfs) and falling back to a
 *  plain sparse-aware copy. Gives each sandbox its own workspace disk cheaply. */
function cloneFile(src: string, dst: string): void {
  try {
    // `--reflink` is GNU-only; on other hosts this fails and we fall back.
    execFileSync("cp", ["--reflink=auto", src, dst], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    execFileSync("cp", [src, dst]);
  }
}

/** Hard-link `src`→`dst`, falling back to a copy across filesystems. Used for a
 *  template's memory file: Firecracker maps it copy-on-write, so every clone can
 *  share one inode and pay nothing for the fork. */
function linkOrClone(src: string, dst: string): void {
  try {
    linkSync(src, dst);
  } catch {
    cloneFile(src, dst);
  }
}

/** Total bytes of the regular files directly inside `dir` (template footprint). */
function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        total += statSync(join(dir, entry.name)).size;
      } catch {
        /* raced with a delete */
      }
    }
  } catch {
    /* not there */
  }
  return total;
}

/** Grow an ext4 image file to `gb` gigabytes (truncate + resize2fs). Used to
 *  give a writable per-sandbox rootfs room for apt/node installs. Needs
 *  e2fsprogs on the host. */
function growExt4(path: string, gb: number): void {
  execFileSync("truncate", ["-s", `${gb}G`, path]);
  execFileSync("bash", ["-lc", `e2fsck -fy ${path} >/dev/null 2>&1; resize2fs ${path} >/dev/null 2>&1`]);
}

/** Create a sparse file of `sizeBytes` if it doesn't exist (workspace disk). */
function ensureSparseFile(path: string, sizeBytes: number): void {
  if (existsSync(path)) return;
  const fd = openSync(path, "w");
  try {
    ftruncateSync(fd, sizeBytes);
  } finally {
    closeSync(fd);
  }
}

/** Resolve once `path` exists, polling, or reject after `timeoutMs`. */
async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${path}`);
}
