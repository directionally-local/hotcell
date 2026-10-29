/**
 * @hotcell/sdk — TypeScript client for the hotcell daemon.
 *
 * Mirrors the Cloudflare Sandbox SDK surface so existing harnesses port with
 * minimal changes, but points at *your* self-hosted daemon instead of the edge.
 *
 *   const client = new HotcellClient({ endpoint: "http://127.0.0.1:4750" });
 *   const sandbox = await client.getSandbox();
 *   const { stdout } = await sandbox.exec("python3 -c 'print(2+2)'");
 *   await sandbox.destroy();
 */

export type ExecEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; exitCode: number };

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Run inside a persistent session (its cwd/env apply and `cd` persists). */
  sessionId?: string;
  /** Called for each stdout/stderr chunk as it streams in. */
  onOutput?: (stream: "stdout" | "stderr", data: string) => void;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

export type SandboxStatus = "creating" | "running" | "paused" | "stopped" | "error";

/** Hard per-sandbox resource caps (0/absent = unlimited). */
export interface SandboxLimits {
  /** Memory cap in MiB. */
  memoryMb?: number;
  /** CPU cap in fractional cores (e.g. 0.5, 2). */
  cpus?: number;
  /** Max processes/threads. */
  pidsLimit?: number;
}

export interface SandboxInfo {
  id: string;
  image: string;
  /**
   * Lifecycle state. `creating` is a detached create still provisioning (see
   * `CreateOptions.detach`); `paused` is entered automatically after
   * `sleepAfterMs` of inactivity (the next operation transparently resumes it);
   * `stopped` is a manual stop that does not auto-resume; `error` is a create
   * that failed (reason in `statusReason` — destroy it).
   */
  status: SandboxStatus;
  /** Elaboration of `status`: the provisioning phase while `creating`, the failure reason after `error`. */
  statusReason?: string;
  createdAt: string;
  labels: Record<string, string>;
  /** Whether `/workspace` is backed by a volume that survives stop/start. */
  persist: boolean;
  /** ISO timestamp of the last activity (drives idle auto-pause). */
  lastActivityAt: string;
  /** Idle timeout (ms) before auto-pause; 0 disables it. */
  sleepAfterMs: number;
  /** Resolved hard resource caps applied to the sandbox ({} = unlimited). */
  limits: SandboxLimits;
}

/**
 * A captured microVM template: a paused guest snapshot plus its disks, stored on
 * the daemon host. `getSandbox({ template })` restores one into a fresh sandbox
 * without booting a kernel or re-running setup.
 */
export interface TemplateInfo {
  /** Stable name (also the on-disk directory name). */
  name: string;
  /** Driver that captured it; a fork is routed back to the same driver. */
  driver: string;
  /** Image the template was captured from. */
  image: string;
  /** Resource shape the snapshot was taken at; a fork must match it. */
  limits: SandboxLimits;
  /** Sandbox it was captured from (provenance only). */
  sourceSandboxId?: string;
  createdAt: string;
  /** Bytes the snapshot + disks occupy on the host. */
  sizeBytes: number;
}

