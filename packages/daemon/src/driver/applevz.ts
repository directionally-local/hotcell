import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AgentConn } from "./agent.js";
import { AgentDriver } from "./agent-driver.js";
import { VzImageCache } from "./vz-image.js";
import { createHash } from "node:crypto";
import type { CreateOptions, HostInfo, ResourceLimits } from "./types.js";
import { RUNNING_FROM_SOURCE } from "../config.js";
import { fetchVzGuest, fetchVzHelper } from "./vz-fetch.js";
import { redactSecrets } from "../audit.js";
import { log } from "../logger.js";

/** Config the driver factory hands the VZ driver (subset of the daemon config). */
export interface VzConfig {
  helperPath: string;
  kernel: string;
  rootfs: string;
  stateDir: string;
  diskGb: number;
  /** Cache dir for OCI→ext4 converted rootfs images + the blank workspace template. */
  imageCacheDir: string;
  /** Pre-boot this many microVMs for instant adopt (0 = off). */
  warmPool?: number;
  /** Image the warm pool pre-boots; a plain create of this image adopts a spare
   *  (default "base", the prebuilt Alpine rootfs). */
  poolImage?: string;
  /**
   * Resource shape the pool's spares boot with. Adoption requires the create's
   * resolved limits to EQUAL this shape (a looser match would hand out a VM
   * bigger than admission control charged for — VZ memorySize is fixed at boot).
   * Pass the daemon's default limits so plain creates stay pool-eligible.
   */
  poolLimits?: ResourceLimits;
  /**
   * Egress gateway port for the guest relay (0/unset = no relay). The guest gets
   * a loopback listener on this port whose connections tunnel over vsock (helper
   * listener) to `egressHost:egressPort` — the NIC-less guest's only way out.
   */
  egressPort?: number;
  /** Host the egress gateway listens on (default 127.0.0.1). */
  egressHost?: string;
}

/** Concurrent warm-pool spare boots: refill fast, but leave CPU for foreground creates. */
const FILL_CONCURRENCY = 4;

/** Live per-sandbox VM: the `sbx-vz serve` process + its relay socket + disk. */
interface VmState {
  helper: HelperProcess;
  socketPath: string;
  workspaceImg: string;
  stateDir: string;
}

/**
 * Apple Virtualization.framework microVM driver (macOS). Each sandbox is a real
 * VM: a long-lived signed `sbx-vz serve` helper boots it (rootfs + a persistent
 * `workspace.img` over virtio-blk) and relays a unix socket to the guest's vsock,
 * so the daemon's `AgentConn` speaks the agent wire protocol straight into the
 * guest — the same surface the container driver gets from `docker exec`.
 *
 * Implemented (M1–M5): create/stop/start/destroy lifecycle with workspace
 * persistence, exec, files, waitForPort, processes, terminal, preview bridge,
 * stats, and backup/restore. `watchFiles` (M3 inotify) is the remaining gap.
 */
export class AppleVzDriver extends AgentDriver {
  readonly name = "applevz";
  private vms = new Map<string, VmState>();
  private images: VzImageCache;

  // Warm pool: pre-booted spare base-image guests for instant adopt on create.
  private pool: VmState[] = [];
  private poolTarget: number;
  private poolSeq = 0;
  private inFlightFills = 0;
  private fillBackoffUntil = 0;
  private fillBackoffMs = 0; // doubles per consecutive boot failure, resets on success
  private readonly poolImage: string;
  private readonly poolLimits: ResourceLimits;
  private readonly poolDir: string;
  /** Short per-instance token namespacing pool relay sockets in /tmp — two
   *  driver instances (tests; a future multi-daemon host) must never share
   *  `pool-N` socket paths, or one instance's orphan cleanup unlinks the
   *  other's live relay. Derived from stateDir; kept short for sun_path. */
  private readonly poolTok: string;

  /**
   * Path to the helper binary actually used. Starts at the configured path (a
   * source checkout / explicit override) and is redirected to the fetched copy
   * in `~/.hotcell/vz/` by `ensureHelper()` when the configured one is absent.
   */
  private helperBin: string;
  private kernelPath: string;

