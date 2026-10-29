import type { Config } from "../config.js";
import type { SandboxStore } from "../store.js";
import type {
  ExecEvent,
  ExecOptions,
  FileChangeEvent,
  FileInfo,
  ListFilesOptions,
  MkdirOptions,
  ReadFileOptions,
  StartProcessOptions,
  WaitForPortOptions,
  WatchOptions,
  WriteFileOptions,
} from "../types.js";
import { createNamedDriver } from "./index.js";
import type {
  CreateOptions,
  CreateTemplateOptions,
  Driver,
  ForkOptions,
  HostInfo,
  ProcessLiveness,
  SandboxStats,
  StartProcessResult,
  TcpBridge,
  TemplateInfo,
  TerminalOptions,
  TerminalSession,
} from "./types.js";

/**
 * Per-sandbox driver router. Implements the `Driver` surface but, instead of
 * doing the work itself, dispatches each call to the runtime driver that backs
 * the addressed sandbox — so a single daemon can run container sandboxes and
 * Apple VZ microVM sandboxes side by side ("swap the isolation tier per sandbox,
 * change nothing else"). Every existing `driver.<op>(id, …)` call site keeps
 * working unchanged; the routing happens here.
 *
 * The sandbox→driver mapping is the record's `driver` field (set at create from
 * the request, persisted in the store). `create`/`start` carry the choice on
 * their `CreateOptions`; id-addressed ops read it back from the store. An unset
 * or unknown value falls back to the daemon default driver. Driver instances are
 * built lazily by name and cached, so an unused driver is never constructed.
 */
export class DriverRouter implements Driver {
  readonly name: string;
  private instances = new Map<string, Driver>();

  constructor(
    private readonly config: Config,
    private readonly store: SandboxStore,
    private readonly defaultName: string,
    private readonly createDriver: (name: string, config: Config) => Driver = createNamedDriver,
  ) {
    this.name = defaultName;
  }

  /** Get (constructing + caching on first use) the driver instance for a name. */
  private instance(name: string | undefined): Driver {
    const key = name || this.defaultName;
    let d = this.instances.get(key);
    if (!d) {
      d = this.createDriver(key, this.config);
      this.instances.set(key, d);
    }
    return d;
  }

  /** The driver backing an existing sandbox (from its record), or the default. */
  private forId(id: string): Driver {
    return this.instance(this.store.get(id)?.driver);
  }

  /** The driver chosen for a create/start (opts wins, then the record, then default). */
  private forOpts(opts: CreateOptions): Driver {
    return this.instance(opts.driver ?? this.store.get(opts.id)?.driver);
  }

  // --- lifecycle (choice carried on opts) -----------------------------------

  create(opts: CreateOptions): Promise<void> {
    return this.forOpts(opts).create(opts);
  }
  start(opts: CreateOptions): Promise<void> {
    return this.forOpts(opts).start(opts);
  }
  stop(id: string): Promise<void> {
    return this.forId(id).stop(id);
  }
  /** Fast-pause via the backing driver, or `stop` when it doesn't support
   *  snapshots — so callers can always call `snapshot` through the router and
   *  get the strongest pause the sandbox's isolation tier offers. */
  snapshot(id: string): Promise<void> {
    const d = this.forId(id);
    return typeof d.snapshot === "function" ? d.snapshot(id) : d.stop(id);
  }
  /** Whether the backing driver can memory-snapshot this sandbox right now. */
  canSnapshot(id: string): boolean {
    const d = this.forId(id);
    return typeof d.snapshot === "function" && (d.canSnapshot ? d.canSnapshot(id) : true);
  }

  /** Capture a template from a live sandbox on that sandbox's own driver. */
  createTemplate(opts: CreateTemplateOptions): Promise<TemplateInfo> {
    const d = this.forId(opts.sourceId);
    if (typeof d.createTemplate !== "function") {
      throw new Error(`driver ${d.name} cannot capture templates`);
    }
    return d.createTemplate(opts);
  }

  /** Restore a template into a fresh sandbox on the template's driver. */
  fork(opts: ForkOptions): Promise<void> {
    const d = this.forOpts(opts);
    if (typeof d.fork !== "function") {
      throw new Error(`driver ${d.name} cannot fork templates`);
    }
    return d.fork(opts);
  }

  /** Delete a template on the driver that owns it. */
  deleteTemplate(name: string, driverName?: string): Promise<void> {
    const d = this.instance(driverName);
    if (typeof d.deleteTemplate !== "function") return Promise.resolve();
    return d.deleteTemplate(name);
  }

  /** Whether the named driver (default: the daemon default) can fork templates. */
  supportsTemplates(driverName?: string): boolean {
    const d = this.instance(driverName);
    return typeof d.fork === "function" && typeof d.createTemplate === "function";
  }
  /** Startup egress reconcile on the default driver (where enforcement lives). */
  async initEgress(): Promise<void> {
    const d = this.instance(this.defaultName);
    if (typeof d.initEgress === "function") await d.initEgress();
  }
  /** Resolve an enforced-container source address to its persisted sandbox identity. */
  async resolveEgressSourceIp(ip: string): Promise<{ sandboxId: string; driver: string } | undefined> {
    const d = this.instance("container");
    const sandboxId = await d.sandboxIdForEgressIp?.(ip);
    return sandboxId ? { sandboxId, driver: d.name } : undefined;
  }
  destroy(id: string): Promise<void> {
    return this.forId(id).destroy(id);
  }