export interface FileInfo {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

/** Live resource snapshot for a running sandbox. */
export interface SandboxStats {
  cpuPercent: number;
  cpuTotalUsageNs: number;
  onlineCpus: number;
  memBytes: number;
  memLimitBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  pids: number;
  sampledAt: string;
}

/** Cumulative, time-integrated usage backing the cost meter. */
export interface SandboxUsage {
  cpuSeconds: number;
  memByteSeconds: number;
  egressBytes: number;
  /** LLM-provider calls made through the egress credential proxy. */
  providerCalls: number;
  /** Bytes exchanged with providers through the egress proxy. */
  providerBytes: number;
  /** Prompt/input tokens billed across provider calls. */
  providerTokensIn: number;
  /** Completion/output tokens billed across provider calls. */
  providerTokensOut: number;
  /** Provider-reported LLM cost in USD (e.g. OpenRouter `usage.cost`), summed. */
  providerCost: number;
}

/** A provider reachable through the egress credential proxy (LLM gateway). */
export interface EgressProvider {
  name: string;
  /** Base URL to point the provider SDK at (sandbox uses the token as the key). */
  baseUrl: string;
  /** Conventional env var for the base URL (e.g. OPENAI_BASE_URL). */
  baseUrlEnv?: string;
  /** Conventional env var for the API key (set it to the egress token). */
  keyEnv?: string;
}

/**
 * Per-token egress policy. Every field is optional; an omitted/empty policy means
 * "unlimited" (the original behaviour). Enforced by the daemon's egress gateway.
 */
export interface EgressPolicy {
  /** ISO timestamp after which the token is rejected (403). */
  expiresAt?: string;
  /** Sugar accepted on mint: expire `ttlMs` after creation. */
  ttlMs?: number;
  /** Cumulative USD this token may spend (402 once reached). */
  spendCapUsd?: number;
  /** Sliding-window rate limit (per token). */
  rateLimit?: { calls?: number; tokens?: number; windowMs: number };
  /** Allowed model ids/prefix-globs. Omit = all. */
  models?: string[];
  /** Allowed provider names. Omit = every configured provider. */
  providers?: string[];
}

/** A minted egress token plus the provider base URLs it unlocks. */
export interface EgressToken {
  token: string;
  /** The policy bound to the token (echoed back on mint). */
  policy?: EgressPolicy;
  providers: EgressProvider[];
}

/** An egress token with its policy + running spend, as returned by `listEgressTokens`. */
export interface EgressTokenInfo {
  token: string;
  policy: EgressPolicy;
  spendUsd: number;
  /** USD left under the spend cap, or null when uncapped. */
  spendRemaining: number | null;
}

/** Per-resource cost breakdown in the daemon's configured currency. */
export interface CostBreakdown {
  cpu: number;
  mem: number;
  egress: number;
  /** LLM cost (provider-reported, e.g. OpenRouter `usage.cost`). */
  provider: number;
  total: number;
}

/** Metrics + cost for a sandbox; `live` is null when not running. */
export interface SandboxMetrics {
  status: SandboxStatus;
  live: SandboxStats | null;
  usage: SandboxUsage;
  cost: CostBreakdown;
}

export interface CreateOptions {
  image?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  /**
   * Back `/workspace` with a named volume so files survive `stop`/`start` and
   * container recreation. Defaults to true.
   */
  persist?: boolean;
  /**
   * Auto-pause the sandbox after this many milliseconds of inactivity (the idle
   * reaper frees compute while the workspace volume persists; the next operation
   * auto-resumes it). Omit or set 0 to disable. Defaults to the daemon's
   * `SBX_SLEEP_AFTER_MS`.
   */
  sleepAfter?: number;
  /**
   * Wire the sandbox to the egress credential proxy: the daemon mints an egress
   * token and injects provider base-URL + key env vars (e.g. `OPENAI_BASE_URL`,
   * `OPENAI_API_KEY`) so LLM SDKs inside route through the gateway with no real
   * keys. Only providers configured on the daemon are wired. Defaults to false.
   *
   * Pass an `EgressPolicy` object instead of `true` to bind the minted token to a
   * policy (TTL, spend cap, rate limit, model/provider scope).
   */
  egress?: boolean | EgressPolicy;
  /**
   * Hard ceiling (USD) on this sandbox's total LLM-provider cost across all its
   * egress tokens; the gateway returns 402 once reached. A blast-radius backstop
   * independent of per-token caps. Omit/0 = unlimited (or the daemon default).
   */
  egressSpendCapUsd?: number;
  /**
   * Ordered shell commands run once, after the container starts at create time
   * (e.g. `["npm i kimiflare"]`). Best-effort: a non-zero exit is logged on the
   * daemon, not fatal. Not re-run on resume — with persistence (the default) the
   * workspace volume already holds the result.
   */
  setup?: string[];
  /**
   * Git repository URL cloned into `/workspace` at create time (before `setup`),
   * so an agent comes up with the code in place. Private repos: embed a token in
   * the URL (`https://<token>@github.com/owner/repo.git`). A clone failure fails
   * the create.
   */
  repo?: string;
  /** Branch/tag to check out when cloning `repo` (default: the repo's default branch). */
  repoRef?: string;
  /** Create + check out a NEW branch right after cloning `repo`; `"auto"` names it for you. */
  branch?: string;
  /**
   * Runtime driver for this sandbox: `container` (default), `firecracker`
   * (Linux + KVM microVM), or `applevz` (macOS microVM) — one daemon can run
   * all three side by side. Omit for the daemon default.
   */
  driver?: string;
  /**
   * Opt-in outbound networking for a microVM sandbox (Firecracker): give the
   * guest a real NAT'd NIC instead of the default no-network-device posture.
   * For trusted workloads that need general internet (apt/git/pip): raw sockets
   * bypass the gateway's allowlist and logging. Host services and cloud metadata
   * stay firewalled off. The default (false) keeps the hardened posture: no NIC,
   * egress only over the gateway.
   */
  networked?: boolean;
  /** Hard memory cap in MiB (overrides the daemon default; 0 = unlimited). */
  memoryMb?: number;
  /** Hard CPU cap in fractional cores, e.g. 0.5 (overrides the daemon default). */
  cpus?: number;
  /** Hard process/thread cap (overrides the daemon default; 0 = unlimited). */
  pidsLimit?: number;
  /**
   * Restore a captured template into a fresh sandbox instead of booting one.
   * The workspace, installed tooling and any running processes come from the
   * snapshot, so `repo`/`setup`/`branch`/`networked` are rejected — they are
   * already baked in. The resource shape must match the template's.
   */
  template?: string;
  /**
   * Ask the daemon to return immediately (status `creating`) and provision in
   * the background; the SDK then polls the sandbox until it is usable. This
   * changes the transport, not the promise: `getSandbox` still resolves only
   * once the sandbox is running and throws (with the daemon's reason) if the
   * create fails. Use it for slow creates (repo clone + heavy `setup`) — a
   * single blocking request is killed by fetch's ~5-minute response timeout in
   * Node. An older daemon ignores the flag and blocks, which degrades
   * gracefully. Defaults to false.
   */
  detach?: boolean;
  /**
   * Observe status/phase transitions during a detached create: called with the
   * record on creation and again whenever `status` or `statusReason` changes
   * ("creating (cloning repo)" → … → `running`, or `error`). Only fires when
   * `detach` is set.
   */
  onStatus?: (status: SandboxStatus, info: SandboxInfo) => void;
}

export interface WriteFileOptions {
  /** Unix permissions in octal (for example, "600" or "0644"). */
  mode?: string;
}

export interface MkdirOptions {
  parents?: boolean;
}

export interface StartProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** A long-running background process tracked by the daemon. */
export interface ProcessHandle {
  procId: string;
  pid: number;
  command: string;
  status: "running" | "exited";
  exitCode: number | null;
  startedAt: string;
  logPath: string;
}

export interface WaitForPortOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Hostname or IP literal to probe inside the sandbox. */
  host?: string;
}

