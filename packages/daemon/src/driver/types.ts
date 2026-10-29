import type {
  ExecEvent,
  ExecOptions,
  FileChangeEvent,
  FileInfo,
  ListFilesOptions,
  MkdirOptions,
  ReadFileOptions,
  ResourceLimits,
  StartProcessOptions,
  WaitForPortOptions,
  WatchOptions,
  WriteFileOptions,
} from "../types.js";

export type { ResourceLimits } from "../types.js";

/** A live bidirectional byte stream bridged to a port inside a sandbox. */
export interface TcpBridge {
  /** Raw duplex carrying bytes to/from the in-container TCP relay. */
  stream: NodeJS.ReadWriteStream;
  /** Tear down the bridge and the in-container relay process. */
  close(): void;
}

/** Options for opening an interactive terminal (PTY) inside a sandbox. */
export interface TerminalOptions {
  /** Initial terminal width in columns. */
  cols?: number;
  /** Initial terminal height in rows. */
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * A live interactive shell (PTY) inside a sandbox. `stream` is a raw duplex:
 * write bytes to send keystrokes to the shell's stdin, read bytes to receive its
 * terminal output (already TTY-cooked, no Docker stream framing). This is the
 * interactive-exec primitive the in-sandbox agent (Phase 3) and the dashboard
 * terminal both build on.
 */
export interface TerminalSession {
  stream: NodeJS.ReadWriteStream;
  /** Inform the PTY of a new client window size. */
  resize(cols: number, rows: number): void;
  /** Tear down the shell and its exec. */
  close(): void;
}

/** Result of launching a background process. */
export interface StartProcessResult {
  procId: string;
  pid: number;
  logPath: string;
}

/** Liveness view of a tracked background process. */
export interface ProcessLiveness {
  procId: string;
  pid: number;
  running: boolean;
}

/** A point-in-time resource snapshot for a running sandbox. */
export interface SandboxStats {
  /** Instantaneous CPU usage as a percent of one core (can exceed 100). */
  cpuPercent: number;
  /** Cumulative CPU time the container has consumed, in nanoseconds (resets on
   * container recreation). The cost meter integrates the delta of this. */
  cpuTotalUsageNs: number;
  /** Number of CPUs visible to the container (CPU% is over all of them). */
  onlineCpus: number;
  /** Resident memory in bytes (page cache excluded where the runtime reports it). */
  memBytes: number;
  /** Memory limit in bytes (0 if unlimited/unknown). */
  memLimitBytes: number;
  /** Cumulative network bytes received across all interfaces. */
  netRxBytes: number;
  /** Cumulative network bytes transmitted across all interfaces. */
  netTxBytes: number;
  /** Number of processes/threads in the container. */
  pids: number;
  /** ISO timestamp the snapshot was taken. */
  sampledAt: string;
}

export interface CreateOptions {
  id: string;
  image: string;
  /**
   * Runtime driver to back this sandbox (per-sandbox isolation selection). The
   * `DriverRouter` reads it to dispatch `create`/`start`; later id-addressed ops
   * resolve the driver from the sandbox record. Empty → the daemon default.
   */
  driver?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  /**
   * Back `/workspace` with a named volume so files outlive the container. With
   * persistence the container is cattle: `stop` removes it, `start` recreates it,
   * and the workspace survives. Defaults to true.
   */
  persist?: boolean;
  /**
   * Ordered shell commands run once, after the container starts at create time
   * (e.g. `npm i kimiflare`). Best-effort: a non-zero exit is logged, not fatal.
   * Not re-run on resume — with persistence the workspace already has the result.
   */
  setup?: string[];
  /**
   * Git repository URL cloned into `/workspace` at create time (before `setup`),
   * so an agent comes up with the code in place. Private repos: embed a token in
   * the URL (`https://<token>@github.com/owner/repo.git`). A clone failure fails
   * create (unlike best-effort `setup`).
   */
  repo?: string;
  /** Branch/tag to check out when cloning `repo` (default: the repo's default branch). */
  repoRef?: string;
  /** Hard CPU/memory/PID caps for the sandbox (resolved effective values). */
  limits?: ResourceLimits;
  /**
   * Opt-in outbound networking for a microVM sandbox (Firecracker): give the
   * guest a real NAT'd NIC instead of the default no-network-device posture.
   * For trusted workloads that need general internet (apt/git/pip/benchmarks).
   * Ignored by the container driver (containers are networked already).
   */
  networked?: boolean;
  /**
   * Give a microVM sandbox a private, writable rootfs (cloned + grown from the
   * shared image) WITHOUT implying a NIC. `networked: true` already does this;
   * `writableRootfs: true` grants the same disk posture to a contained sandbox —
   * no network device, egress via the vsock gateway only — so workloads that
   * write to `/` (apt, node into /opt, …) still run in the default-deny posture.
   * Ignored by the container driver (its filesystem is already writable).
   */
  writableRootfs?: boolean;
  /**
   * Host-core pinning for a microVM sandbox (Firecracker): a `taskset`-style CPU
   * list (e.g. `"0-7"`) the firecracker process — and thus its vCPU threads — is
   * constrained to. Used to keep a guest on a single CCD / shared L3 for stable,
   * disclosed benchmark topology. Ignored by the container driver.
   */
  cpuset?: string;
  /**
   * In-process callback invoked as create advances phases ("launching container",
   * "cloning repo", "running setup"). Feeds `statusReason` on a `creating`
   * record so clients polling a detached create see where it is. Optional;
   * drivers may skip phases they don't have. Never serialized.
   */
  onProgress?: (phase: string) => void;
}

/**
 * A captured microVM template: a paused guest snapshot (RAM + device state) plus
 * the disks it was taken with, stored on the host so it can be restored into
 * many fresh VMMs. Only microVM drivers that support snapshot restore can
 * produce one.
 */
export interface TemplateInfo {
  /** Stable, URL-safe name; also the on-disk directory name. */
  name: string;
  /** Image the template was captured from (a fork inherits it). */
  image: string;
  /** Resource shape the snapshot was taken at — a fork must match it exactly. */
  limits: ResourceLimits;
  /** ISO timestamp the template was captured. */
  createdAt: string;
  /** Bytes the template occupies on the host (snapshot + disks). */
  sizeBytes: number;
  /** Sandbox the template was captured from (provenance only). */
  sourceSandboxId?: string;
}

/** Inputs for capturing a template from a live sandbox. */
export interface CreateTemplateOptions {
  /** Name to store the template under (the daemon validates the shape). */
  name: string;
  /** Running sandbox to capture. It is resumed before this resolves. */
  sourceId: string;
  /** Image the source sandbox was created from (a fork inherits it). */
  image: string;
  /** Resolved resource shape of the source sandbox (a fork must match it). */
  limits: ResourceLimits;
}

/**
 * A create that restores a template instead of booting a kernel. The workspace,
 * installed tooling and any running processes come from the snapshot, so
 * `repo`/`setup`/`branch` are not applied — the daemon rejects them up front.
 */
export interface ForkOptions extends CreateOptions {
  /** Template to restore from. */
  template: string;
}

/**
 * Runtime-driver interface — the core abstraction of sbx.
 *
 * Phase 0 ships the `container` driver (Docker Engine API). Future drivers
 * (`firecracker` on Linux, `applevz` on macOS) implement this same surface so
 * the daemon, SDK, and CLI are unchanged when you swap isolation tiers.
 *
 * Drivers are addressed by the public sandbox `id`; they derive their own
 * backing-resource name from it and stay otherwise stateless.
 */
export interface Driver {
  readonly name: string;