  constructor(private readonly cfg: VzConfig) {
    super();
    // Decide where the VZ runtime lives. A full source checkout / prior fetch has
    // the helper + kernel + converter scripts next to the configured helper
    // (helpers/hotcell-vz/…); otherwise (the npm-install case) they're fetched into
    // the state dir on first use — `ensureHelper()` grabs the binary, `ensureGuest()`
    // the kernel + agent + scripts — and everything resolves under one writable dir.
    const useConfigured = existsSync(cfg.helperPath) && existsSync(cfg.kernel);
    const runtimeDir = useConfigured ? dirname(dirname(cfg.helperPath)) : cfg.stateDir;
    this.helperBin = useConfigured ? cfg.helperPath : join(cfg.stateDir, "hotcell-vz");
    this.kernelPath = useConfigured ? cfg.kernel : join(cfg.stateDir, "guest", "vmlinux-vz");
    this.images = new VzImageCache({
      vzDir: runtimeDir,
      cacheDir: cfg.imageCacheDir,
      // npm-install case: like the helper + kernel, the prebuilt rootfs (when the
      // release ships one) lands in the fetched guest dir, not node_modules.
      prebuiltRootfs: useConfigured ? cfg.rootfs : join(cfg.stateDir, "guest", "rootfs.img"),
    });
    this.poolTarget = Math.max(0, cfg.warmPool ?? 0);
    this.poolImage = cfg.poolImage ?? "base";
    this.poolLimits = cfg.poolLimits ?? {};
    this.poolDir = join(cfg.stateDir, "_pool");
    this.poolTok = createHash("sha1").update(cfg.stateDir).digest("hex").slice(0, 6);
    if (this.poolTarget > 0) {
      // Clear stale slots from a previous run (their helpers died with the daemon).
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
    opts.onProgress?.("starting");
    await this.launch(opts);
    if (opts.setup?.length) opts.onProgress?.("running setup");
    // Best-effort setup commands, mirroring the container driver (non-fatal).
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

  /** Bring a sandbox live: adopt a warm-pool guest when eligible (instant), else
   *  cold-boot a VM. Then apply the sandbox env. */
  private async launch(opts: CreateOptions): Promise<void> {
    const id = opts.id;
    if (this.vms.has(id)) return; // already running

    // Booting needs the helper + the guest runtime (kernel/agent/scripts); fetch
    // them on demand in the npm-install case before the first VM comes up. Surface
    // the (slow, one-time) downloads so `hotcell run` doesn't look stuck.
    if (!existsSync(this.helperBin)) opts.onProgress?.("fetching Apple VZ helper");
    await this.ensureHelper();
    if (!existsSync(this.kernelPath)) opts.onProgress?.("fetching Apple VZ runtime (kernel + agent)");
    await this.ensureGuest();

    const adopted = await this.tryClaimFromPool(opts);
    if (!adopted) {
      const stateDir = join(this.cfg.stateDir, id);
      // If a snapshot exists from a fast-pause, resume from it (RAM + device state
      // restored, no kernel boot) instead of cold-booting.
      const snapPath = join(stateDir, "snapshot.bin");
      const restoreFrom = existsSync(snapPath) ? snapPath : undefined;
      let vm: VmState;
      try {
        vm = await this.bootVm({
          id,
          stateDir,
          image: opts.image,
          socketPath: `/tmp/hc-${id}.sock`, // short, fits sun_path
          limits: opts.limits,
          restoreFrom,
          onProgress: opts.onProgress,
        });
      } catch (err) {
        if (restoreFrom) {
          // A snapshot that won't restore must never brick the sandbox: discard it
          // and cold-boot. The workspace disk is intact — only live RAM state is lost.
          log.warn("snapshot restore failed; discarding it and cold-booting", {
            sandbox: id,
            error: (err as Error).message,
          });
          try {
            unlinkSync(snapPath);
          } catch {
            /* ignore */
          }
          return this.launch(opts); // snapshot gone → cold boot this time
        }
        throw new Error(`applevz: VM start failed: ${(err as Error).message}`);
      }
      this.vms.set(id, vm);
      if (restoreFrom) {
        try {
          unlinkSync(snapPath); // single-use: the in-RAM state is now live
        } catch {
          /* ignore */
        }
      }
    }

    // Sandbox-level env: applied once on the shared agent so every exec inherits it.
    if (opts.env && Object.keys(opts.env).length) {
      await this.withConn(id, (c) => c.setEnv(opts.env!));
    }
    log.info("applevz VM up", { sandbox: id, warm: adopted });
  }

  /**
   * Boot a VM and wait for its in-guest agent, returning the live VmState. Shared
   * by the cold-launch path and the warm-pool filler. Does not touch `this.vms`
   * or apply sandbox env — the caller owns those.
   */
  private async bootVm(p: {
    id: string;
    stateDir: string;
    image: string;
    socketPath: string;
    limits?: CreateOptions["limits"];
    restoreFrom?: string;
    onProgress?: (phase: string) => void;
  }): Promise<VmState> {
    mkdirSync(p.stateDir, { recursive: true });
    // Resolve the rootfs for the image (sentinels → prebuilt base; else converted).
    const rootfs = await this.images.ensureRootfs(p.image, p.onProgress);

    // First boot only: give the VM its own workspace disk. Prefer cloning the blank
    // pre-formatted template (works for images without mkfs.ext4); else a sparse
    // file the guest formats itself.
    const workspaceImg = join(p.stateDir, "workspace.img");
    if (!existsSync(workspaceImg)) {
      let blank: string | null = null;
      try {
        blank = await this.images.ensureBlankWorkspace(this.cfg.diskGb, p.onProgress);
      } catch (err) {
        log.warn("blank workspace build failed; guest will format a sparse disk", {
          sandbox: p.id,
          error: (err as Error).message,
        });
      }
      if (blank) cloneFile(blank, workspaceImg);
      else ensureSparseFile(workspaceImg, this.cfg.diskGb * 1024 ** 3);
    }
    try {
      unlinkSync(p.socketPath);
    } catch {
      /* not there */
    }

    p.onProgress?.(p.restoreFrom ? "resuming microVM" : "booting microVM");
    const helper = new HelperProcess(this.helperBin, join(p.stateDir, "console.log"));
    const vm: VmState = { helper, socketPath: p.socketPath, workspaceImg, stateDir: p.stateDir };

    // Memory + CPU are hard VM caps (VZ memorySize/cpuCount). VZ needs an integer
    // vCPU count, so a fractional `cpus` rounds up. pidsLimit has no VM analogue —
    // it's enforced inside the guest via a cgroup the init sets up from the cmdline.
    const cpus = p.limits?.cpus ? Math.max(1, Math.ceil(p.limits.cpus)) : 2;
    const memMb = p.limits?.memoryMb && p.limits.memoryMb > 0 ? p.limits.memoryMb : 1024;
    const pidsMax = p.limits?.pidsLimit && p.limits.pidsLimit > 0 ? p.limits.pidsLimit : 0;
    try {
      await helper.rpc("start", {
        kernel: this.kernelPath,
        rootfs,
        workspace: workspaceImg,
        cpus,
        memMb,
        pidsMax,
        socketPath: p.socketPath,
        vsockPort: 1024,
        restoreFrom: p.restoreFrom,
        // Per-sandbox pinned machine identity (minted on first boot, reloaded
        // after): VZ refuses to restore saved state under a different (fresh,
        // randomized) VZGenericMachineIdentifier. Lives in the stateDir so a
        // warm-pool slot rename carries it along.
        machineIdPath: join(p.stateDir, "machine-id.bin"),
        // Guest egress relay: the helper listens on this vsock port and splices
        // each guest-initiated connection to the egress gateway.
        egressPort: this.cfg.egressPort ?? 0,
        egressTarget: this.cfg.egressPort
          ? `${this.cfg.egressHost ?? "127.0.0.1"}:${this.cfg.egressPort}`
          : "",
      });
    } catch (err) {
      helper.kill();
      throw err;
    }
    // The VM has started, but the guest agent needs a moment to boot + bind vsock.
    await this.waitForAgentSocket(p.socketPath);
    // Cold boots need the in-guest side of the egress relay started (after a
    // snapshot resume it's already alive in the restored RAM).
    if (this.cfg.egressPort && this.cfg.egressPort > 0) {
      const conn = await AgentConn.connect({ path: p.socketPath, timeoutMs: 5000 });
      try {
        await conn.egressListen(this.cfg.egressPort);
      } finally {
        conn.close();
      }
    }
    return vm;
  }

  /** Poll the relay until the in-guest agent answers (Hello), or time out. */
  private async waitForAgentSocket(socketPath: string, timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const conn = await AgentConn.connect({ path: socketPath, timeoutMs: 2000 });
        conn.close();
        return;
      } catch (err) {
        lastErr = err;
        await sleep(400);
      }
    }
    throw new Error(`applevz: agent never came up (${socketPath}): ${String((lastErr as Error)?.message ?? lastErr)}`);
  }