/** A port exposed through the daemon's preview-URL reverse proxy. */
export interface ExposedPort {
  port: number;
  exposeId: string;
  token: string | null;
  createdAt: string;
  url: string;
}

/** A persistent execution context (working directory + env) inside a sandbox. */
export interface SessionInfo {
  sessionId: string;
  cwd: string;
  env: Record<string, string>;
  createdAt: string;
}

export interface CreateSessionOptions {
  /** Explicit session id; a random one is assigned when omitted. */
  id?: string;
  cwd?: string;
  env?: Record<string, string>;
}

/** A filesystem change observed by `watch`. */
export interface FileChangeEvent {
  type: "created" | "modified" | "deleted";
  path: string;
}

export type CodeLanguage = "python" | "javascript";

/** Public view of a code-interpreter context. */
export interface CodeContextInfo {
  contextId: string;
  language: CodeLanguage;
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
  results: CodeOutput[];
  error: string | null;
}

/** Metadata for a workspace backup. */
export interface BackupInfo {
  backupId: string;
  sandboxId: string;
  createdAt: string;
  /** Size of the backup tarball in bytes. */
  bytes: number;
}

/** Host capacity + admission status from `GET /capacity`. */
export interface CapacitySnapshot {
  enforced: boolean;
  overcommit: number;
  defaultReservationMb: number;
  memory: { budgetMb: number; committedMb: number; availableMb: number };
  cpu: { budget: number; committed: number; available: number };
  running: number;
  /** Approx. number of additional default-reservation sandboxes that still fit. */
  fits: number;
  /** Warm-pool footprint: ready spares + the MiB they reserve, counted in
   *  committedMb (absent on daemons older than 0.1.11). */
  pool?: { spares: number; reservedMb: number };
}

/** Daemon metadata from `GET /info`. */
export interface DaemonInfo {
  /** Daemon package version (added 0.1.7; undefined on older daemons). */
  version?: string;
  driver: string;
  drivers: string[];
  defaultImage: string;
  proxyPort: number;
  egressPort: number;
  egressProviders: string[];
  costCpuPerHour: number;
  costMemGbPerHour: number;
  costEgressPerGb: number;
  defaultSleepAfterMs: number;
  auth: boolean;
  otlp: boolean;
}

export interface HotcellClientOptions {
  endpoint?: string;
  /**
   * API key sent as `Authorization: Bearer <key>` on every request. The daemon
   * always requires one. Defaults to `HOTCELL_API_KEY` (legacy `SBX_API_KEY`),
   * then, for a loopback endpoint, the key the local daemon generated in
   * `${HOTCELL_HOME || ~/.hotcell}/api-key` (see `localApiKey`).
   */
  apiKey?: string;
}

/** One live-metrics sample (for sparklines / history charts). */
export interface MetricSample {
  at: string;
  cpuPercent: number;
  memBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  pids: number;
}