  /** Provision and start a sandbox (creating its persistent volume if needed). */
  create(opts: CreateOptions): Promise<void>;

  /**
   * Stop a sandbox, freeing its compute. With persistence the container is
   * removed but its workspace volume is kept, so `start` can recreate it with
   * the data intact. In-container processes do not survive a stop.
   */
  stop(id: string): Promise<void>;

  /**
   * (Re)create and start a sandbox's container, reattaching its persistent
   * volume. Used to resume a stopped sandbox; the workspace is preserved.
   */
  start(opts: CreateOptions): Promise<void>;

  /**
   * Optional fast-pause: save the sandbox's full live state (guest RAM + device
   * state) to disk and free its compute, such that the next `start` resumes
   * **without a kernel boot** — background processes/servers come back live.
   * Only microVM drivers can implement this; callers must feature-detect
   * (`typeof driver.snapshot === "function"`) and fall back to `stop`, whose
   * contract (workspace survives, processes don't) is the lowest common
   * denominator. Implementations must sync the guest fs first so a restore
   * failure can safely degrade to a cold boot with the workspace intact.
   */
  snapshot?(id: string): Promise<void>;

  /**
   * Whether `snapshot` can fast-pause this sandbox *right now* (VM live, host
   * OS supports save/restore). Callers use this to pick pause semantics up
   * front — e.g. the idle reaper only pauses a sandbox with running background
   * processes when they'll survive the resume.
   */
  canSnapshot?(id: string): boolean;

