// Shared daemon types.

/**
 * Lifecycle states. `creating` is the initial state while provisioning (launch +
 * clone + setup) runs — a detached create returns the record in this state and
 * flips it to `running` (or `error`, with the reason in `statusReason`) in the
 * background. `running` and `stopped` are explicit (user-driven via start/stop);
 * `paused` is auto-entered by the idle reaper after `sleepAfterMs` of inactivity
 * and auto-resumes on the next operation. A `stopped` sandbox is left alone by
 * the reaper and does *not* auto-resume — the user must `start` it. `error` is
 * terminal: the backing resources are already destroyed; only DELETE applies.
 */
export type SandboxStatus = "creating" | "running" | "paused" | "stopped" | "error";

/**
 * Hard per-sandbox resource caps, enforced by the driver (cgroups via Docker).
 * Each field `0`/undefined means "unlimited" (omitted from the container config).
 * Units stay ergonomic for callers; the driver translates to its backend.
 */
export interface ResourceLimits {
  /** Memory cap in MiB. */
  memoryMb?: number;
  /** CPU cap in fractional cores (e.g. 0.5 = half a core, 2 = two cores). */
  cpus?: number;
  /** Max number of processes/threads (fork-bomb guard). */
  pidsLimit?: number;
}

export interface SandboxRecord {
  id: string;
  image: string;
  status: SandboxStatus;
  /**
   * Human-readable elaboration of `status`: the provisioning phase while
   * `creating` ("cloning repo", "running setup"), the failure reason after
   * `error`. Unset in the other states.
   */
  statusReason?: string;
  createdAt: string;
  /**
   * Runtime driver backing this sandbox (`container` | `applevz` | `firecracker`).
   * Set at create time (per-sandbox isolation selection); the daemon routes every
   * op to this driver. Empty/undefined falls back to the daemon default driver.
   */
  driver?: string;
  labels: Record<string, string>;
  /**
   * Sandbox-level environment variables, merged into every `exec`/`startProcess`
   * in this sandbox. Seeded from the create call's `env` and mutated by
   * `setEnvVars`. Request- and session-level env take precedence over these.
   */
  env: Record<string, string>;
  /**
   * Whether `/workspace` is backed by a named volume that survives `stop`/`start`
   * and container recreation. Set at create time; defaults to true.
   */
  persist: boolean;
  /**
   * ISO timestamp of the last operation that ran work in the sandbox (exec, file
   * op, run-code, proxy traffic, …). Drives idle detection. Refreshed by the
   * store's `touch`.
   */
  lastActivityAt: string;
  /**
   * Auto-pause the sandbox after this many milliseconds of inactivity (the idle
   * reaper transitions `running → paused`, freeing compute while the workspace
   * volume persists). `0` disables auto-pause. Set at create time.
   */
  sleepAfterMs: number;
  /** Resolved hard resource caps (per-create override merged over daemon defaults). */
  limits: ResourceLimits;
  /**
   * Hard ceiling (USD) on this sandbox's cumulative LLM-provider cost across ALL
   * its egress tokens — the gateway returns 402 once `usage.providerCost` reaches
   * it, regardless of per-token caps. `0`/undefined = unlimited. A blast-radius
   * backstop: even an abused, not-yet-revoked token can't exceed it.
   */
  egressSpendCapUsd?: number;
  /** Cumulative resource usage, integrated by the metrics sampler. */
  usage: SandboxUsage;
}

/**
 * A captured microVM template, as persisted by the daemon. The driver owns the
 * snapshot on disk; this row is the index the API/SDK/CLI list from, and it
 * carries the image + resource shape a fork must match.
 */
export interface TemplateRecord {
  /** Stable, URL-safe name (also the on-disk directory name). */
  name: string;
  /** Driver that captured it — a fork is routed back to the same driver. */
  driver: string;
  /** Image the template was captured from. */
  image: string;
  /** Resource shape the snapshot was taken at; a fork must match it exactly. */
  limits: ResourceLimits;
  /** Sandbox it was captured from (provenance only). */
  sourceSandboxId?: string;
  createdAt: string;
  /** Bytes the snapshot + disks occupy on the host. */
  sizeBytes: number;
}

/**
 * Cumulative, time-integrated resource usage for a sandbox — the basis of the
 * cost meter. Accumulated by the metrics sampler and persisted, so totals carry
 * across daemon restarts. The two `last*` fields are sampler bookkeeping.
 */
export interface SandboxUsage {
  /** Total vCPU-seconds consumed (Σ of cumulative-CPU-ns deltas / 1e9). */
  cpuSeconds: number;
  /** Total memory byte-seconds (Σ of memBytes × seconds-since-last-sample). */
  memByteSeconds: number;
  /** Total bytes the sandbox has sent out through the preview proxy. */
  egressBytes: number;
  /** Number of LLM-provider calls made through the egress credential proxy. */
  providerCalls: number;
  /** Total bytes exchanged with providers through the egress proxy (both ways). */
  providerBytes: number;
  /** Prompt/input tokens billed across provider calls (parsed from responses). */
  providerTokensIn: number;
  /** Completion/output tokens billed across provider calls. */
  providerTokensOut: number;
  /** Provider-reported LLM cost in USD (e.g. OpenRouter's `usage.cost`), summed across calls. */
  providerCost: number;
  /** Last observed cumulative CPU ns, to compute the next delta (reset-safe). */
  lastCpuTotalNs: number;
  /** ISO timestamp of the last sample, to integrate memory over wall-clock. */
  lastSampledAt: string;
}

