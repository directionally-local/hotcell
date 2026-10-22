import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProviderKeyMap } from "./keystore.js";

// Build-time artifacts (the VZ helper binary, guest kernels, rootfs images) live
// in the source tree under helpers/ and do NOT ship in the published npm package.
// Anchor their path defaults to this module's location so they resolve the same
// no matter what directory the daemon is launched from — a bare "helpers/…"
// default resolves against process.cwd() and so only works when the daemon is
// started from the repo root (users who `npm i -g hotcell` and run from $HOME hit
// a path that never exists).
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// .../packages/daemon/{src,dist}/config.js → the repo root is three levels up.
const REPO_ROOT = resolve(MODULE_DIR, "..", "..", "..");
const repoAsset = (rel: string): string => join(REPO_ROOT, rel);

/**
 * True only when running from a source checkout — detected by the VZ helper's
 * Swift package sitting next to us. In an npm install those build artifacts
 * aren't present, so the microVM drivers report they're unavailable and steer
 * the user to Docker rather than suggesting a `npm run build:vz` they can't run.
 */
export const RUNNING_FROM_SOURCE = existsSync(
  join(REPO_ROOT, "helpers", "hotcell-vz", "Package.swift"),
);

/**
 * Persisted daemon config, written by `hotcell setup` (or by hand). Lives at
 * `${HOTCELL_HOME || ~/.hotcell}/config.json` — the same home convention as the
 * keystore — and holds env-style keys with string values, e.g.
 * `{"HOTCELL_HOST":"0.0.0.0","HOTCELL_EGRESS_ENFORCE":"true"}`, so the file is
 * literally "persisted env": same names, same parsing, self-documenting.
 * Missing file → empty; malformed file → warn once and ignore (env/defaults apply).
 */
export const CONFIG_FILE = join(
  process.env.HOTCELL_HOME || join(homedir(), ".hotcell"),
  "config.json",
);
/** Read the persisted config fresh (used by hot-reload paths); never throws. */
function readFileConfig(): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_FILE, "utf8");
  } catch {
    return {}; // no file — the normal case
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const out: Record<string, string> = {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          out[k] = String(v);
        }
      }
    }
    return out;
  } catch {
    console.error(`[hotcell] ignoring malformed ${CONFIG_FILE} (not valid JSON)`);
    return {};
  }
}

/** Snapshot read once at startup for scalar settings (`env()` precedence). */
const fileConfig: Record<string, string> = readFileConfig();

/**
 * Read a daemon config value, highest precedence first: `HOTCELL_<name>` env,
 * legacy pre-rename `SBX_<name>` env, then the persisted config file. Callers
 * append their own `?? <default>`, completing env > file > defaults.
 */
function env(name: string): string | undefined {
  return (
    process.env[`HOTCELL_${name}`] ??
    process.env[`SBX_${name}`] ??
    fileConfig[`HOTCELL_${name}`]
  );
}

/**
 * Root for daemon state (db, backups, VM state, image caches): `~/.hotcell`,
 * except when a pre-rename `~/.sbx` already exists and `~/.hotcell` doesn't —
 * then the legacy root keeps being used so existing installs keep their data.
 */
function stateRoot(): string {
  const modern = join(homedir(), ".hotcell");
  const legacy = join(homedir(), ".sbx");
  if (!existsSync(modern) && existsSync(legacy)) return legacy;
  return modern;
}