  // --- warm pool ------------------------------------------------------------

  /** Number of pre-booted spare guests ready to adopt. */
  poolSize(): number {
    return this.pool.length;
  }

  /** Pool footprint for admission control. */
  poolStats(): { spares: number; reservedMb: number } {
    // Charged at TARGET, not momentary fill: a spare below target is owed — its
    // replacement boots without re-admission — so the budget must stay reserved
    // across the adopt→refill window, the concurrency cap, and failure backoffs.
    // Per-spare charge = the shape's cap, else the boot-path default memMb.
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
   * pooled base image with default limits and no existing workspace. Renames the
   * spare's slot dir to the sandbox's canonical state dir (an APFS rename leaves
   * the running VM's open workspace fd valid), registers it, and replenishes the
   * pool. Returns true on adopt, false to fall through to a cold boot.
   */
  private async tryClaimFromPool(opts: CreateOptions): Promise<boolean> {
    if (this.poolTarget <= 0) return false;
    const canonical = join(this.cfg.stateDir, opts.id);
    const imageOk =
      opts.image === this.poolImage || (this.poolImage === "base" && opts.image === "alpine");
    const shapeOk = this.poolShapeMatches(opts.limits);
    const fresh = !existsSync(join(canonical, "workspace.img")); // a resume already has a workspace
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
    // Adopt: move the spare's slot dir to the canonical sandbox dir. The running
    // helper keeps its open fds (inode survives the rename), so the live VM is
    // unaffected; a later stop/start recomputes the canonical path and finds it.
    renameSync(spare.stateDir, canonical);
    this.vms.set(opts.id, {
      helper: spare.helper,
      socketPath: spare.socketPath,
      workspaceImg: join(canonical, "workspace.img"),
      stateDir: canonical,
    });
    this.fillPool(); // replenish in the background
    log.info("applevz adopted a warm-pool guest", { sandbox: opts.id });
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
      const vm = await this.bootVm({
        id: `pool-${n}`,
        stateDir: join(this.poolDir, `slot-${n}`),
        image: this.poolImage,
        socketPath: `/tmp/hcp-${this.poolTok}-${n}.sock`,
        limits: this.poolLimits,
      });
      if (this.poolTarget <= 0) {
        // Drained while booting: destroy the orphan instead of leaking it.
        vm.helper.kill();
        try {
          unlinkSync(vm.socketPath);
        } catch {
          /* ignore */
        }
        try {
          rmSync(vm.stateDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        return;
      }
      this.pool.push(vm);
      log.info("warm pool: spare guest ready", { size: this.pool.length, target: this.poolTarget });
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

  /** Tear down all spare guests (e.g. on shutdown). Idempotent. */
  async drainPool(): Promise<void> {
    this.poolTarget = 0;
    const spares = this.pool.splice(0);
    for (const g of spares) {
      g.helper.kill();
      try {
        unlinkSync(g.socketPath);
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(this.poolDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  async stop(id: string): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) return;
    // Flush the guest filesystem to the workspace disk before the abrupt VM
    // teardown — otherwise writes still in the guest page cache are lost, and the
    // workspace wouldn't survive stop/start. Best-effort.
    await this.exec(id, "sync", {}, () => {}).catch(() => {});
    vm.helper.kill(); // killing the helper tears down the VM; workspace.img persists
    this.vms.delete(id);
    try {
      unlinkSync(vm.socketPath);
    } catch {
      /* ignore */
    }
  }

  /** VZ save/restore needs macOS 14+ (Darwin 23+) and a live VM. */
  canSnapshot(id: string): boolean {
    return this.vms.has(id) && Number(release().split(".")[0]) >= 23;
  }

  /**
   * Fast-pause: save the live VM's full state (RAM + virtual devices) to disk and
   * tear the helper down, so the next `start` resumes **without a kernel boot**
   * (VZ `saveMachineStateTo`/`restoreMachineStateFrom`, macOS 14+). The workspace
   * disk + the snapshot file are all that's needed to resume; unlike `stop`, no
   * `sync` is needed (the snapshot is a consistent point-in-time including the
   * guest page cache). Background processes/servers come back live on resume.
   */
  async snapshot(id: string): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`applevz: sandbox ${id} is not running`);
    // Flush the guest fs first so workspace writes are durable on disk even if a
    // later resume can't restore the snapshot and has to cold-boot (a true restore
    // would carry the page cache in the saved RAM state, so this only helps the
    // fallback — it never hurts).
    await this.exec(id, "sync", {}, () => {}).catch(() => {});
    const snapPath = join(vm.stateDir, "snapshot.bin");
    await vm.helper.rpc("snapshot", { path: snapPath });
    vm.helper.kill(); // state saved; free the compute
    this.vms.delete(id);
    try {
      unlinkSync(vm.socketPath);
    } catch {
      /* ignore */
    }
  }

  async destroy(id: string): Promise<void> {
    await this.stop(id);
    try {
      rmSync(join(this.cfg.stateDir, id), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  // --- agent transport ------------------------------------------------------

  /** Open a fresh AgentConn to the sandbox's relay socket (the signed VZ helper
   *  relays the guest vsock to this unix socket). Backs every agent-served op. */
  protected async openConn(id: string): Promise<AgentConn> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`applevz: sandbox ${id} is not running`);
    return AgentConn.connect({ path: vm.socketPath, timeoutMs: 15000 });
  }

  // --- host probes (one-shot helper, no VM) ---------------------------------

  /**
   * Make sure a runnable helper exists. A source checkout / explicit
   * `HOTCELL_VZ_HELPER_PATH` is used as-is; otherwise (the npm-install case) fetch
   * the ad-hoc-signed helper from the matching GitHub release into `~/.hotcell/vz/`.
   */
  private async ensureHelper(): Promise<void> {
    if (existsSync(this.helperBin)) return;
    try {
      this.helperBin = await fetchVzHelper(this.cfg.stateDir);
      log.info("fetched the Apple VZ helper", { path: this.helperBin });
    } catch (err) {
      if (RUNNING_FROM_SOURCE) {
        throw new Error(
          `The Apple VZ helper (hotcell-vz) isn't built yet. Build it with 'npm run build:vz', ` +
            `then run 'hotcell start' again. (${(err as Error).message})`,
        );
      }
      throw new Error(
        `Couldn't get the Apple VZ helper (${(err as Error).message}). Check your connection and retry, ` +
          `or use Docker for now: run 'hotcell setup' and choose containers (or set HOTCELL_DRIVER=container).`,
      );
    }
  }

  /**
   * Make sure the guest runtime (kernel + agent + converter scripts) is present,
   * fetching it into the state dir on first `create` in the npm-install case. The
   * helper alone lets the daemon start + probe; booting a VM needs these too.
   */
  private async ensureGuest(): Promise<void> {
    if (existsSync(this.kernelPath)) return;
    try {
      await fetchVzGuest(this.cfg.stateDir);
      log.info("fetched the Apple VZ guest runtime (kernel + agent + converter)", {
        dir: this.cfg.stateDir,
      });
    } catch (err) {
      if (RUNNING_FROM_SOURCE) {
        throw new Error(
          `The Apple VZ guest runtime (kernel + agent) isn't built yet. Build it with ` +
            `'npm run build:vz && bash helpers/hotcell-vz/build-kernel.sh && npm run build:agent'. ` +
            `(${(err as Error).message})`,
        );
      }
      throw new Error(
        `Couldn't get the Apple VZ guest runtime (${(err as Error).message}). Check your connection ` +
          `and retry, or use Docker for now (HOTCELL_DRIVER=container).`,
      );
    }
  }

  async ping(): Promise<void> {
    await this.ensureHelper();
    let res: HelperOneShot;
    try {
      res = await this.oneShot("probe");
    } catch (err) {
      // Helper is present but wouldn't run — e.g. macOS blocked a downloaded
      // binary, or the build is broken. Surface the real error for diagnosis.
      throw new Error(
        `The Apple VZ helper is present but wouldn't run: ${(err as Error).message}. ` +
          (RUNNING_FROM_SOURCE
            ? `Try rebuilding it with 'npm run build:vz'.`
            : `Please report this, or use Docker: run 'hotcell setup' and choose containers.`),
      );
    }
    const r = res.result as { available?: boolean; reason?: string } | undefined;
    if (!res.ok || !r?.available) {
      throw new Error(
        `Apple Virtualization isn't available on this machine — the applevz driver needs macOS on ` +
          `Apple Silicon. Switch drivers with 'hotcell setup' (or HOTCELL_DRIVER=container). ` +
          `(reason: ${r?.reason || res.error || "unknown"})`,
      );
    }
  }

  async hostInfo(): Promise<HostInfo> {
    const res = await this.oneShot("hostInfo");
    if (!res.ok) throw new Error(`applevz hostInfo failed: ${res.error ?? "unknown"}`);
    const r = res.result as { memoryMb?: number; cpus?: number };
    return { memoryMb: Number(r?.memoryMb) || 0, cpus: Number(r?.cpus) || 0 };
  }

  /** One-shot stdio RPC to a throwaway helper process (probe/hostInfo). */
  private oneShot(method: string): Promise<HelperOneShot> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.helperBin, [], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", reject);
      child.on("close", () => {
        const line = out.split("\n").find((l) => l.trim());
        if (!line) return reject(new Error(err.trim() || "no response from sbx-vz"));
        try {
          resolve(JSON.parse(line) as HelperOneShot);
        } catch {
          reject(new Error(`bad sbx-vz response: ${line}`));
        }
      });
      child.stdin.write(JSON.stringify({ id: 1, method }) + "\n");
      child.stdin.end();
    });
  }
}

interface HelperOneShot {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Long-lived `sbx-vz serve` process for one sandbox. Drives it over stdio
 * JSON-RPC (`start`/`stop`); the guest console + helper logs go to a console
 * file. RPC replies are matched by id; stdout carries only JSON replies.
 */
class HelperProcess {
  readonly proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = "";

  constructor(helperPath: string, consoleLogPath: string) {
    this.proc = spawn(helperPath, ["serve"], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", (d: Buffer) => this.feed(d.toString()));
    this.proc.stderr.pipe(createWriteStream(consoleLogPath, { flags: "a" }));
    const fail = (e: Error) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    };
    this.proc.on("exit", () => fail(new Error("sbx-vz helper exited")));
    this.proc.on("error", (e) => fail(e));
  }

  rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  private feed(s: string): void {
    this.buf += s;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m: { id?: number; ok?: boolean; result?: unknown; error?: string };
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      const p = m.id != null ? this.pending.get(m.id) : undefined;
      if (!p || m.id == null) continue;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error || "sbx-vz helper error"));
    }
  }

  kill(): void {
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Copy `src` to `dst`, preferring an APFS copy-on-write clone (instant, shares
 *  blocks until written) and falling back to a sparse-preserving `cp`. Used to
 *  give each sandbox its own workspace disk from the blank template cheaply. */
function cloneFile(src: string, dst: string): void {
  try {
    execFileSync("cp", ["-c", src, dst]); // APFS clonefile()
  } catch {
    execFileSync("cp", [src, dst]); // non-APFS: plain copy (still sparse-aware on macOS)
  }
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