export class HotcellClient {
  readonly endpoint: string;
  private readonly apiKey: string;

  constructor(opts: HotcellClientOptions = {}) {
    this.endpoint = (opts.endpoint ?? defaultEndpoint()).replace(/\/$/, "");
    this.apiKey = opts.apiKey || defaultApiKey();
  }

  /** Build request headers, attaching the API key and any extras. */
  authHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    // Resolved per request: the local daemon may write its key file after
    // this client was created (first start).
    const key = this.apiKey || localApiKey(this.endpoint);
    if (key) headers["authorization"] = `Bearer ${key}`;
    return headers;
  }

  /** Create a fresh sandbox (Cloudflare-style: omit id to provision a new one). */
  async getSandbox(id?: string, options?: CreateOptions): Promise<Sandbox> {
    if (id) {
      // Attach to an existing sandbox by id.
      const info = await this.request<SandboxInfo>("GET", `/sandboxes/${id}`);
      return new Sandbox(this, info);
    }
    const { onStatus, ...wire } = options ?? {};
    let info = await this.request<SandboxInfo>("POST", "/sandboxes", wire);
    if (wire.detach) {
      onStatus?.(info.status, info);
      if (info.status === "creating") info = await this.waitForReady(info.id, onStatus);
    }
    return new Sandbox(this, info);
  }

  /**
   * Poll a detached create until it leaves `creating`. Resolves with the ready
   * record, throws on `error` (with the daemon's reason) or if the record
   * disappears (destroyed mid-create). Transient poll failures (daemon restart,
   * network blip) are retried; there is no overall timeout — creates are
   * legitimately long, and each poll is a short request that cannot trip
   * fetch's response timeout.
   */
  private async waitForReady(
    id: string,
    onStatus?: (status: SandboxStatus, info: SandboxInfo) => void,
  ): Promise<SandboxInfo> {
    let lastSeen = "";
    let failures = 0;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      let info: SandboxInfo;
      try {
        info = await this.request<SandboxInfo>("GET", `/sandboxes/${id}`);
        failures = 0;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("-> 404")) {
          throw new Error(`sandbox ${id} was destroyed while being created`);
        }
        if (++failures >= 10) throw err;
        continue;
      }
      const seen = `${info.status}\0${info.statusReason ?? ""}`;
      if (seen !== lastSeen) {
        lastSeen = seen;
        onStatus?.(info.status, info);
      }
      if (info.status === "error") {
        throw new Error(`sandbox create failed: ${info.statusReason ?? "unknown error"}`);
      }
      if (info.status !== "creating") return info;
    }
  }

  /** List all sandboxes managed by the daemon. */
  async list(): Promise<SandboxInfo[]> {
    const { sandboxes } = await this.request<{ sandboxes: SandboxInfo[] }>(
      "GET",
      "/sandboxes",
    );
    return sandboxes;
  }

  /**
   * Capture a running sandbox as a reusable template. The daemon pauses the
   * guest, writes a full snapshot, and resumes the source, so the sandbox keeps
   * running. Only microVM drivers (Firecracker) support this.
   */
  async createTemplate(name: string, from: string): Promise<TemplateInfo> {
    return this.request<TemplateInfo>("POST", "/templates", { name, from });
  }

  /** List captured templates, newest first. */
  async listTemplates(): Promise<TemplateInfo[]> {
    const { templates } = await this.request<{ templates: TemplateInfo[] }>("GET", "/templates");
    return templates;
  }

  /** Delete a template and its on-disk snapshot. */
  async deleteTemplate(name: string): Promise<void> {
    await this.request("DELETE", `/templates/${encodeURIComponent(name)}`);
  }

  /** Daemon health + active runtime driver. */
  async health(): Promise<{ ok: boolean; driver: string; version?: string }> {
    return this.request("GET", "/healthz");
  }

  /** Daemon info: active/available drivers, default image, ports, providers, cost rates. */
  async info(): Promise<DaemonInfo> {
    return this.request<DaemonInfo>("GET", "/info");
  }

  /** Host capacity + admission status (committed vs budget memory, how many more fit). */
  async capacity(): Promise<CapacitySnapshot> {
    return this.request<CapacitySnapshot>("GET", "/capacity");
  }

  /** List all workspace backups across sandboxes. */
  async listBackups(): Promise<BackupInfo[]> {
    const { backups } = await this.request<{ backups: BackupInfo[] }>(
      "GET",
      "/backups",
    );
    return backups;
  }

  /** Delete a backup by id. */
  async deleteBackup(backupId: string): Promise<void> {
    await this.request("DELETE", `/backups/${backupId}`);
  }

  /** @internal */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.endpoint + path, {
        method,
        headers: this.authHeaders(body ? { "content-type": "application/json" } : undefined),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      // A transport failure means the daemon isn't reachable — undici's raw
      // "fetch failed" is useless, so surface a clear, tagged error the CLI can
      // turn into a "start it" hint. (No CLI-specific text here: keep the SDK
      // CLI-agnostic.)
      const err = new Error(
        `The hotcell daemon isn't running (couldn't reach it at ${this.endpoint}).`,
      );
      (err as { code?: string }).code = "DAEMON_UNREACHABLE";
      throw err;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`hotcell ${method} ${path} -> ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }
}

export class Sandbox {
  constructor(
    private readonly client: HotcellClient,
    private info: SandboxInfo,
  ) {}

  get id(): string {
    return this.info.id;
  }

  /** Current lifecycle status (`running`, `paused`, or `stopped`). */
  get status(): SandboxStatus {
    return this.info.status;
  }

  /** The sandbox metadata captured when this handle was created/attached. */
  getInfo(): SandboxInfo {
    return this.info;
  }

  /** Run a command to completion, returning aggregated output. */
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    for await (const event of this.execStream(command, options)) {
      if (event.type === "stdout") stdout += event.data;
      else if (event.type === "stderr") stderr += event.data;
      else exitCode = event.exitCode;
    }
    return { stdout, stderr, exitCode, success: exitCode === 0 };
  }

  /** Run a command, yielding output events as they stream in. */
  async *execStream(
    command: string,
    options: ExecOptions = {},
  ): AsyncGenerator<ExecEvent> {
    const res = await fetch(
      `${this.client.endpoint}/sandboxes/${this.info.id}/exec`,
      {
        method: "POST",
        headers: this.client.authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          command,
          cwd: options.cwd,
          env: options.env,
          sessionId: options.sessionId,
        }),
      },
    );
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`hotcell exec -> ${res.status}: ${text}`);
    }
    for await (const event of parseSSE<ExecEvent>(res.body)) {
      if (
        options.onOutput &&
        (event.type === "stdout" || event.type === "stderr")
      ) {
        options.onOutput(event.type, event.data);
      }
      yield event;
    }
  }

  /**
   * Stop the sandbox, freeing compute. With persistence the workspace volume is
   * kept so `start` resumes with files intact; background processes do not
   * survive. A no-op if already stopped.
   */
  async stop(): Promise<void> {
    this.info = await this.client.request<SandboxInfo>(
      "POST",
      `/sandboxes/${this.info.id}/stop`,
    );
  }

  /** Restart a stopped sandbox, reattaching its workspace. A no-op if running. */
  async start(): Promise<void> {
    this.info = await this.client.request<SandboxInfo>(
      "POST",
      `/sandboxes/${this.info.id}/start`,
    );
  }

  /**
   * Pause the sandbox, freeing its compute; any later operation transparently
   * resumes it. On microVM drivers (firecracker/applevz) this saves a full
   * memory snapshot — background processes come back **alive** on resume, in
   * ~tens of milliseconds instead of a boot. On the container driver it
   * degrades to stop-with-volume (workspace survives, processes don't).
   */
  async pause(): Promise<void> {
    this.info = await this.client.request<SandboxInfo>(
      "POST",
      `/sandboxes/${this.info.id}/pause`,
    );
  }

  /**
   * Fetch live resource stats, cumulative usage, and cost. `live` is null when
   * the sandbox isn't running. Reading metrics does not count as activity, so it
   * won't keep an idle sandbox from auto-pausing.
   */
  async metrics(): Promise<SandboxMetrics> {
    return this.client.request<SandboxMetrics>(
      "GET",
      `/sandboxes/${this.info.id}/metrics`,
    );
  }

  /** Recent live-metrics samples (oldest→newest) for sparklines/history charts. */
  async metricsHistory(): Promise<MetricSample[]> {
    const { samples } = await this.client.request<{ samples: MetricSample[] }>(
      "GET",
      `/sandboxes/${this.info.id}/metrics/history`,
    );
    return samples;
  }

  /** Snapshot `/workspace` to a durable backup; returns its metadata. */
  async createBackup(): Promise<BackupInfo> {
    return this.client.request<BackupInfo>(
      "POST",
      `/sandboxes/${this.info.id}/backups`,
    );
  }

  /** Replace `/workspace` with the contents of a backup (taken from any sandbox). */
  async restoreBackup(backupId: string): Promise<void> {
    await this.client.request(
      "POST",
      `/sandboxes/${this.info.id}/restore`,
      { backupId },
    );
  }

  /** List the backups taken from this sandbox. */
  async listBackups(): Promise<BackupInfo[]> {
    const { backups } = await this.client.request<{ backups: BackupInfo[] }>(
      "GET",
      `/sandboxes/${this.info.id}/backups`,
    );
    return backups;
  }

  /**
   * Create a persistent code-interpreter context. Variables and imports persist
   * across `runCode` calls made against the returned context (Jupyter-style).
   */
  async createCodeContext(
    options: { language?: CodeLanguage } = {},
  ): Promise<CodeContext> {
    const info = await this.client.request<CodeContextInfo>(
      "POST",
      `/sandboxes/${this.info.id}/code-contexts`,
      { language: options.language ?? "python" },
    );
    return new CodeContext(this, info);
  }

  /** List the open code-interpreter contexts in this sandbox. */
  async listCodeContexts(): Promise<CodeContextInfo[]> {
    const { contexts } = await this.client.request<{ contexts: CodeContextInfo[] }>(
      "GET",
      `/sandboxes/${this.info.id}/code-contexts`,
    );
    return contexts;
  }

  /**
   * Run a code cell and return its captured output. Pass a `context` to keep
   * state across calls, or omit it for a one-off run in a throwaway kernel.
   */
  async runCode(
    code: string,
    options: { context?: CodeContext; language?: CodeLanguage; timeoutMs?: number } = {},
  ): Promise<CodeResult> {
    return this.client.request<CodeResult>(
      "POST",
      `/sandboxes/${this.info.id}/run-code`,
      {
        code,
        contextId: options.context?.contextId,
        language: options.language,
        timeoutMs: options.timeoutMs,
      },
    );
  }

  /**
   * Mint an egress token for this sandbox. Configure the sandbox's LLM SDK with
   * the returned `providers[].baseUrl` and use the token in place of the real API
   * key — the daemon injects the real provider key and meters the call, so keys
   * never live inside the sandbox.
   */
  async createEgressToken(policy?: EgressPolicy): Promise<EgressToken> {
    return this.client.request<EgressToken>(
      "POST",
      `/sandboxes/${this.info.id}/egress-tokens`,
      policy ?? {},
    );
  }

  /** List this sandbox's egress tokens (with policy + spend) and provider routes. */
  async listEgressTokens(): Promise<{ tokens: EgressTokenInfo[]; providers: EgressProvider[] }> {
    return this.client.request("GET", `/sandboxes/${this.info.id}/egress-tokens`);
  }

  /** Revoke a previously minted egress token. */
  async revokeEgressToken(token: string): Promise<void> {
    await this.client.request(
      "DELETE",
      `/sandboxes/${this.info.id}/egress-tokens/${token}`,
    );
  }

  /** Permanently destroy the sandbox, including its persistent volume. */
  async destroy(): Promise<void> {
    await this.client.request("DELETE", `/sandboxes/${this.info.id}`);
  }

  /** Write a UTF-8 file inside the sandbox. */
  async writeFile(
    path: string,
    content: string,
    options: WriteFileOptions = {},
  ): Promise<void> {
    await this.client.request<{ ok: boolean }>(
      "POST",
      `/sandboxes/${this.info.id}/files/write`,
      { path, content, mode: options.mode },
    );
  }

  /** Read a UTF-8 file from the sandbox. */
  async readFile(path: string): Promise<string> {
    const { content } = await this.client.request<{ content: string }>(
      "POST",
      `/sandboxes/${this.info.id}/files/read`,
      { path },
    );
    return content;
  }

  /** Create a directory inside the sandbox. */
  async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    await this.client.request<{ ok: boolean }>(
      "POST",
      `/sandboxes/${this.info.id}/files/mkdir`,
      { path, parents: options.parents },
    );
  }

  /** List files and directories at the given path. */
  async listFiles(path: string): Promise<FileInfo[]> {
    const { entries } = await this.client.request<{ entries: FileInfo[] }>(
      "POST",
      `/sandboxes/${this.info.id}/files/list`,
      { path },
    );
    return entries;
  }

  /**
   * Watch a path (recursively) for file changes, yielding events until the
   * returned generator is closed (e.g. `break` out of the loop).
   */
  async *watch(
    path = "/workspace",
    options: { intervalMs?: number } = {},
  ): AsyncGenerator<FileChangeEvent> {
    const params = new URLSearchParams({ path });
    if (options.intervalMs) params.set("interval", String(options.intervalMs));
    const res = await fetch(
      `${this.client.endpoint}/sandboxes/${this.info.id}/watch?${params}`,
      { headers: this.client.authHeaders() },
    );
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`sbx watch -> ${res.status}: ${text}`);
    }
    for await (const event of parseSSE<FileChangeEvent>(res.body)) {
      yield event;
    }
  }

  /** Launch a long-running background process; returns immediately. */
  async startProcess(
    command: string,
    options: StartProcessOptions = {},
  ): Promise<ProcessHandle> {
    return this.client.request<ProcessHandle>(
      "POST",
      `/sandboxes/${this.info.id}/processes`,
      { command, cwd: options.cwd, env: options.env },
    );
  }

  /** List background processes started in this sandbox. */
  async listProcesses(): Promise<ProcessHandle[]> {
    const { processes } = await this.client.request<{ processes: ProcessHandle[] }>(
      "GET",
      `/sandboxes/${this.info.id}/processes`,
    );
    return processes;
  }

  /** Signal a background process (default SIGTERM). */
  async killProcess(procId: string, signal?: string): Promise<void> {
    await this.client.request(
      "DELETE",
      `/sandboxes/${this.info.id}/processes/${procId}`,
      signal ? { signal } : undefined,
    );
  }

  /** Stream a process's logs; `follow` tails until the connection closes. */
  async *streamLogs(
    procId: string,
    options: { follow?: boolean } = {},
  ): AsyncGenerator<string> {
    const follow = options.follow ? "1" : "0";
    const res = await fetch(
      `${this.client.endpoint}/sandboxes/${this.info.id}/processes/${procId}/logs?follow=${follow}`,
      { headers: this.client.authHeaders() },
    );
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`sbx logs -> ${res.status}: ${text}`);
    }
    for await (const event of parseSSE<LogEvent>(res.body)) {
      if (event.type === "log") yield event.data;
      else if (event.type === "end") return;
    }
  }

  /** Block until a TCP port is listening inside the sandbox, or timeout. */
  async waitForPort(
    port: number,
    options: WaitForPortOptions = {},
  ): Promise<boolean> {
    const { ready } = await this.client.request<{ ready: boolean }>(
      "POST",
      `/sandboxes/${this.info.id}/wait-port`,
      { port, ...options },
    );
    return ready;
  }

  /** Expose an in-container port and return its preview URL. */
  async exposePort(
    port: number,
    options: { token?: string } = {},
  ): Promise<ExposedPort> {
    return this.client.request<ExposedPort>(
      "POST",
      `/sandboxes/${this.info.id}/expose`,
      { port, token: options.token },
    );
  }

  /** Remove a previously exposed port. */
  async unexposePort(port: number): Promise<void> {
    await this.client.request(
      "DELETE",
      `/sandboxes/${this.info.id}/expose/${port}`,
    );
  }

  /** List the ports currently exposed for this sandbox. */
  async listExposedPorts(): Promise<ExposedPort[]> {
    const { exposed } = await this.client.request<{ exposed: ExposedPort[] }>(
      "GET",
      `/sandboxes/${this.info.id}/expose`,
    );
    return exposed;
  }

  /** Merge environment variables applied to every subsequent command. */
  async setEnvVars(env: Record<string, string>): Promise<Record<string, string>> {
    const res = await this.client.request<{ env: Record<string, string> }>(
      "POST",
      `/sandboxes/${this.info.id}/env`,
      { env },
    );
    return res.env;
  }

  /** Read the sandbox-level environment variables. */
  async getEnvVars(): Promise<Record<string, string>> {
    const res = await this.client.request<{ env: Record<string, string> }>(
      "GET",
      `/sandboxes/${this.info.id}/env`,
    );
    return res.env;
  }

  /** Create a persistent session; commands run in it share cwd + env. */
  async createSession(options: CreateSessionOptions = {}): Promise<Session> {
    const info = await this.client.request<SessionInfo>(
      "POST",
      `/sandboxes/${this.info.id}/sessions`,
      { id: options.id, cwd: options.cwd, env: options.env },
    );
    return new Session(this, info);
  }

  /** List the sessions open in this sandbox. */
  async listSessions(): Promise<SessionInfo[]> {
    const { sessions } = await this.client.request<{ sessions: SessionInfo[] }>(
      "GET",
      `/sandboxes/${this.info.id}/sessions`,
    );
    return sessions;
  }

  /** @internal — used by Session to reach the env/session endpoints. */
  get _client(): HotcellClient {
    return this.client;
  }
}

/**
 * A persistent execution context inside a sandbox. `exec` runs in the session's
 * working directory with its env overlay, and a `cd` persists to later commands.
 */
export class Session {
  constructor(
    private readonly sandbox: Sandbox,
    private readonly info: SessionInfo,
  ) {}

  get sessionId(): string {
    return this.info.sessionId;
  }

  /** Run a command to completion within this session. */
  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    return this.sandbox.exec(command, { ...options, sessionId: this.sessionId });
  }

  /** Run a command, yielding output events as they stream in. */
  execStream(command: string, options: ExecOptions = {}): AsyncGenerator<ExecEvent> {
    return this.sandbox.execStream(command, {
      ...options,
      sessionId: this.sessionId,
    });
  }

  /** Merge environment variables applied to subsequent commands in this session. */
  async setEnvVars(env: Record<string, string>): Promise<SessionInfo> {
    return this.sandbox._client.request<SessionInfo>(
      "POST",
      `/sandboxes/${this.sandbox.id}/sessions/${this.sessionId}/env`,
      { env },
    );
  }

  /** Delete this session (the sandbox and its files are untouched). */
  async destroy(): Promise<void> {
    await this.sandbox._client.request(
      "DELETE",
      `/sandboxes/${this.sandbox.id}/sessions/${this.sessionId}`,
    );
  }
}

/**
 * A persistent code-interpreter context. `runCode` executes in a kernel that
 * keeps its namespace across calls, so variables and imports persist.
 */
export class CodeContext {
  constructor(
    private readonly sandbox: Sandbox,
    private readonly info: CodeContextInfo,
  ) {}

  get contextId(): string {
    return this.info.contextId;
  }

  get language(): CodeLanguage {
    return this.info.language;
  }

  /** Run code in this context, sharing state with previous runs. */
  runCode(code: string, options: { timeoutMs?: number } = {}): Promise<CodeResult> {
    return this.sandbox.runCode(code, { context: this, timeoutMs: options.timeoutMs });
  }

  /** Destroy this context and its kernel. */
  async destroy(): Promise<void> {
    await this.sandbox._client.request(
      "DELETE",
      `/sandboxes/${this.sandbox.id}/code-contexts/${this.info.contextId}`,
    );
  }
}

type LogEvent = { type: "log"; data: string } | { type: "end" };

/** Convenience matching the Cloudflare `getSandbox(binding, id)` shape. */
export function getSandbox(
  client: HotcellClient,
  id?: string,
  options?: CreateOptions,
): Promise<Sandbox> {
  return client.getSandbox(id, options);
}

// --- internals -------------------------------------------------------------

function defaultEndpoint(): string {
  return envVar("HOTCELL_ENDPOINT") ?? envVar("SBX_ENDPOINT") ?? "http://127.0.0.1:4750";
}

function defaultApiKey(): string {
  return envVar("HOTCELL_API_KEY") ?? envVar("SBX_API_KEY") ?? "";
}

/** True for an endpoint on this machine (127.0.0.0/8, localhost, ::1). */
export function isLoopbackEndpoint(endpoint: string): boolean {
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "localhost" || host === "[::1]" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

type NodeBuiltins = {
  fs: { readFileSync(path: string, encoding: "utf8"): string };
  os: { homedir(): string };
  path: { join(...parts: string[]): string };
};

/**
 * The key the local daemon generated (`${HOTCELL_HOME || ~/.hotcell}/api-key`),
 * or "" when there is none, the endpoint is not on this machine (the local key
 * is never sent anywhere else), or the runtime is not Node 20.16+.
 */
export function localApiKey(endpoint: string = defaultEndpoint()): string {
  if (!isLoopbackEndpoint(endpoint)) return "";
  const proc = (globalThis as {
    process?: { env?: Record<string, string | undefined>; getBuiltinModule?: (id: string) => unknown };
  }).process;
  if (typeof proc?.getBuiltinModule !== "function") return "";
  try {
    const node: NodeBuiltins = {
      fs: proc.getBuiltinModule("node:fs") as NodeBuiltins["fs"],
      os: proc.getBuiltinModule("node:os") as NodeBuiltins["os"],
      path: proc.getBuiltinModule("node:path") as NodeBuiltins["path"],
    };
    const home = proc.env?.HOTCELL_HOME || node.path.join(node.os.homedir(), ".hotcell");
    return node.fs.readFileSync(node.path.join(home, "api-key"), "utf8").trim();
  } catch {
    return "";
  }
}

function envVar(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.[
    name
  ];
}

/** Parse a `text/event-stream` body into typed JSON events. */
export async function* parseSSE<T>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const json = line.slice(5).trim();
      if (json) yield JSON.parse(json) as T;
    }
  }
}

// The generated route table is the machine-readable API surface. Ergonomic
// wrappers above stay hand-written; path construction and drift checks use this.
export {
  ROUTES as API_ROUTES,
  buildPath as buildApiPath,
} from "./generated/routes.js";
export type {
  HttpMethod,
  RouteId,
  RouteSpec,
  StreamKind,
} from "./generated/routes.js";