  /**
   * Optional: capture a live sandbox as a reusable template (a paused guest
   * snapshot + its disks). The source sandbox is resumed before this resolves,
   * so capturing does not disturb it. Only drivers that can restore a snapshot
   * into a fresh VMM implement this.
   */
  createTemplate?(opts: CreateTemplateOptions): Promise<TemplateInfo>;

  /**
   * Optional: bring a sandbox live by restoring a template into a fresh VMM
   * instead of booting a kernel — the fast path behind `hotcell create
   * --template`. Implementations must give each clone a fresh identity
   * (hostname, machine-id, CRNG, clock) since clones share the template's RAM
   * contents at fork time.
   */
  fork?(opts: ForkOptions): Promise<void>;

  /**
   * Optional: delete a template and its on-disk snapshot. The router takes an
   * optional driver name to pick which driver's template store to clear;
   * concrete drivers ignore it.
   */
  deleteTemplate?(name: string, driverName?: string): Promise<void>;

  /**
   * Whether this driver can capture and restore snapshot templates. The router
   * takes an optional driver name so callers can ask about a driver other than
   * the one backing a sandbox (e.g. the driver a template was captured on).
   */
  supportsTemplates?(driverName?: string): boolean;

  /**
   * Optional startup hook: reconcile any host-level egress state (e.g. the
   * enforcement bridge network) so a collision fails fast at boot with an
   * actionable message rather than as an error on the first sandbox create.
   */
  initEgress?(): Promise<void>;

  /** Resolve a source IP on the container egress bridge to its sandbox record. */
  sandboxIdForEgressIp?(ip: string): Promise<string | undefined>;

  /**
   * Run a command inside the sandbox, streaming output via `onEvent`.
   * Resolves with the process exit code.
   */
  exec(
    id: string,
    command: string,
    opts: ExecOptions,
    onEvent: (e: ExecEvent) => void,
  ): Promise<number>;

  /** Write a file inside the sandbox. */
  writeFile(id: string, opts: WriteFileOptions): Promise<void>;

  /** Read a file from the sandbox, returning its UTF-8 contents. */
  readFile(id: string, opts: ReadFileOptions): Promise<string>;

  /** Create a directory inside the sandbox. */
  mkdir(id: string, opts: MkdirOptions): Promise<void>;

  /** List files and directories at the given path. */
  listFiles(id: string, opts: ListFilesOptions): Promise<FileInfo[]>;