// Daemon configuration, all overridable via environment variables.
export interface Config {
  host: string;
  port: number;
  /**
   * Default OCI image for new sandboxes. Defaults to a small Debian-based
   * Python image (ships /bin/bash + python3) so the vertical slice works with
   * zero local image builds. Build images/base and set SBX_IMAGE=sbx/base:latest
   * for the richer toolset (Node 22, git, ripgrep, …).
   */
  defaultImage: string;
  /**
   * Runtime driver to use: `container` (Docker, the only built impl),
   * `firecracker` (Linux microVM, Phase 3), or `applevz` (macOS microVM, Phase 3).
   * Selects the isolation tier; the daemon/SDK/CLI are unchanged across drivers.
   */
  driver: string;
  /** Default per-sandbox memory cap in MiB for new sandboxes (`0` = unlimited). */
  defaultMemoryMb: number;
  /** Default per-sandbox CPU cap in fractional cores (`0` = unlimited). */
  defaultCpus: number;
  /** Default per-sandbox process/thread cap for new sandboxes (`0` = unlimited). */
  defaultPidsLimit: number;
  /** Maximum simultaneous cold microVM creates (`0` = unlimited). */
  microvmBootConcurrency: number;
  /** Maximum time a microVM create waits for a boot slot (`0` = unlimited). */
  microvmBootQueueTimeoutMs: number;
  /**
   * Admission control: `enforce` rejects `create` when the host's memory budget
   * is exhausted (prevents over-subscription / OOM when launching many
   * sandboxes); `off` only reports capacity. Default `enforce`.
   */
  admission: "enforce" | "off";
  /** Host memory budget in MiB for admission (`0` = auto-detect from the runtime). */
  hostMemoryMb: number;
  /** Host CPU budget for the capacity view (`0` = auto-detect from the runtime). */
  hostCpus: number;
  /** Memory over-commit factor applied to the host budget (e.g. `1.5` to oversubscribe). */
  overcommit: number;
  /**
   * Admission **floor** (MiB) charged for an uncapped sandbox that's just started
   * or not yet sampled. Once the metrics sampler sees it, admission uses its
   * measured RSS instead (usage-based). Capped sandboxes use their cap.
   */
  defaultReservationMb: number;
  /** Bind host for the preview-URL reverse proxy. */
  proxyHost: string;
  /** Port for the preview-URL reverse proxy (separate from the REST API). */
  proxyPort: number;
  /**
   * Bind host for the egress credential proxy (LLM gateway). Defaults to
   * loopback (single-tenant safe). On **native Linux** dockerd, sandboxes reach
   * the daemon via the bridge gateway (`host.docker.internal` → ~172.17.0.1), so
   * a loopback-only bind is unreachable from sandboxes — set `HOTCELL_EGRESS_HOST`
   * to `0.0.0.0` (or the bridge IP) there, relying on the per-sandbox egress
   * token + host firewall. Docker Desktop (macOS) reaches loopback as-is.
   */
  egressHost: string;
  /** Port for the egress credential proxy. `0` disables it. */
  egressPort: number;
  /**
   * Enforce default-deny egress: put sandboxes on a dedicated bridge network and
   * (Linux only) install host `DOCKER-USER` iptables rules so the ONLY reachable
   * destinations are the egress gateway + the pinned DNS resolver — everything else
   * is dropped. Off by default (the gateway is then the "safe path available", not
   * the "only path"). `HOTCELL_EGRESS_ENFORCE`. Advisory-only on macOS Docker Desktop.
   */
  egressEnforce: boolean;
  /** Docker network name sandboxes join when egress is enforced. `HOTCELL_EGRESS_NETWORK`. */
  egressNetwork: string;
  /**
   * IPv4 subnet (CIDR) for the egress-enforced bridge network. The host firewall
   * scopes its allow/deny rules to this subnet, and the bridge gateway (`.1`) is the
   * sandbox's route to the egress gateway. `/24` assumed. `HOTCELL_EGRESS_SUBNET`.
   */
  egressSubnet: string;
  /**
   * DNS resolver IP pinned into sandboxes under egress enforcement (so DNS can't be
   * used as an exfil channel and DoH is the only blocked path). Empty = Docker's
   * embedded resolver. `HOTCELL_EGRESS_DNS`.
   */
  egressDnsResolver: string;
  /**
   * Path to a JSON `{ allow, deny }` allowlist that fully REPLACES the built-in
   * default (forward-proxy host allowlist). `HOTCELL_ALLOWLIST_FILE`. Empty = defaults.
   */
  allowlistFile: string;
  /** Extra hosts appended to the allowlist (`HOTCELL_ALLOWLIST_EXTRA`, comma-separated). */
  allowlistExtra: string[];
  /**
   * Include the `source_control` allowlist tier (github/gitlab/bitbucket). On by
   * default so `git clone` works; set `HOTCELL_ALLOW_SOURCE_CONTROL=false` for
   * high-security workloads (a writable git host is also an exfil channel).
   */
  allowSourceControl: boolean;
  /**
   * Default per-sandbox LLM spend ceiling in USD — the gateway returns 402 once a
   * sandbox's cumulative provider cost reaches it, across all its tokens. Per-create
   * `egressSpendCapUsd` overrides. `0` = unlimited. `HOTCELL_EGRESS_SPEND_CAP`.
   */
  egressSpendCapUsd: number;
  /**
   * Hostname advertised in egress base URLs returned to clients. Sandboxes reach
   * the daemon host through this name, so on Docker Desktop it defaults to
   * `host.docker.internal`. Set to a LAN IP/DNS name for remote sandboxes.
   */
  egressAdvertiseHost: string;
  /**
   * Provider API keys, held on the daemon host and injected into outbound calls
   * so they never live inside a sandbox. Keyed by lower-case provider name
   * (`openai`, `anthropic`, `openrouter`). A provider's gateway route exists only
   * when its key is present here. Sourced from `HOTCELL_PROVIDER_KEY_<NAME>` env vars.
   */
  providerKeys: Record<string, string>;
  /**
   * Operator-defined / override provider shapes, keyed by lower-case provider
   * name. Lets an operator add a provider the daemon doesn't ship (or repoint a
   * built-in — e.g. route `openai` through a Cloudflare AI Gateway prefix) without
   * a code change. Sourced from `HOTCELL_PROVIDER_<NAME>_BASEURL` / `_AUTHHEADER` /
   * `_FORMAT`. A route still requires a key (`HOTCELL_PROVIDER_KEY_<NAME>`).
   */
  providerConfigs: Record<string, ProviderConfig>;
  /** Host directory where sandbox backup tarballs + metadata are stored. */
  backupDir: string;
  /**
   * Path to the embedded SQLite database holding durable control-plane state
   * (sandbox/process/session/context/exposed-port records). Survives daemon
   * restarts. Set to `:memory:` for an ephemeral, in-process store.
   */
  dbPath: string;
  /**
   * Default idle timeout (ms) applied to new sandboxes that don't specify their
   * own `sleepAfter`. The reaper auto-pauses a sandbox after this long without
   * activity. `0` (the default) disables auto-pause.
   */
  defaultSleepAfterMs: number;
  /** How often (ms) the idle reaper scans for sandboxes to auto-pause. */
  reapIntervalMs: number;
  /** How often (ms) the metrics sampler integrates per-sandbox usage. `0` disables it. */
  metricsIntervalMs: number;
  /** Cost-meter rate: currency units per vCPU-hour. */
  costCpuPerHour: number;
  /** Cost-meter rate: currency units per GB-hour of memory. */
  costMemGbPerHour: number;
  /** Cost-meter rate: currency units per GB of preview-proxy egress. */
  costEgressPerGb: number;
  /**
   * Path to a JSON model→price override file (`HOTCELL_MODEL_PRICES`), overlaid on the
   * built-in table. Used to compute an LLM call's USD cost when the provider does
   * not report one. Empty = built-in defaults only.
   */
  modelPricesPath: string;
  /**
   * Path to the signed `sbx-vz` Swift helper for the Apple VZ driver (`HOTCELL_DRIVER=applevz`).
   * Built by `npm run build:vz`. Defaults to its in-repo build output; set
   * `HOTCELL_VZ_HELPER_PATH` to a bundled/installed location. `HOTCELL_DRIVER=container` ignores it.
   */
  vzHelperPath: string;
  /** Guest kernel image for the Apple VZ driver (`HOTCELL_VZ_KERNEL`). Uncompressed arm64 Image. */
  vzKernel: string;
  /** Base rootfs image for the Apple VZ driver (`HOTCELL_VZ_ROOTFS`). */
  vzRootfs: string;
  /** Per-sandbox VM state dir (disks, sockets) for the Apple VZ driver (`HOTCELL_VZ_STATE_DIR`). */
  vzStateDir: string;
  /** Default workspace disk size in GiB for a new VZ sandbox (`HOTCELL_VZ_DISK_GB`). */
  vzDiskGb: number;
  /**
   * Cache dir for OCI→ext4 converted rootfs images + the blank workspace template
   * (`HOTCELL_VZ_IMAGE_CACHE`). Keyed by image name; populated on demand from
   * `HOTCELL_IMAGE`. Kept separate from the per-sandbox state dir so it survives.
   */
  vzImageCacheDir: string;
  /**
   * Warm-pool size for the Apple VZ driver (`HOTCELL_VZ_WARM_POOL`, default 0 = off):
   * keep this many base-image microVMs pre-booted so a `create` of the base image
   * is an instant adopt instead of a ~2s cold boot. The pool refills in the
   * background as guests are claimed.
   */
  vzWarmPool: number;
  /** `firecracker` binary path for the Firecracker driver (`HOTCELL_FC_BIN`). */
  fcBin: string;
  /** Guest kernel (uncompressed vmlinux) for the Firecracker driver (`HOTCELL_FC_KERNEL`). */
  fcKernel: string;
  /** Prebuilt base rootfs for the Firecracker driver (`HOTCELL_FC_ROOTFS`). */
  fcRootfs: string;
  /** Per-sandbox VM state dir for the Firecracker driver (`HOTCELL_FC_STATE_DIR`). */
  fcStateDir: string;
  /** Default workspace disk size in GiB for a new Firecracker sandbox (`HOTCELL_FC_DISK_GB`). */
  fcDiskGb: number;
  /**
   * Warm-pool size for the Firecracker driver (`HOTCELL_FC_WARM_POOL`, default 0 = off):
   * keep N pre-booted spare microVMs of the default image so a plain create
   * adopts one instantly instead of cold-booting.
   */
  fcWarmPool: number;
  /** Converted OCI→ext4 rootfs cache for the Firecracker driver (`HOTCELL_FC_IMAGE_CACHE`). */
  fcImageCacheDir: string;
  /** Minimum level emitted by the structured logger. */
  logLevel: LogLevel;
  /** Log encoding: `json` (one JSON object per line) or `pretty` (human). */
  logFormat: LogFormat;
  /**
   * API key required on every REST call (except `/healthz` and the dashboard
   * HTML). Empty string (the default) disables auth — loopback, single-tenant.
   */
  apiKey: string;
  /**
   * Shared OTLP/HTTP endpoint for traces and audit logs (e.g. `http://localhost:4318`).
   * Spans export to `/v1/traces`; audit records export to `/v1/logs`. Empty disables
   * trace export and is the audit fallback when no audit-specific override is set.
   */
  otlpEndpoint: string;
  /** Headers shared by OTLP exporters, parsed from `HOTCELL_OTLP_HEADERS`. */
  otlpHeaders: Record<string, string>;
  /** Audit-only endpoint override; `HOTCELL_OTEL_ENDPOINT` remains a legacy alias. */
  auditOtlpEndpoint: string;
  /** Audit-only headers; `HOTCELL_OTEL_HEADERS` remains a legacy override. */
  auditOtlpHeaders: Record<string, string>;
  /** Local append-only JSONL audit log path; empty disables local persistence. */
  auditPath: string;
  /** How many of the most recent metric samples per sandbox to retain in memory. */
  metricsHistory: number;
  /** How many of the most recent finished spans to retain in memory for `/traces`. */
  traceRing: number;
  /**
   * Maximum accepted request body size in bytes (REST + egress gateway). Caps
   * memory use from a single request. Must stay large enough for base64-encoded
   * file writes. `HOTCELL_MAX_BODY_BYTES`, default 32 MiB.
   */
  maxBodyBytes: number;
  /**
   * Extra Host header values accepted by the API server, beyond the loopback
   * names and `host`. The Host allowlist is a DNS-rebinding / localhost-CSRF
   * guard. `HOTCELL_ALLOWED_HOSTS` (comma-separated). Empty by default.
   */
  allowedHosts: string[];
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "json" | "pretty";

/** Operator-supplied provider shape (base URL + auth header + key-format template). */
export interface ProviderConfig {
  baseUrl?: string;
  /** Header the provider authenticates with (e.g. `authorization`, `x-api-key`). */
  authHeader?: string;
  /** Auth-header value template; `{key}` is replaced with the real key (e.g. `Bearer {key}`). */
  formatTemplate?: string;
}

export function loadConfig(): Config {
  return {
    host: env("HOST") ?? "127.0.0.1",
    port: Number(env("PORT") ?? 4750),
    defaultImage: env("IMAGE") ?? "ghcr.io/sinameraji/hotcell-base:latest",
    driver: env("DRIVER") ?? "container",
    defaultMemoryMb: Number(env("DEFAULT_MEMORY_MB") ?? 0),
    defaultCpus: Number(env("DEFAULT_CPUS") ?? 0),
    defaultPidsLimit: Number(env("DEFAULT_PIDS") ?? 0),
    microvmBootConcurrency: Number(env("MICROVM_BOOT_CONCURRENCY") ?? 4),
    microvmBootQueueTimeoutMs: Number(env("MICROVM_BOOT_QUEUE_TIMEOUT_MS") ?? 120000),
    admission: env("ADMISSION") === "off" ? "off" : "enforce",
    hostMemoryMb: Number(env("HOST_MEMORY_MB") ?? 0),
    hostCpus: Number(env("HOST_CPUS") ?? 0),
    overcommit: Number(env("OVERCOMMIT") ?? 1),
    defaultReservationMb: Number(env("DEFAULT_RESERVATION_MB") ?? 256),
    proxyHost: env("PROXY_HOST") ?? "127.0.0.1",
    proxyPort: Number(env("PROXY_PORT") ?? 4751),
    egressHost: env("EGRESS_HOST") ?? "127.0.0.1",
    egressPort: Number(env("EGRESS_PORT") ?? 4752),
    egressAdvertiseHost: env("EGRESS_ADVERTISE_HOST") ?? "host.docker.internal",
    egressEnforce: env("EGRESS_ENFORCE") === "true",
    egressNetwork: env("EGRESS_NETWORK") ?? "hotcell-egress",
    egressSubnet: env("EGRESS_SUBNET") ?? "10.200.0.0/24",
    egressDnsResolver: env("EGRESS_DNS") ?? "",
    allowlistFile: env("ALLOWLIST_FILE") ?? "",
    allowlistExtra: (env("ALLOWLIST_EXTRA") ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
    allowSourceControl: env("ALLOW_SOURCE_CONTROL") !== "false",
    egressSpendCapUsd: Number(env("EGRESS_SPEND_CAP") ?? 0),
    providerKeys: loadProviderKeys(),
    providerConfigs: loadProviderConfigs(),
    backupDir: env("BACKUP_DIR") ?? join(stateRoot(), "backups"),
    dbPath: env("DB") ?? join(stateRoot(), "state.db"),
    defaultSleepAfterMs: Number(env("SLEEP_AFTER_MS") ?? 0),
    reapIntervalMs: Number(env("REAP_INTERVAL_MS") ?? 15000),
    metricsIntervalMs: Number(env("METRICS_INTERVAL_MS") ?? 10000),
    costCpuPerHour: Number(env("COST_CPU_PER_HOUR") ?? 0.05),
    costMemGbPerHour: Number(env("COST_MEM_GB_PER_HOUR") ?? 0.005),
    costEgressPerGb: Number(env("COST_EGRESS_PER_GB") ?? 0.01),
    modelPricesPath: env("MODEL_PRICES") ?? "",
    vzHelperPath: env("VZ_HELPER_PATH") ?? repoAsset("helpers/hotcell-vz/dist/hotcell-vz"),
    vzKernel: env("VZ_KERNEL") ?? repoAsset("helpers/hotcell-vz/guest/vmlinux-vz"),
    vzRootfs: env("VZ_ROOTFS") ?? repoAsset("helpers/hotcell-vz/guest/rootfs.img"),
    vzStateDir: env("VZ_STATE_DIR") ?? join(stateRoot(), "vz"),
    vzDiskGb: Number(env("VZ_DISK_GB") ?? 4),
    vzImageCacheDir: env("VZ_IMAGE_CACHE") ?? join(stateRoot(), "vz", "images"),
    vzWarmPool: Number(env("VZ_WARM_POOL") ?? 0),
    fcBin: env("FC_BIN") ?? "firecracker",
    fcKernel: env("FC_KERNEL") ?? repoAsset("helpers/hotcell-vz/guest/vmlinux-fc"),
    fcRootfs: env("FC_ROOTFS") ?? repoAsset("helpers/hotcell-vz/guest/rootfs.img"),
    fcStateDir: env("FC_STATE_DIR") ?? join(stateRoot(), "fc"),
    fcDiskGb: Number(env("FC_DISK_GB") ?? 8),
    fcWarmPool: Number(env("FC_WARM_POOL") ?? 0),
    fcImageCacheDir: env("FC_IMAGE_CACHE") ?? join(stateRoot(), "fc", "images"),
    logLevel: parseLogLevel(env("LOG_LEVEL")),
    logFormat: env("LOG_FORMAT") === "json" ? "json" : "pretty",
    apiKey: env("API_KEY") ?? "",
    otlpEndpoint: (env("OTLP_ENDPOINT") ?? "").replace(/\/$/, ""),
    otlpHeaders: parseHeaders(env("OTLP_HEADERS")),
    // Canonical OTLP endpoint/headers are shared; the older OTEL_* settings
    // remain audit-specific overrides for backward compatibility.
    auditOtlpEndpoint: (env("OTEL_ENDPOINT") ?? env("OTLP_ENDPOINT") ?? "").replace(/\/$/, ""),
    auditOtlpHeaders: parseHeaders(env("OTEL_HEADERS") ?? env("OTLP_HEADERS")),
    auditPath: env("AUDIT_FILE") ?? join(stateRoot(), "audit.jsonl"),
    metricsHistory: Number(env("METRICS_HISTORY") ?? 60),
    traceRing: Number(env("TRACE_RING") ?? 200),
    maxBodyBytes: Number(env("MAX_BODY_BYTES") ?? 32 * 1024 * 1024),
    allowedHosts: (env("ALLOWED_HOSTS") ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  };
}

/**
 * Collect provider keys from every backend (file `~/.hotcell/keys.json`, the
 * macOS keychain, and `HOTCELL_PROVIDER_KEY_<NAME>` / legacy `SBX_` env vars —
 * env wins). See `keystore.ts`. Re-called on hot-reload after `hotcell keys …`.
 */
function loadProviderKeys(): Record<string, string> {
  return loadProviderKeyMap();
}

/**
 * Collect operator-defined provider shapes from `HOTCELL_PROVIDER_<NAME>_<FIELD>` env
 * vars (FIELD ∈ BASEURL/AUTHHEADER/FORMAT), skipping the `HOTCELL_PROVIDER_KEY_*`
 * namespace. The provider name is lower-cased; e.g.
 * `HOTCELL_PROVIDER_CFOPENAI_BASEURL=https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/openai`
 * defines a `cfopenai` route (pair with `HOTCELL_PROVIDER_KEY_CFOPENAI`).
 */
export function loadProviderConfigs(): Record<string, ProviderConfig> {
  const out: Record<string, ProviderConfig> = {};
  // The persisted config file is scanned first and re-read each call, so a shape
  // captured by `hotcell keys add`/`import` applies on the next hot-reload
  // without a daemon restart; env still overrides it, matching `env()`.
  const sources: Record<string, string | undefined>[] = [readFileConfig(), process.env];
  // Legacy prefix scanned first so HOTCELL_ overwrites on conflict.
  for (const source of sources) {
  for (const prefix of ["SBX_PROVIDER_", "HOTCELL_PROVIDER_"]) {
    for (const [name, value] of Object.entries(source)) {
      if (!name.startsWith(prefix) || !value) continue;
      if (name.startsWith("SBX_PROVIDER_KEY_") || name.startsWith("HOTCELL_PROVIDER_KEY_")) continue;
      const rest = name.slice(prefix.length); // <NAME>_<FIELD>
      const us = rest.lastIndexOf("_");
      if (us <= 0) continue;
      const provName = rest.slice(0, us).toLowerCase();
      const field = rest.slice(us + 1).toUpperCase();
      const cfg = (out[provName] ??= {});
      if (field === "BASEURL") cfg.baseUrl = value;
      else if (field === "AUTHHEADER") cfg.authHeader = value.toLowerCase();
      else if (field === "FORMAT") cfg.formatTemplate = value;
    }
  }
  }
  return out;
}

function parseHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    console.error("[hotcell] ignoring malformed HOTCELL_OTEL_HEADERS (expected JSON object)");
    return {};
  }
}

function parseLogLevel(value: string | undefined): LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
    ? value
    : "info";
}

/**
 * Build the preview URL for an exposed port. Uses a `*.localhost` subdomain,
 * which browsers resolve to 127.0.0.1 with zero DNS/hosts config. Sandbox ids
 * are dash-free hex, so `<id>-<port>` is an unambiguous label.
 */
export function previewUrl(config: Config, sandboxId: string, port: number): string {
  return `http://${sandboxId}-${port}.localhost:${config.proxyPort}/`;
}