/**
 * Per-token egress policy. Every field is optional; an empty policy (`{}`) means
 * "unlimited" — the original, pre-policy behaviour. Enforced by the egress
 * gateway on the LLM hot path (see `proxy/egress.ts`).
 */
export interface EgressPolicy {
  /** ISO timestamp after which the token is rejected with 403. Omit = never expires. */
  expiresAt?: string;
  /** Cumulative USD this token may spend across provider calls; 402 once reached. */
  spendCapUsd?: number;
  /** Sliding-window rate limit (per token). Omit = unlimited. */
  rateLimit?: {
    /** Max provider calls per window. */
    calls?: number;
    /** Max billed tokens (in+out) per window. */
    tokens?: number;
    /** Window length in milliseconds. */
    windowMs: number;
  };
  /** Allowed model ids/prefix-globs (matched against the request's `model`). Omit = all. */
  models?: string[];
  /** Allowed provider names (e.g. `openai`). Omit = every configured provider. */
  providers?: string[];
}

/**
 * A minted egress token bound to a sandbox, with its policy and running spend.
 * The store keeps these in an O(1) `Map<token, EgressTokenRecord>` so the gateway
 * resolves token → sandbox + policy in one lookup on every provider call.
 */
export interface EgressTokenRecord {
  token: string;
  sandboxId: string;
  policy: EgressPolicy;
  createdAt: string;
  /** Cumulative USD spent through this token (drives the spend cap). */
  spendUsd: number;
}

/** Per-resource cost breakdown in the configured currency. */
export interface CostBreakdown {
  cpu: number;
  mem: number;
  egress: number;
  /** LLM cost (provider-reported, e.g. OpenRouter `usage.cost`). */
  provider: number;
  total: number;
}

/**
 * A persistent execution context inside a sandbox. Holds a working directory
 * (which follows `cd` across commands) and its own environment overlay, so a
 * sequence of `exec`s behaves like one shell session. Built on top of the
 * driver's stateless `exec`/`readFile` — no driver support required.
 */
export interface SessionInfo {
  sessionId: string;
  /** Working directory for the next command; updated after each exec. */
  cwd: string;
  /** Session-level env, layered over the sandbox env. */
  env: Record<string, string>;
  createdAt: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** A single event in a streaming command execution. */
export type ExecEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; exitCode: number };

/** Metadata returned for a file or directory entry. */
export interface FileInfo {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

/** Options for writing a file inside a sandbox. */
export interface WriteFileOptions {
  path: string;
  content: string;
  mode?: string;
}

/** Options for reading a file from a sandbox. */
export interface ReadFileOptions {
  path: string;
}

/** Options for creating a directory inside a sandbox. */
export interface MkdirOptions {
  path: string;
  parents?: boolean;
}

/** Options for listing files inside a sandbox. */
export interface ListFilesOptions {
  path: string;
}

/** Options for launching a long-running background process. */
export interface StartProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** A long-running background process tracked by the daemon. */
export interface ProcessInfo {
  /** Daemon-assigned handle (stable across PID reuse). */
  procId: string;
  /** In-container PID of the detached process. */
  pid: number;
  command: string;
  status: "running" | "exited";
  exitCode: number | null;
  startedAt: string;
  /** Path of the process logfile inside the sandbox. */
  logPath: string;
}

/**
 * A persistent code-interpreter context. Backed by a long-lived kernel process
 * inside the sandbox that keeps a namespace across `runCode` calls (variables
 * and imports persist, Jupyter-style).
 */
export interface CodeContextInfo {
  contextId: string;
  language: "python" | "javascript";
  /** Context directory inside the sandbox (holds the kernel + its fifos). */
  dir: string;
  /** procId of the kernel background process (so it can be killed on cleanup). */
  procId: string;
  /** In-container PID of the kernel (target for the kill on cleanup). */
  pid: number;
  /** Monotonic cell counter, incremented per `runCode`. */
  seq: number;
  createdAt: string;
}

/** A single rich output from a code cell. */
export interface CodeOutput {
  type: "text";
  text: string;
}

/** The result of running a code cell. */
export interface CodeResult {
  stdout: string;
  stderr: string;
  /** Rich outputs (e.g. the value of a trailing expression). */
  results: CodeOutput[];
  /** Formatted traceback/stack if the cell raised, else null. */
  error: string | null;
}

/** A filesystem change observed by `watch`. */
export interface FileChangeEvent {
  type: "created" | "modified" | "deleted";
  path: string;
}

/** Options for watching a path for changes. */
export interface WatchOptions {
  /** Poll interval in milliseconds (default 1000). */
  intervalMs?: number;
}

/** Options for waiting until a TCP port is listening inside a sandbox. */
export interface WaitForPortOptions {
  timeoutMs?: number;
  intervalMs?: number;
  host?: string;
}

/** A port exposed through the daemon's preview-URL reverse proxy. */
export interface ExposedPort {
  /** In-container port the app listens on. */
  port: number;
  /** Routing label / subdomain (`<sandboxId>-<port>`). */
  exposeId: string;
  /** Optional per-port bearer token; null means open on loopback. */
  token: string | null;
  createdAt: string;
  /** Computed preview URL. */
  url: string;
}