  // --- id-addressed ops (driver resolved from the record) -------------------

  exec(
    id: string,
    command: string,
    opts: ExecOptions,
    onEvent: (e: ExecEvent) => void,
  ): Promise<number> {
    return this.forId(id).exec(id, command, opts, onEvent);
  }
  writeFile(id: string, opts: WriteFileOptions): Promise<void> {
    return this.forId(id).writeFile(id, opts);
  }
  readFile(id: string, opts: ReadFileOptions): Promise<string> {
    return this.forId(id).readFile(id, opts);
  }
  mkdir(id: string, opts: MkdirOptions): Promise<void> {
    return this.forId(id).mkdir(id, opts);
  }
  listFiles(id: string, opts: ListFilesOptions): Promise<FileInfo[]> {
    return this.forId(id).listFiles(id, opts);
  }
  watchFiles(
    id: string,
    path: string,
    opts: WatchOptions & { signal: AbortSignal },
    onEvent: (e: FileChangeEvent) => void,
  ): Promise<void> {
    return this.forId(id).watchFiles(id, path, opts, onEvent);
  }
  startProcess(
    id: string,
    procId: string,
    command: string,
    opts: StartProcessOptions,
  ): Promise<StartProcessResult> {
    return this.forId(id).startProcess(id, procId, command, opts);
  }
  listProcesses(
    id: string,
    procs: Array<{ procId: string; pid: number }>,
  ): Promise<ProcessLiveness[]> {
    return this.forId(id).listProcesses(id, procs);
  }
  killProcess(id: string, pid: number, signal?: string): Promise<void> {
    return this.forId(id).killProcess(id, pid, signal);
  }
  streamProcessLogs(
    id: string,
    logPath: string,
    opts: { follow: boolean; signal: AbortSignal },
    onData: (chunk: string) => void,
  ): Promise<void> {
    return this.forId(id).streamProcessLogs(id, logPath, opts, onData);
  }
  waitForPort(id: string, port: number, opts: WaitForPortOptions): Promise<boolean> {
    return this.forId(id).waitForPort(id, port, opts);
  }
  openTcpBridge(id: string, port: number, host: string): Promise<TcpBridge> {
    return this.forId(id).openTcpBridge(id, port, host);
  }
  openTerminal(id: string, opts: TerminalOptions): Promise<TerminalSession> {
    return this.forId(id).openTerminal(id, opts);
  }
  createBackup(id: string, tarPath: string): Promise<{ bytes: number }> {
    return this.forId(id).createBackup(id, tarPath);
  }
  restoreBackup(id: string, tarPath: string): Promise<void> {
    return this.forId(id).restoreBackup(id, tarPath);
  }
  stats(id: string): Promise<SandboxStats> {
    return this.forId(id).stats(id);
  }

  // --- host-level (default driver) ------------------------------------------

  /** Ping the default driver — the daemon's fail-fast startup check. Other
   *  drivers are validated lazily when a sandbox first selects them. */
  ping(): Promise<void> {
    return this.instance(this.defaultName).ping();
  }
  /**
   * Host capacity for admission control. All drivers describe the same physical
   * host, but each sees it differently — Docker Desktop on macOS reports its own
   * VM's memory, not the Mac's — so ask every instantiated driver and take the
   * most complete view (max). Committed-memory accounting is already
   * driver-agnostic (it sums per-sandbox caps from the store).
   */
  async hostInfo(): Promise<HostInfo> {
    const drivers = new Set<Driver>([this.instance(this.defaultName), ...this.instances.values()]);
    let best: HostInfo = { memoryMb: 0, cpus: 0 };
    for (const d of drivers) {
      try {
        const h = await d.hostInfo();
        best = { memoryMb: Math.max(best.memoryMb, h.memoryMb), cpus: Math.max(best.cpus, h.cpus) };
      } catch {
        /* an unavailable driver (e.g. Docker down) shouldn't break capacity */
      }
    }
    if (best.memoryMb === 0) return this.instance(this.defaultName).hostInfo();
    return best;
  }

  /** Combined warm-pool footprint across every instantiated driver. */
  poolStats(): { spares: number; reservedMb: number } {
    let spares = 0;
    let reservedMb = 0;
    for (const d of new Set<Driver>(this.instances.values())) {
      const stats = d.poolStats?.();
      if (stats) {
        spares += stats.spares;
        reservedMb += stats.reservedMb;
      }
    }
    return { spares, reservedMb };
  }

  /** Best-effort teardown of any driver-held background resources (e.g. the VZ
   *  warm pool's pre-booted spare VMs) on daemon shutdown. */
  async shutdown(): Promise<void> {
    for (const d of this.instances.values()) {
      const drain = (d as { drainPool?: () => Promise<void> }).drainPool;
      if (typeof drain === "function") await drain.call(d).catch(() => {});
    }
  }
}