  /**
   * Watch a path (recursively) for file changes, invoking `onEvent` per change
   * until `opts.signal` aborts. Resolves when watching stops.
   */
  watchFiles(
    id: string,
    path: string,
    opts: WatchOptions & { signal: AbortSignal },
    onEvent: (e: FileChangeEvent) => void,
  ): Promise<void>;

  /**
   * Launch a detached background process. `procId` is daemon-supplied so the
   * in-container logfile is deterministic. Resolves once the process is spawned.
   */
  startProcess(
    id: string,
    procId: string,
    command: string,
    opts: StartProcessOptions,
  ): Promise<StartProcessResult>;

  /** Report liveness for the given in-container PIDs. */
  listProcesses(
    id: string,
    procs: Array<{ procId: string; pid: number }>,
  ): Promise<ProcessLiveness[]>;

  /** Send a signal to a process group (default TERM). */
  killProcess(id: string, pid: number, signal?: string): Promise<void>;

  /** Stream a process logfile to `onData`; `follow` tails it until aborted. */
  streamProcessLogs(
    id: string,
    logPath: string,
    opts: { follow: boolean; signal: AbortSignal },
    onData: (chunk: string) => void,
  ): Promise<void>;

  /** Block until a TCP port is listening inside the sandbox, or timeout. */
  waitForPort(id: string, port: number, opts: WaitForPortOptions): Promise<boolean>;

  /**
   * Open a raw bidirectional byte bridge to `host:port` inside the sandbox.
   * Used by the preview-URL proxy; goes through the Docker socket so it works
   * even where container IPs are unreachable from the host (macOS Docker Desktop).
   */
  openTcpBridge(id: string, port: number, host: string): Promise<TcpBridge>;

  /**
   * Open an interactive shell (PTY) inside the sandbox. Returns a duplex byte
   * stream (write = stdin, read = terminal output) plus resize/close controls.
   * Backs the dashboard's live terminal over WebSocket. The sandbox must be live.
   */
  openTerminal(id: string, opts: TerminalOptions): Promise<TerminalSession>;

  /**
   * Archive the sandbox's `/workspace` to a tar file at `tarPath` on the daemon
   * host. Returns the number of bytes written. The sandbox must be running.
   */
  createBackup(id: string, tarPath: string): Promise<{ bytes: number }>;

  /**
   * Replace the sandbox's `/workspace` with the contents of the tar at
   * `tarPath`. Existing workspace contents are cleared first. The sandbox must
   * be running; the backup may originate from a different sandbox.
   */
  restoreBackup(id: string, tarPath: string): Promise<void>;

  /**
   * Permanently destroy the sandbox and free its resources, including its
   * persistent workspace volume. This is irreversible — use `stop` to pause.
   */
  destroy(id: string): Promise<void>;

  /**
   * Snapshot the sandbox's live resource usage (CPU, memory, network, pids).
   * The sandbox must be running.
   */
  stats(id: string): Promise<SandboxStats>;

  /** Liveness check for the underlying runtime (e.g. Docker daemon reachable). */
  ping(): Promise<void>;

  /**
   * Total host capacity available to the runtime — total memory (MiB) and CPU
   * count. Backs the capacity meter + admission control. For the container
   * driver this is the Docker host/VM's `MemTotal` / `NCPU`.
   */
  hostInfo(): Promise<HostInfo>;

  /**
   * Warm-pool footprint held outside any sandbox record: ready spares, plus the
   * memory (MiB) the pool reserves — charged at the pool TARGET, since a spare
   * below target is owed and its replacement boots without re-admission.
   * Admission control charges `reservedMb` against the host budget — pooled
   * guests consume real RAM the store cannot see. Absent on drivers without a
   * pool.
   */
  poolStats?(): { spares: number; reservedMb: number };
}

/** Total host capacity as seen by the runtime. */
export interface HostInfo {
  /** Total memory available to the runtime, in MiB. */
  memoryMb: number;
  /** Number of CPUs available to the runtime. */
  cpus: number;
}
