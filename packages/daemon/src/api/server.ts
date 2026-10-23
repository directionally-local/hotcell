import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { audit, redactCommandForAudit } from "../audit.js";
import type { Duplex } from "node:stream";
import { type BackupInfo, BackupRegistry } from "../backups.js";
import { previewUrl, type Config } from "../config.js";
import type { Driver, TerminalSession } from "../driver/types.js";
import { kernelFor, type KernelLanguage } from "../kernels.js";
import { pauseSandbox, resumeSandbox } from "../lifecycle.js";
import { CapacityError } from "../capacity.js";
import type { Capacity } from "../capacity.js";
import type { BootScheduler } from "../boot-scheduler.js";
import { computeCost } from "../cost.js";
import { log } from "../logger.js";
import type { MetricsHistory } from "../metrics.js";
import { recentSpans, startSpan } from "../tracing.js";
import { buildProviders } from "../proxy/egress.js";
import { DRIVER_NAMES } from "../driver/index.js";
import { emptyUsage, SandboxStore } from "../store.js";
import { acceptWebSocket } from "./ws.js";
import {
  BodyTooLargeError,
  errorMessage,
  readBodyCapped,
  safeEqual,
  sendJson,
  shellEscape,
} from "../util.js";
import { DASHBOARD_HTML } from "../web/dashboard.js";
import type {
  CodeContextInfo,
  CodeResult,
  EgressPolicy,
  ExecEvent,
  ExposedPort,
  ProcessInfo,
  ResourceLimits,
  SandboxRecord,
  SessionInfo,
} from "../types.js";
import { readFileSync } from "node:fs";

/** Daemon package version, surfaced on /healthz + /info so the CLI can flag CLI↔daemon drift. */
const DAEMON_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string) ?? "unknown";
  } catch {
    return "unknown";
  }
})();

interface Deps {
  config: Config;
  driver: Driver;
  store: SandboxStore;
  backups: BackupRegistry;
  history?: MetricsHistory;
  capacity?: Capacity;
  bootScheduler?: BootScheduler;
  /** Re-read provider keys (file/keychain/env) and hot-swap the egress gateway. */
  reloadKeys?: () => { providers: number };
}

/**
 * Phase 0/1 REST surface:
 *   GET    /healthz
 *   POST   /sandboxes                      -> create ({detach: true} returns a `creating` record immediately; poll GET /sandboxes/:id)
 *   GET    /sandboxes                      -> list
 *   GET    /sandboxes/:id                  -> get
 *   DELETE /sandboxes/:id                  -> destroy (removes volume too)
 *   GET    /sandboxes/:id/metrics          -> live stats + cumulative usage + cost
 *   POST   /sandboxes/:id/stop             -> stop (remove container, keep volume)
 *   POST   /sandboxes/:id/pause            -> fast-pause (memory snapshot on microVM drivers; else stop-with-volume); any op auto-resumes
 *   POST   /sandboxes/:id/start            -> start (recreate container, reattach volume)
 *   POST   /sandboxes/:id/backups          -> back up /workspace, returns BackupInfo
 *   GET    /sandboxes/:id/backups          -> list this sandbox's backups
 *   POST   /sandboxes/:id/restore          -> restore /workspace from {backupId}
 *   GET    /backups                        -> list all backups
 *   DELETE /backups/:backupId              -> delete a backup
 *   POST   /sandboxes/:id/code-contexts        -> create a code-interpreter context
 *   GET    /sandboxes/:id/code-contexts        -> list code contexts
 *   DELETE /sandboxes/:id/code-contexts/:ctxId -> destroy a code context
 *   POST   /sandboxes/:id/run-code             -> run code, returns CodeResult
 *   POST   /sandboxes/:id/exec             -> run command, stream output as SSE
 *   POST   /sandboxes/:id/files/write      -> write file
 *   POST   /sandboxes/:id/files/read       -> read file
 *   POST   /sandboxes/:id/files/mkdir      -> create directory
 *   POST   /sandboxes/:id/files/list       -> list directory
 *   GET    /sandboxes/:id/watch            -> stream file-change events (SSE)
 *   GET    /sandboxes/:id/terminal         -> interactive PTY shell (WebSocket upgrade)
 *   GET    /sandboxes/:id/metrics/history  -> recent live-metrics samples (sparklines)
 *   POST   /sandboxes/:id/egress-tokens         -> mint an egress (LLM gateway) token
 *   GET    /sandboxes/:id/egress-tokens         -> list egress tokens + provider URLs
 *   DELETE /sandboxes/:id/egress-tokens/:token  -> revoke an egress token
 *   GET    /traces                         -> recent finished trace spans
 *   POST   /sandboxes/:id/processes              -> start background process
 *   GET    /sandboxes/:id/processes              -> list processes
 *   DELETE /sandboxes/:id/processes/:procId      -> signal/kill process
 *   GET    /sandboxes/:id/processes/:procId/logs -> stream logs (SSE)
 *   POST   /sandboxes/:id/wait-port              -> wait for a TCP port
 *   POST   /sandboxes/:id/expose                 -> expose a port (preview URL)
 *   GET    /sandboxes/:id/expose                 -> list exposed ports
 *   DELETE /sandboxes/:id/expose/:port           -> unexpose a port
 *   GET    /sandboxes/:id/env                     -> get sandbox env vars
 *   POST   /sandboxes/:id/env                     -> merge sandbox env vars
 *   POST   /sandboxes/:id/sessions               -> create a session
 *   GET    /sandboxes/:id/sessions               -> list sessions
 *   DELETE /sandboxes/:id/sessions/:sid          -> delete a session
 *   POST   /sandboxes/:id/sessions/:sid/env      -> merge session env vars
 */
export function createApiServer(deps: Deps) {
  const server = createServer((req, res) => {
    const method = req.method ?? "GET";
    const rawPath = (req.url ?? "/").split("?")[0];
    // One server span per request — the create→exec→destroy trace the plan asks
    // for falls out naturally (route is normalized so ids don't explode names).
    const span = startSpan(`${method} ${normalizeRoute(rawPath)}`, {
      "http.method": method,
      "http.target": rawPath,
    });
    const startedMs = Date.now();
    res.on("finish", () => {
      span.setAttribute("http.status_code", res.statusCode);
      if (res.statusCode >= 500) span.setStatus("error");
      span.end();
      const line = {
        method,
        path: rawPath,
        status: res.statusCode,
        durMs: Date.now() - startedMs,
        traceId: span.traceId,
      };
      if (res.statusCode >= 500) log.error("request", line);
      else log.info("request", line);
    });
    handle(req, res, deps).catch((err) => {
      span.setStatus("error").setAttribute("error", String(err?.message ?? err));
      if (err instanceof BodyTooLargeError) {
        return sendJson(res, 413, { error: "request body too large" });
      }
      sendJson(res, 500, { error: String(err?.message ?? err) });
    });
  });
  // Live terminal: a WebSocket upgrade bridged to an in-sandbox PTY.
  server.on("upgrade", (req, socket, head) => {
    handleTerminalUpgrade(req, socket as Duplex, head, deps).catch(() => socket.destroy());
  });
  return server;
}

/** Pull a Bearer token from the Authorization header, if present. */
function bearerFromHeader(req: IncomingMessage): string | undefined {
  const header = req.headers["authorization"];
  return typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice(7)
    : undefined;
}

/**
 * Handle a WebSocket upgrade for `GET /sandboxes/:id/terminal`: authenticate,
 * resolve (and auto-resume) the sandbox, open a PTY, and splice bytes both ways.
 * Inbound binary frames are stdin; inbound text frames are control JSON (resize).
 * Browsers can't set headers on a WebSocket, so the API key may arrive as `?key=`.
 */
async function handleTerminalUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: Deps,
): Promise<void> {
  const { config, driver, store, capacity } = deps;
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const match = url.pathname.match(/^\/sandboxes\/([^/]+)\/terminal$/);
  if (!match) {
    socket.destroy();
    return;
  }
  if (!isAllowedHost(req, config)) {
    auditAccessDenied("auth.host_rejected", "GET", url.pathname, "host_not_allowed", driver, store);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  if (isCrossSiteBrowserRequest(req, url.pathname)) {
    auditAccessDenied("auth.cross_site_rejected", "GET", url.pathname, "cross_site_request", driver, store);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  if (config.apiKey) {
    const provided = url.searchParams.get("key") ?? bearerFromHeader(req);
    if (!provided || !safeEqual(provided, config.apiKey)) {
      auditAccessDenied("auth.rejected", "GET", url.pathname, "invalid_api_key", driver, store);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
  }
  const id = match[1];
  const record = store.get(id);
  if (!record) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  if (record.status === "stopped" || record.status === "creating" || record.status === "error") {
    socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
    socket.destroy();
    return;
  }
  if (record.status === "paused") {
    try {
      await resumeSandbox(driver, store, record, capacity);
    } catch (err) {
      if (err instanceof CapacityError) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }
      throw err;
    }
  } else {
    store.touch(id);
  }

  const ws = acceptWebSocket(req, socket, head);
  if (!ws) return;

  const cols = Number(url.searchParams.get("cols")) || 80;
  const rows = Number(url.searchParams.get("rows")) || 24;
  const span = startSpan("WS /sandboxes/:id/terminal", { "sandbox.id": id });

  let term: TerminalSession;
  try {
    term = await driver.openTerminal(id, { cols, rows, env: record.env });
  } catch (err) {
    audit({ event: "sandbox.terminal.open.failed", sandboxId: id, driver: record.driver ?? driver.name });
    ws.send(`\r\n[sbx] failed to open terminal: ${errorMessage(err)}\r\n`);
    ws.close();
    span.setStatus("error").end();
    return;
  }
  audit({ event: "sandbox.terminal.open", sandboxId: id, driver: record.driver ?? driver.name });
  log.info("terminal opened", { sandbox: id, traceId: span.traceId });

  term.stream.on("data", (chunk: Buffer) => ws.send(chunk));
  term.stream.on("end", () => ws.close());
  term.stream.on("error", () => ws.close());

  ws.onMessage((data, isBinary) => {
    if (isBinary) {
      term.stream.write(data);
      store.touch(id);
      return;
    }
    try {
      const msg = JSON.parse(data.toString("utf8"));
      if (msg && msg.type === "resize") {
        term.resize(Number(msg.cols) || cols, Number(msg.rows) || rows);
      }
    } catch {
      // Non-JSON text frames are ignored; keystrokes arrive as binary frames.
    }
  });

  ws.onClose(() => {
    term.close();
    audit({ event: "sandbox.terminal.close", sandboxId: id, driver: record.driver ?? driver.name });
    span.end();
    log.info("terminal closed", { sandbox: id });
  });
}

/**
 * Build the egress-gateway client config for a token: per-provider base URLs the
 * sandbox points its SDK at, plus suggested env vars. The token is used in place
 * of each provider's real API key (the daemon swaps it for the real one).
 */
function egressConfig(config: Config, advertiseHost?: string) {
  const base = `http://${advertiseHost ?? config.egressAdvertiseHost}:${config.egressPort}`;
  const names = Object.keys(buildProviders(config));
  const ENV_HINT: Record<string, { baseUrlEnv: string; keyEnv: string }> = {
    openai: { baseUrlEnv: "OPENAI_BASE_URL", keyEnv: "OPENAI_API_KEY" },
    anthropic: { baseUrlEnv: "ANTHROPIC_BASE_URL", keyEnv: "ANTHROPIC_API_KEY" },
    openrouter: { baseUrlEnv: "OPENROUTER_BASE_URL", keyEnv: "OPENROUTER_API_KEY" },
    google: { baseUrlEnv: "GOOGLE_BASE_URL", keyEnv: "GOOGLE_API_KEY" },
    gemini: { baseUrlEnv: "GEMINI_BASE_URL", keyEnv: "GEMINI_API_KEY" },
  };
  // For custom/operator-defined providers, synthesize conventional env names
  // (`<NAME>_BASE_URL` / `<NAME>_API_KEY`) so auto-wiring still injects something
  // sensible. Operators can ignore these and wire their SDK by hand.
  const providers = names.map((name) => {
    const envName = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const hint = ENV_HINT[name] ?? {
      baseUrlEnv: `${envName}_BASE_URL`,
      keyEnv: `${envName}_API_KEY`,
    };
    return { name, baseUrl: `${base}/${name}`, ...hint };
  });
  return { providers };
}

/**
 * Env vars that point a sandbox's LLM SDKs at the egress gateway, with `token`
 * standing in for each provider's real key. Injected at create time when a
 * sandbox opts into egress, so the gateway is drop-in (no in-sandbox config).
 */
function egressEnv(config: Config, token: string, advertiseHost?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const p of egressConfig(config, advertiseHost).providers) {
    if (p.baseUrlEnv) env[p.baseUrlEnv] = p.baseUrl;
    if (p.keyEnv) env[p.keyEnv] = token;
  }
  return env;
}

/**
 * Whether a sandbox should get `HTTP(S)_PROXY` pointed at the gateway. Always
 * under enforcement; also for egress-wired sandboxes on the microVM drivers,
 * whose guests have no NIC — they are default-deny by construction, so without
 * the proxy env even allowlisted traffic (npm/pip/git through the gateway's
 * forward proxy) dies on DNS before it can reach the loopback→vsock relay.
 */
export function proxyEnvWanted(driverName: string, wantEgress: boolean, enforce: boolean): boolean {
  return enforce || (wantEgress && driverName !== "container");
}

/**
 * Forward-proxy env for a sandbox under egress enforcement: point `HTTP(S)_PROXY`
 * at the gateway (the token is the proxy credential), and exclude the gateway host
 * + loopback via `NO_PROXY` so the sandbox's own LLM base-URL calls (which target
 * the gateway directly, origin-form) don't loop back through the proxy. Lower-case
 * variants too, since many tools (curl, pip, apt) read those.
 */
function proxyEnv(config: Config, token: string, advertiseHost?: string): Record<string, string> {
  const host = advertiseHost ?? config.egressAdvertiseHost;
  // Token as BOTH user and password: many clients (pip/urllib3, some others) only
  // emit `Proxy-Authorization` on a CONNECT when the proxy URL has a non-empty
  // password. The gateway reads the username half, so the password value is moot.
  const proxy = `http://${token}:${token}@${host}:${config.egressPort}`;
  const noProxy = `localhost,127.0.0.1,${host}`;
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

/**
 * Validate + normalise an egress-token policy from a request body. Accepts the
 * `ttlMs` sugar (→ `expiresAt = now + ttlMs`). An empty/blank body yields `{}`
 * (unlimited — the pre-policy default). Returns `{ error }` (→ 400) on bad shape.
 */
function parseEgressPolicy(body: Record<string, unknown>): { policy: EgressPolicy } | { error: string } {
  const policy: EgressPolicy = {};
  const num = (key: string): number | undefined | null => {
    const v = body[key];
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null; // null = invalid
    return v;
  };

  const ttlMs = num("ttlMs");
  if (ttlMs === null) return { error: "ttlMs must be a non-negative number" };
  if (typeof ttlMs === "number" && ttlMs > 0) {
    policy.expiresAt = new Date(Date.now() + ttlMs).toISOString();
  }
  if (typeof body.expiresAt === "string" && body.expiresAt) {
    if (Number.isNaN(Date.parse(body.expiresAt))) return { error: "expiresAt must be an ISO timestamp" };
    policy.expiresAt = body.expiresAt;
  }

  const spendCapUsd = num("spendCapUsd");
  if (spendCapUsd === null) return { error: "spendCapUsd must be a non-negative number" };
  if (typeof spendCapUsd === "number") policy.spendCapUsd = spendCapUsd;

  if (body.rateLimit !== undefined) {
    const r = body.rateLimit as Record<string, unknown>;
    if (typeof r !== "object" || r === null) return { error: "rateLimit must be an object" };
    const windowMs = r.windowMs;
    if (typeof windowMs !== "number" || !Number.isFinite(windowMs) || windowMs <= 0) {
      return { error: "rateLimit.windowMs must be a positive number" };
    }
    const rateLimit: EgressPolicy["rateLimit"] = { windowMs };
    for (const k of ["calls", "tokens"] as const) {
      const v = r[k];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        return { error: `rateLimit.${k} must be a non-negative number` };
      }
      rateLimit[k] = v;
    }
    policy.rateLimit = rateLimit;
  }

  for (const key of ["models", "providers"] as const) {
    const v = body[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) {
      return { error: `${key} must be an array of strings` };
    }
    if (v.length > 0) policy[key] = v as string[];
  }

  return { policy };
}

/**
 * 503 an admission refusal with a `Retry-After` hint. Capacity frees when a
 * sandbox exits, pauses, or is destroyed — usually seconds away under churn —
 * so give well-behaved clients a concrete backoff instead of a bare refusal.
 */
function sendCapacityRefusal(res: ServerResponse, reason: string): void {
  res.setHeader("Retry-After", "5");
  sendJson(res, 503, { error: reason });
}

/**
 * Resolve hard resource caps for a new sandbox: each of `memoryMb`/`cpus`/
 * `pidsLimit` is the per-create body value if given, else the daemon default.
 * Only active (>0) caps are kept, so an unlimited sandbox has `limits: {}`.
 * Returns `{ error }` (→ 400) on an invalid value.
 */
function resolveLimits(
  body: Record<string, unknown>,
  config: Config,
): { limits: ResourceLimits } | { error: string } {
  const read = (key: string): number | undefined => {
    const v = body[key];
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return Number.NaN;
    return v;
  };
  for (const key of ["memoryMb", "cpus", "pidsLimit"]) {
    if (Number.isNaN(read(key))) return { error: `${key} must be a non-negative number` };
  }
  const memoryMb = read("memoryMb") ?? config.defaultMemoryMb;
  const cpus = read("cpus") ?? config.defaultCpus;
  const pidsLimit = read("pidsLimit") ?? config.defaultPidsLimit;
  if (memoryMb > 0 && memoryMb < 6) {
    return { error: "memoryMb must be at least 6 (Docker minimum)" };
  }
  const limits: ResourceLimits = {};
  if (memoryMb > 0) limits.memoryMb = memoryMb;
  if (cpus > 0) limits.cpus = cpus;
  if (pidsLimit > 0) limits.pidsLimit = pidsLimit;
  return { limits };
}

/** Collapse high-cardinality id segments so span/route names stay bounded. */
function normalizeRoute(path: string): string {
  return path
    .replace(/^\/sandboxes\/[^/]+/, "/sandboxes/:id")
    .replace(/\/(processes|sessions|code-contexts|expose|backups|egress-tokens)\/[^/]+/g, "/$1/:sub");
}

/** Audit an access rejection without recording credentials or raw path identifiers. */
function auditAccessDenied(
  event: string,
  method: string,
  path: string,
  reason: string,
  driver: Driver,
  store: SandboxStore,
): void {
  const sandboxId = path.match(/^\/sandboxes\/([^/]+)/)?.[1];
  const record = sandboxId ? store.get(sandboxId) : undefined;
  audit({
    event,
    sandboxId,
    driver: record?.driver ?? driver.name,
    attributes: { method, route: normalizeRoute(path), reason },
  });
}

/**
 * Enforce the API key when one is configured. `/healthz` and the dashboard HTML
 * stay open (probes + first paint, so the dashboard can prompt for the key).
 * Accepts `Authorization: Bearer <key>` or `X-API-Key: <key>`.
 */
function isAuthorized(req: IncomingMessage, config: Config, path: string): boolean {
  if (!config.apiKey) return true;
  // Open: health probes, the dashboard shell, and /info (non-sensitive — it only
  // reports driver/image/cost-rates and whether auth is on, so the dashboard can
  // decide to prompt for a key before making authenticated calls).
  if (path === "/healthz" || path === "/" || path === "/dashboard" || path === "/info") {
    return true;
  }
  const header = req.headers["authorization"];
  const bearer =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice(7)
      : undefined;
  const apiKeyHeader = req.headers["x-api-key"];
  const provided =
    bearer ?? (typeof apiKeyHeader === "string" ? apiKeyHeader : undefined);
  return provided !== undefined && safeEqual(provided, config.apiKey);
}

/**
 * Browser CSRF / cross-site WebSocket guard. Browsers label every request with
 * `Sec-Fetch-Site` (and send `Origin` on non-GET requests and WebSocket
 * upgrades); a page on another origin must never drive this API, even though
 * the API key already stops it. Non-browser clients (CLI, SDKs, curl) send
 * neither header and are unaffected. Top-level navigation to the dashboard
 * shell and health probes stay open so links to the dashboard keep working.
 */
export function isCrossSiteBrowserRequest(req: IncomingMessage, path: string): boolean {
  const method = req.method ?? "GET";
  if ((method === "GET" || method === "HEAD") && (path === "/" || path === "/dashboard" || path === "/healthz")) {
    return false;
  }
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers["origin"];
  if (typeof origin === "string") {
    if (origin === "null") return true;
    try {
      return new URL(origin).host.toLowerCase() !== String(req.headers["host"] ?? "").toLowerCase();
    } catch {
      return true;
    }
  }
  return false;
}

/** A host bound to a loopback interface (the dev default). */
function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * DNS-rebinding / localhost-CSRF guard: when the daemon is bound to loopback,
 * only accept requests whose `Host` header is a loopback name, `config.host`, or
 * an explicit `SBX_ALLOWED_HOSTS` entry — so a website the operator visits can't
 * drive the API via a rebound DNS name. If bound to a non-loopback interface the
 * operator has opted into network exposure, so the guard is skipped (they should
 * set an API key). The preview/egress proxies are separate servers and unaffected.
 */
function isAllowedHost(req: IncomingMessage, config: Config): boolean {
  if (!isLoopbackHost(config.host)) return true;
  const hostHeader = req.headers["host"];
  if (typeof hostHeader !== "string") return false;
  const hostname = hostHeader
    .replace(/:\d+$/, "") // strip port
    .replace(/^\[|\]$/g, "") // strip IPv6 brackets
    .toLowerCase();
  if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") return true;
  if (hostname === config.host.toLowerCase()) return true;
  return config.allowedHosts.some((h) => h.toLowerCase() === hostname);
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Deps,
): Promise<void> {
  const { config, driver, store, backups } = deps;
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (!isAllowedHost(req, config)) {
    auditAccessDenied("auth.host_rejected", method, path, "host_not_allowed", driver, store);
    return sendJson(res, 403, { error: "host not allowed" });
  }

  if (isCrossSiteBrowserRequest(req, path)) {
    auditAccessDenied("auth.cross_site_rejected", method, path, "cross_site_request", driver, store);
    return sendJson(res, 403, { error: "cross-site requests are not allowed" });
  }

  if (!isAuthorized(req, config, path)) {
    auditAccessDenied("auth.rejected", method, path, "invalid_api_key", driver, store);
    res.setHeader("WWW-Authenticate", "Bearer");
    return sendJson(res, 401, { error: "missing or invalid API key" });
  }

  if (method === "GET" && path === "/healthz") {
    try {
      await driver.ping();
      return sendJson(res, 200, { ok: true, driver: driver.name, version: DAEMON_VERSION });
    } catch (err) {
      return sendJson(res, 503, { ok: false, error: String(err) });
    }
  }

  // Daemon info for the dashboard (cost rates, proxy port, driver, image).
  if (method === "GET" && path === "/info") {
    return sendJson(res, 200, {
      version: DAEMON_VERSION,
      driver: driver.name,
      drivers: DRIVER_NAMES,
      defaultImage: config.defaultImage,
      proxyPort: config.proxyPort,
      costCpuPerHour: config.costCpuPerHour,
      costMemGbPerHour: config.costMemGbPerHour,
      costEgressPerGb: config.costEgressPerGb,
      defaultSleepAfterMs: config.defaultSleepAfterMs,
      auth: config.apiKey.length > 0,
      otlp: config.otlpEndpoint.length > 0,
      egressPort: config.egressPort,
      egressProviders: Object.keys(buildProviders(config)),
      defaultMemoryMb: config.defaultMemoryMb,
      defaultCpus: config.defaultCpus,
      defaultPidsLimit: config.defaultPidsLimit,
    });
  }

  const egressTokenIdMatch = path.match(
    /^\/sandboxes\/([^/]+)\/egress-tokens\/([^/]+)$/,
  );
  if (method === "DELETE" && egressTokenIdMatch) {
    if (!store.get(egressTokenIdMatch[1])) return sendJson(res, 404, { error: "not found" });
    const removed = store.removeEgressToken(egressTokenIdMatch[2]);
    if (removed) audit({ event: "gateway.token.revoked", sandboxId: egressTokenIdMatch[1], driver: store.get(egressTokenIdMatch[1])?.driver ?? driver.name, attributes: { "token.raw": egressTokenIdMatch[2] } });
    if (!removed) return sendJson(res, 404, { error: "token not found" });
    return sendJson(res, 200, { token: egressTokenIdMatch[2], revoked: true });
  }

  const egressTokensMatch = path.match(/^\/sandboxes\/([^/]+)\/egress-tokens$/);
  if (egressTokensMatch) {
    const id = egressTokensMatch[1];
    if (!store.get(id)) return sendJson(res, 404, { error: "not found" });
    if (method === "POST") {
      const body = await readJson(req, config.maxBodyBytes);
      const parsed = parseEgressPolicy(body);
      if ("error" in parsed) return sendJson(res, 400, { error: parsed.error });
      const token = SandboxStore.newEgressToken();
      store.addEgressToken(token, id, parsed.policy);
      audit({ event: "gateway.token.minted", sandboxId: id, driver: store.get(id)?.driver ?? driver.name, attributes: { "token.raw": token, providers: (parsed.policy.providers ?? []).join(",") } });
      return sendJson(res, 201, {
        token,
        policy: parsed.policy,
        providers: egressConfig(config).providers,
      });
    }
    if (method === "GET") {
      const tokens = store.listEgressTokens(id).map((r) => ({
        token: r.token,
        policy: r.policy,
        spendUsd: r.spendUsd,
        spendRemaining:
          r.policy.spendCapUsd === undefined
            ? null
            : Math.max(0, r.policy.spendCapUsd - r.spendUsd),
      }));
      return sendJson(res, 200, { tokens, providers: egressConfig(config).providers });
    }
  }

  // Host capacity + admission status (for the dashboard meter + `sb capacity`).
  if (method === "GET" && path === "/capacity") {
    if (!deps.capacity) return sendJson(res, 200, { enforced: false });
    return sendJson(res, 200, {
      ...deps.capacity.snapshot(),
      boot: deps.bootScheduler?.snapshot(),
    });
  }

  // Hot-reload provider keys after `hotcell keys add/rm` — no daemon restart.
  if (method === "POST" && path === "/reload-keys") {
    const r = deps.reloadKeys?.() ?? { providers: 0 };
    return sendJson(res, 200, { ok: true, ...r });
  }

  if (method === "POST" && path === "/audit-events") {
    const body = await readJson(req, config.maxBodyBytes);
    if (body.event !== "keys.import" || !Array.isArray(body.choices) || body.choices.length > 500) {
      return sendJson(res, 400, { error: "invalid audit event payload" });
    }
    const choices = body.choices as unknown[];
    if (!choices.every((choice) => {
      if (!choice || typeof choice !== "object") return false;
      const item = choice as Record<string, unknown>;
      return typeof item.name === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item.name)
        && (item.disposition === "gateway" || item.disposition === "inject" || item.disposition === "skip");
    })) return sendJson(res, 400, { error: "invalid key import choice" });
    const safeChoices = choices as { name: string; disposition: "gateway" | "inject" | "skip" }[];
    audit({ event: "keys.import", driver: driver.name, attributes: {
      "key.count": safeChoices.length,
      "key.names": safeChoices.map((item) => item.name).join(","),
      "key.dispositions": safeChoices.map((item) => `${item.name}=${item.disposition}`).join(","),
    } });
    return sendJson(res, 202, { accepted: true });
  }

  // Recent finished spans, for debugging and the trace view. Newest first.
  if (method === "GET" && path === "/traces") {
    const limit = Number(url.searchParams.get("limit") ?? "100") || 100;
    return sendJson(res, 200, { spans: recentSpans().slice(0, limit) });
  }

  // Embedded single-page dashboard (no build step, zero dependencies).
  if (method === "GET" && (path === "/" || path === "/dashboard")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return void res.end(DASHBOARD_HTML);
  }

  if (method === "POST" && path === "/sandboxes") {
    const body = await readJson(req, config.maxBodyBytes);
    return createSandbox(res, {
      config,
      driver,
      store,
      capacity: deps.capacity,
      bootScheduler: deps.bootScheduler,
    }, body);
  }

  if (method === "GET" && path === "/sandboxes") {
    return sendJson(res, 200, { sandboxes: store.list() });
  }

  const execMatch = path.match(/^\/sandboxes\/([^/]+)\/exec$/);
  if (method === "POST" && execMatch) {
    const body = await readJson(req, config.maxBodyBytes);
    return execInSandbox(res, deps, execMatch[1], body);
  }

  const fileActionMatch = path.match(/^\/sandboxes\/([^/]+)\/files\/(write|read|mkdir|list)$/);
  if (method === "POST" && fileActionMatch) {
    const body = await readJson(req, config.maxBodyBytes);
    return handleFileAction(
      res,
      deps,
      fileActionMatch[1],
      fileActionMatch[2] as "write" | "read" | "mkdir" | "list",
      body,
    );
  }

  const watchMatch = path.match(/^\/sandboxes\/([^/]+)\/watch$/);
  if (method === "GET" && watchMatch) {
    const watchPath = url.searchParams.get("path") ?? "/workspace";
    const intervalMs = Number(url.searchParams.get("interval") ?? "") || undefined;
    return watchFiles(req, res, deps, watchMatch[1], watchPath, intervalMs);
  }

  const procLogsMatch = path.match(
    /^\/sandboxes\/([^/]+)\/processes\/([^/]+)\/logs$/,
  );
  if (method === "GET" && procLogsMatch) {
    return streamLogs(
      req,
      res,
      { driver, store },
      procLogsMatch[1],
      procLogsMatch[2],
      url.searchParams.get("follow") !== "0" &&
        url.searchParams.has("follow"),
    );
  }

  const procIdMatch = path.match(/^\/sandboxes\/([^/]+)\/processes\/([^/]+)$/);
  if (method === "DELETE" && procIdMatch) {
    const body = await readJson(req, config.maxBodyBytes);
    return killProcess(res, { driver, store }, procIdMatch[1], procIdMatch[2], body);
  }

  const procMatch = path.match(/^\/sandboxes\/([^/]+)\/processes$/);
  if (procMatch) {
    if (method === "POST") {
      const body = await readJson(req, config.maxBodyBytes);
      return startProcess(res, deps, procMatch[1], body);
    }
    if (method === "GET") {
      return listProcesses(res, { driver, store }, procMatch[1]);
    }
  }

  const waitPortMatch = path.match(/^\/sandboxes\/([^/]+)\/wait-port$/);
  if (method === "POST" && waitPortMatch) {
    const body = await readJson(req, config.maxBodyBytes);
    return waitForPort(res, deps, waitPortMatch[1], body);
  }

  const exposePortMatch = path.match(/^\/sandboxes\/([^/]+)\/expose\/(\d+)$/);
  if (method === "DELETE" && exposePortMatch) {
    return unexposePort(
      res,
      { store },
      exposePortMatch[1],
      Number(exposePortMatch[2]),
    );
  }

  const exposeMatch = path.match(/^\/sandboxes\/([^/]+)\/expose$/);
  if (exposeMatch) {
    if (method === "POST") {
      const body = await readJson(req, config.maxBodyBytes);
      return exposePort(res, deps, exposeMatch[1], body);
    }
    if (method === "GET") {
      const record = store.get(exposeMatch[1]);
      if (!record) return sendJson(res, 404, { error: "not found" });
      return sendJson(res, 200, { exposed: store.listExposed(exposeMatch[1]) });
    }
  }

  const sessionEnvMatch = path.match(
    /^\/sandboxes\/([^/]+)\/sessions\/([^/]+)\/env$/,
  );
  if (method === "POST" && sessionEnvMatch) {
    const body = await readJson(req, config.maxBodyBytes);
    return setSessionEnv(
      res,
      { store },
      sessionEnvMatch[1],
      sessionEnvMatch[2],
      body,
    );
  }

  const sessionIdMatch = path.match(/^\/sandboxes\/([^/]+)\/sessions\/([^/]+)$/);
  if (method === "DELETE" && sessionIdMatch) {
    return deleteSession(res, { store }, sessionIdMatch[1], sessionIdMatch[2]);
  }

  const sessionsMatch = path.match(/^\/sandboxes\/([^/]+)\/sessions$/);
  if (sessionsMatch) {
    if (method === "POST") {
      const body = await readJson(req, config.maxBodyBytes);
      return createSession(res, { store }, sessionsMatch[1], body);
    }
    if (method === "GET") {
      if (!store.get(sessionsMatch[1])) {
        return sendJson(res, 404, { error: "not found" });
      }
      return sendJson(res, 200, {
        sessions: store.listSessions(sessionsMatch[1]),
      });
    }
  }

  const envMatch = path.match(/^\/sandboxes\/([^/]+)\/env$/);
  if (envMatch) {
    const record = store.get(envMatch[1]);
    if (!record) return sendJson(res, 404, { error: "not found" });
    if (method === "GET") {
      return sendJson(res, 200, { env: record.env });
    }
    if (method === "POST") {
      const body = await readJson(req, config.maxBodyBytes);
      const env = (body.env as Record<string, string>) ?? {};
      record.env = { ...record.env, ...env };
      store.add(record); // write-through the env change
      return sendJson(res, 200, { env: record.env });
    }
  }

  if (method === "GET" && path === "/backups") {
    return sendJson(res, 200, { backups: await backups.list() });
  }

  const backupIdMatch = path.match(/^\/backups\/([^/]+)$/);
  if (method === "DELETE" && backupIdMatch) {
    const backupInfo = await backups.get(backupIdMatch[1]);
    const removed = await backups.remove(backupIdMatch[1]);
    if (!removed) return sendJson(res, 404, { error: "backup not found" });
    audit({
      event: "sandbox.backup.delete",
      sandboxId: backupInfo?.sandboxId,
      driver: backupInfo ? store.get(backupInfo.sandboxId)?.driver ?? driver.name : driver.name,
      attributes: { backupId: backupIdMatch[1] },
    });
    return sendJson(res, 200, { backupId: backupIdMatch[1], deleted: true });
  }

  const backupsMatch = path.match(/^\/sandboxes\/([^/]+)\/backups$/);
  if (backupsMatch) {
    if (method === "POST") {
      return createBackup(res, deps, backupsMatch[1]);
    }
    if (method === "GET") {
      if (!store.get(backupsMatch[1])) {
        return sendJson(res, 404, { error: "not found" });
      }
      const all = await backups.list();
      return sendJson(res, 200, {
        backups: all.filter((b) => b.sandboxId === backupsMatch[1]),
      });
    }
  }

  const restoreMatch = path.match(/^\/sandboxes\/([^/]+)\/restore$/);
  if (method === "POST" && restoreMatch) {
    const body = await readJson(req, config.maxBodyBytes);
    return restoreBackup(res, deps, restoreMatch[1], body);
  }

  const ctxIdMatch = path.match(/^\/sandboxes\/([^/]+)\/code-contexts\/([^/]+)$/);
  if (method === "DELETE" && ctxIdMatch) {
    return deleteCodeContext(res, { driver, store }, ctxIdMatch[1], ctxIdMatch[2]);
  }

  const ctxMatch = path.match(/^\/sandboxes\/([^/]+)\/code-contexts$/);
  if (ctxMatch) {
    if (method === "POST") {
      const body = await readJson(req, config.maxBodyBytes);
      return createCodeContext(res, deps, ctxMatch[1], body);
    }
    if (method === "GET") {
      if (!store.get(ctxMatch[1])) return sendJson(res, 404, { error: "not found" });
      return sendJson(res, 200, {
        contexts: store.listContexts(ctxMatch[1]).map(publicContext),
      });
    }
  }

  const runCodeMatch = path.match(/^\/sandboxes\/([^/]+)\/run-code$/);
  if (method === "POST" && runCodeMatch) {
    const body = await readJson(req, config.maxBodyBytes);
    return runCode(res, deps, runCodeMatch[1], body);
  }

  const historyMatch = path.match(/^\/sandboxes\/([^/]+)\/metrics\/history$/);
  if (method === "GET" && historyMatch) {
    if (!store.get(historyMatch[1])) return sendJson(res, 404, { error: "not found" });
    return sendJson(res, 200, { samples: deps.history?.get(historyMatch[1]) ?? [] });
  }

  const metricsMatch = path.match(/^\/sandboxes\/([^/]+)\/metrics$/);
  if (method === "GET" && metricsMatch) {
    const live = url.searchParams.get("live") !== "0";
    return getMetrics(res, { config, driver, store }, metricsMatch[1], live);
  }

  const stopMatch = path.match(/^\/sandboxes\/([^/]+)\/stop$/);
  if (method === "POST" && stopMatch) {
    return stopSandbox(res, { driver, store }, stopMatch[1]);
  }

  const pauseMatch = path.match(/^\/sandboxes\/([^/]+)\/pause$/);
  if (method === "POST" && pauseMatch) {
    return pauseSandboxRoute(res, { driver, store }, pauseMatch[1]);
  }

  const startMatch = path.match(/^\/sandboxes\/([^/]+)\/start$/);
  if (method === "POST" && startMatch) {
    return startSandbox(res, deps, startMatch[1]);
  }

  const idMatch = path.match(/^\/sandboxes\/([^/]+)$/);
  if (idMatch) {
    const id = idMatch[1];
    if (method === "GET") {
      const record = store.get(id);
      if (!record) return sendJson(res, 404, { error: "not found" });
      return sendJson(res, 200, record);
    }
    if (method === "DELETE") {
      const record = store.get(id);
      if (!record) return sendJson(res, 404, { error: "not found" });
      await driver.destroy(id);
      audit({ event: "sandbox.destroy", sandboxId: id, driver: record.driver ?? driver.name, attributes: { image: record.image } });
      store.remove(id);
      store.clearSandbox(id);
      deps.history?.clear(id);
      return sendJson(res, 200, { id, destroyed: true });
    }
  }

  sendJson(res, 404, { error: `no route for ${method} ${path}` });
}

function safeRepoForAudit(repo: string): string {
  return repo.replace(/:\/\/[^/@]+@/g, "://").split(/[?#]/, 1)[0]?.slice(0, 512) ?? "";
}

async function createSandbox(
  res: ServerResponse,
  { config, driver, store, capacity, bootScheduler }: Pick<Deps, "config" | "driver" | "store" | "capacity" | "bootScheduler">,
  body: Record<string, unknown>,
): Promise<void> {
  const id = SandboxStore.newId();
  const image = typeof body.image === "string" ? body.image : config.defaultImage;
  // Per-sandbox isolation selection: pick the runtime driver (default SBX_DRIVER).
  const driverName = typeof body.driver === "string" && body.driver ? body.driver : config.driver;
  if (!DRIVER_NAMES.includes(driverName as (typeof DRIVER_NAMES)[number])) {
    return sendJson(res, 400, {
      error: `unknown driver "${driverName}" (expected: ${DRIVER_NAMES.join(" | ")})`,
    });
  }
  const labels = (body.labels as Record<string, string>) ?? {};
  const persist = body.persist !== false;
  const sleepAfterMs =
    typeof body.sleepAfter === "number" ? body.sleepAfter : config.defaultSleepAfterMs;
  const setup = Array.isArray(body.setup)
    ? body.setup.filter((s): s is string => typeof s === "string")
    : undefined;
  const repo = typeof body.repo === "string" && body.repo ? body.repo : undefined;
  const repoRef = typeof body.repoRef === "string" && body.repoRef ? body.repoRef : undefined;
  // --branch: create + check out a new branch right after the clone, as the first
  // setup step (so it runs before any user setup). `auto` → a generated name.
  const branchRaw = typeof body.branch === "string" && body.branch ? body.branch : undefined;
  let setupSteps = setup;
  if (branchRaw && repo) {
    const repoName = repo.replace(/\.git$/, "").replace(/\/+$/, "").split("/").pop() || "repo";
    const branch = branchRaw === "auto" ? `hotcell/${id.slice(0, 8)}` : branchRaw;
    const co = `git -C /workspace/${repoName} checkout -b ${shellEscape(branch)} 2>/dev/null || git -C /workspace/${repoName} checkout ${shellEscape(branch)}`;
    setupSteps = [co, ...(setup ?? [])];
  }
  const networked = body.networked === true;
  const writableRootfs = body.writableRootfs === true;
  const cpuset = typeof body.cpuset === "string" && body.cpuset ? body.cpuset : undefined;

  // Resolve hard resource caps: per-create value overrides the daemon default.
  const resolved = resolveLimits(body, config);
  if ("error" in resolved) return sendJson(res, 400, { error: resolved.error });
  const limits = resolved.limits;

  // Admission control: refuse to over-subscribe the host's memory budget. The
  // reservation pends until the record is written (or provisioning fails), so
  // concurrent creates/resumes can't all pass the same check.
  const admitted = capacity?.admitAndReserve(limits.memoryMb) ?? {
    ok: true as const,
    release: () => {},
  };
  if (!admitted.ok) {
    audit({ event: "sandbox.admission_denied", sandboxId: id, driver: driverName, attributes: { image, memoryMb: limits.memoryMb ?? 0, cpus: limits.cpus ?? 0, status: 503, reason: admitted.reason.slice(0, 256) } });
    return sendCapacityRefusal(res, admitted.reason);
  }

  // Egress wiring. `egress: true` (or a policy object) opts the sandbox's LLM SDKs
  // into the gateway (provider base-URL + key env). Independently, when egress
  // enforcement is ON every sandbox is locked to the gateway, so it also gets a
  // token + `HTTP(S)_PROXY` so pip/npm/git/apt can reach the allowlist.
  let egressToken: string | undefined;
  let egressPolicy: EgressPolicy = {};
  let env = (body.env as Record<string, string>) ?? {};
  const wantEgress = body.egress === true || (!!body.egress && typeof body.egress === "object");
  if (typeof body.egress === "object" && body.egress) {
    const parsed = parseEgressPolicy(body.egress as Record<string, unknown>);
    if ("error" in parsed) {
      admitted.release();
      return sendJson(res, 400, { error: parsed.error });
    }
    egressPolicy = parsed.policy;
  }
  if (wantEgress || config.egressEnforce) {
    egressToken = SandboxStore.newEgressToken();
    // microVM guests have no NIC: their route to the gateway is the in-guest
    // loopback relay (agent listener on 127.0.0.1:<egressPort> → vsock → host),
    // so their env points at localhost instead of the gateway's host address.
    const advertiseHost = driverName !== "container" ? "127.0.0.1" : undefined;
    if (wantEgress) env = { ...env, ...egressEnv(config, egressToken, advertiseHost) };
    if (proxyEnvWanted(driverName, wantEgress, config.egressEnforce))
      env = { ...env, ...proxyEnv(config, egressToken, advertiseHost) };

    // Keyless git out of the box: egress wired + a GitHub repo + a `github`
    // provider key on the host → point the clone's origin at the gateway's
    // github-git route, authed by this sandbox's own egress token. `git push`
    // (and fetch) then work with no GitHub credential inside the sandbox; the
    // gateway swaps the token for the real one. Harness-agnostic — this is the
    // generic half of what examples/agents.sh used to wire by hand.
    if (repo && config.egressPort > 0 && config.providerKeys.github) {
      const slug = repo.match(/^(?:https?:\/\/|git@)github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1];
      if (slug) {
        const repoName = repo.replace(/\.git$/, "").replace(/\/+$/, "").split("/").pop() || "repo";
        const gwHost = advertiseHost ?? config.egressAdvertiseHost;
        const remote = `http://x-access-token:${egressToken}@${gwHost}:${config.egressPort}/github-git/${slug}.git`;
        setupSteps = [
          `git -C /workspace/${repoName} remote set-url origin ${shellEscape(remote)}`,
          ...(setupSteps ?? []),
        ];
        log.info("git origin wired through the egress gateway", { sandbox: id, repo: slug });
      }
    }
  }

  // Per-sandbox LLM spend ceiling: per-create value (if a valid non-negative
  // number) overrides the daemon default; 0 = unlimited.
  const egressSpendCapUsd =
    typeof body.egressSpendCapUsd === "number" && body.egressSpendCapUsd >= 0
      ? body.egressSpendCapUsd
      : config.egressSpendCapUsd;

  // The record exists (status `creating`) BEFORE provisioning runs, in both
  // modes: a detached create needs something to poll, and registering the
  // egress token up front means setup traffic through the gateway can
  // authenticate even under enforcement. The pending capacity reservation is
  // held until the terminal state (`committed()` only counts `running`).
  const detach = body.detach === true;
  const now = new Date().toISOString();
  const record: SandboxRecord = {
    id,
    image,
    status: "creating",
    statusReason: "starting",
    createdAt: now,
    driver: driverName,
    labels,
    env,
    persist,
    lastActivityAt: now,
    sleepAfterMs,
    limits,
    egressSpendCapUsd,
    usage: emptyUsage(),
  };
  store.add(record);
  audit({ event: "sandbox.create", sandboxId: id, driver: driverName, attributes: { image, repo: repo ? safeRepoForAudit(repo) : "", branch: (repoRef ?? branchRaw ?? "").slice(0, 256), memoryMb: limits.memoryMb ?? 0, cpus: limits.cpus ?? 0 } });
  if (egressToken) store.addEgressToken(egressToken, id, egressPolicy);

  const provision = () =>
    (driverName === "firecracker" || driverName === "applevz") && bootScheduler
      ? bootScheduler.run(`create:${id}`, () => driver.create({
        id, image, driver: driverName, env, labels, persist, setup: setupSteps,
        repo, repoRef, limits, networked, writableRootfs, cpuset,
        onProgress: (phase) => {
          const r = store.get(id);
          if (r?.status === "creating") {
            r.statusReason = phase;
            store.add(r);
          }
        },
      }), () => {
        const r = store.get(id);
        if (r?.status === "creating") {
          r.statusReason = "queued for microVM boot";
          store.add(r);
        }
      })
      : driver.create({
      id, image, driver: driverName, env, labels, persist, setup: setupSteps,
      repo, repoRef, limits, networked, writableRootfs, cpuset,
      onProgress: (phase) => {
        const r = store.get(id);
        if (r?.status === "creating") {
          r.statusReason = phase;
          store.add(r);
        }
      },
      });

  // Terminal transitions. Both re-check the store: a DELETE mid-create is the
  // cancel path, and must win — never resurrect a destroyed record.
  const finishOk = (): SandboxRecord | null => {
    admitted.release();
    const r = store.get(id);
    if (!r) {
      void driver.destroy(id).catch(() => {});
      return null;
    }
    r.status = "running";
    r.statusReason = undefined;
    r.lastActivityAt = new Date().toISOString();
    store.add(r);
    audit({ event: "sandbox.start", sandboxId: id, driver: r.driver ?? driver.name });
    return r;
  };
  const finishFail = async (err: unknown, keepRecord: boolean): Promise<void> => {
    admitted.release();
    // Tear down the half-built container so it doesn't orphan.
    await driver.destroy(id).catch(() => {});
    const r = store.get(id);
    if (!r || !keepRecord) {
      store.remove(id);
      store.clearSandbox(id);
      return;
    }
    r.status = "error";
    r.statusReason = errorMessage(err);
    store.add(r);
    store.clearRuntimeState(id);
    for (const t of store.listEgressTokens(id)) store.removeEgressToken(t.token);
  };

  if (!detach) {
    try {
      await provision();
    } catch (err) {
      await finishFail(err, /* keepRecord */ false);
      return sendJson(res, 422, { error: `sandbox provisioning failed: ${errorMessage(err)}` });
    }
    const r = finishOk();
    if (!r) return sendJson(res, 404, { error: "sandbox was destroyed during create" });
    return sendJson(res, 201, r);
  }

  // Detached: respond now, keep provisioning in the background. The client
  // polls GET /sandboxes/:id until `running` or `error`. No response object is
  // held past this point, so a client disconnect changes nothing server-side.
  sendJson(res, 201, record);
  void provision()
    .then(() => void finishOk())
     .catch((err: unknown) => finishFail(err, /* keepRecord */ true))
     .catch((err: unknown) => log.error("background create cleanup failed", { sandbox: id, error: errorMessage(err) }));
}

async function stopSandbox(
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
): Promise<void> {
  const record = store.get(id);
  if (!record) return sendJson(res, 404, { error: "not found" });
  const blocked = notReadyRefusal(res, record);
  if (blocked) return;
  if (record.status === "stopped") return sendJson(res, 200, record);
  await driver.stop(id);
  // Processes and exposed ports die with the container; sessions persist.
  store.clearRuntimeState(id);
  record.status = "stopped";
  store.add(record);
  audit({ event: "sandbox.stop", sandboxId: id, driver: record.driver ?? driver.name }); // write-through the status change
  sendJson(res, 200, record);
}

async function startSandbox(
  res: ServerResponse,
  { driver, store, capacity }: Pick<Deps, "driver" | "store" | "capacity">,
  id: string,
): Promise<void> {
  const record = store.get(id);
  if (!record) return sendJson(res, 404, { error: "not found" });
  const blocked = notReadyRefusal(res, record);
  if (blocked) return;
  if (record.status === "running") return sendJson(res, 200, record);
  try {
    await resumeSandbox(driver, store, record, capacity);
  } catch (err) {
    if (err instanceof CapacityError) return sendCapacityRefusal(res, err.reason);
    throw err;
  }
  sendJson(res, 200, record);
}

/**
 * Manual fast-pause: the strongest pause the sandbox's driver offers (memory
 * snapshot on microVM drivers — background processes come back alive; cold
 * stop-with-volume otherwise). Unlike `stop`, any later operation transparently
 * resumes the sandbox.
 */
async function pauseSandboxRoute(
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
): Promise<void> {
  const record = store.get(id);
  if (!record) return sendJson(res, 404, { error: "not found" });
  const blocked = notReadyRefusal(res, record);
  if (blocked) return;
  if (record.status === "paused") return sendJson(res, 200, record);
  if (record.status === "stopped") {
    return sendJson(res, 409, { error: "sandbox is stopped; start it first" });
  }
  await pauseSandbox(driver, store, record);
  sendJson(res, 200, record);
}

/**
 * Refuse an operation on a sandbox that hasn't finished (or failed) creating.
 * Sends the 409 itself and returns true when the request was refused; the only
 * operation these states allow is DELETE (cancel / clean up).
 */
function notReadyRefusal(res: ServerResponse, record: SandboxRecord): boolean {
  if (record.status === "creating") {
    const phase = record.statusReason ? ` (${record.statusReason})` : "";
    sendJson(res, 409, { error: `sandbox is still being created${phase}` });
    return true;
  }
  if (record.status === "error") {
    sendJson(res, 409, {
      error: `sandbox creation failed: ${record.statusReason ?? "unknown error"}; destroy it with DELETE /sandboxes/:id`,
    });
    return true;
  }
  return false;
}

/**
 * Resolve a sandbox that must be live to do work. Records the activity (so the
 * idle reaper sees recent use), transparently resumes a `paused` sandbox
 * (admission-gated — an over-budget wake is a 503), rejects a manually
 * `stopped` one (409 — the user must `start` it), and refuses `creating`/
 * `error` sandboxes (409 — not live yet / never will be). Sends the error
 * response itself and returns null on failure.
 */
async function ensureLive(
  res: ServerResponse,
  driver: Driver,
  store: SandboxStore,
  id: string,
  capacity?: Capacity,
): Promise<SandboxRecord | null> {
  const record = store.get(id);
  if (!record) {
    sendJson(res, 404, { error: "not found" });
    return null;
  }
  if (notReadyRefusal(res, record)) return null;
  if (record.status === "stopped") {
    sendJson(res, 409, { error: "sandbox is stopped; start it first" });
    return null;
  }
  if (record.status === "paused") {
    try {
      await resumeSandbox(driver, store, record, capacity);
    } catch (err) {
      if (err instanceof CapacityError) {
        sendCapacityRefusal(res, err.reason);
        return null;
      }
      throw err;
    }
  } else {
    store.touch(id);
  }
  return record;
}

/**
 * Resource metrics + cost for a sandbox. A live snapshot is included only when
 * the sandbox is running (a paused/stopped sandbox has no container); the
 * accumulated usage and cost are always returned. Reading metrics is a passive
 * query — it does not count as activity nor auto-resume a paused sandbox.
 */
async function getMetrics(
  res: ServerResponse,
  { config, driver, store }: Pick<Deps, "config" | "driver" | "store">,
  id: string,
  includeLive = true,
): Promise<void> {
  const record = store.get(id);
  if (!record) return sendJson(res, 404, { error: "not found" });
  let live = null;
  if (includeLive && record.status === "running") {
    try {
      live = await driver.stats(id);
    } catch {
      // Container may have just gone away; report accumulated usage only.
    }
  }
  return sendJson(res, 200, {
    status: record.status,
    live,
    usage: record.usage,
    cost: computeCost(record.usage, config),
  });
}

async function createBackup(
  res: ServerResponse,
  { driver, store, backups, capacity }: Deps,
  id: string,
): Promise<void> {
  const record = await ensureLive(res, driver, store, id, capacity);
  if (!record) return;
  const backupId = SandboxStore.newBackupId();
  await backups.ensureDir();
  const { bytes } = await driver.createBackup(id, backups.tarPath(backupId));
  const info: BackupInfo = {
    backupId,
    sandboxId: id,
    createdAt: new Date().toISOString(),
    bytes,
  };
  await backups.save(info);
  audit({ event: "sandbox.backup.create", sandboxId: id, driver: record.driver ?? driver.name, attributes: { backupId, bytes } });
  sendJson(res, 201, info);
}

async function restoreBackup(
  res: ServerResponse,
  { driver, store, backups, capacity }: Deps,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!store.get(id)) return sendJson(res, 404, { error: "not found" });
  const backupId = body.backupId;
  if (typeof backupId !== "string") {
    return sendJson(res, 400, { error: "backupId is required" });
  }
  const info = await backups.get(backupId);
  if (!info) return sendJson(res, 404, { error: "backup not found" });
  if (!(await ensureLive(res, driver, store, id, capacity))) return;
  await driver.restoreBackup(id, backups.tarPath(backupId));
  audit({ event: "sandbox.backup.restore", sandboxId: id, driver: store.get(id)?.driver ?? driver.name, attributes: { backupId } });
  sendJson(res, 200, { id, restored: backupId });
}

// --- code interpreter ------------------------------------------------------

/** Run a command, accumulating its streams; never throws on non-zero exit. */
async function execCapture(
  driver: Driver,
  id: string,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  await driver.exec(id, command, {}, (e) => {
    if (e.type === "stdout") stdout += e.data;
    else if (e.type === "stderr") stderr += e.data;
    else exitCode = e.exitCode;
  });
  return { stdout, stderr, exitCode };
}

function parseLanguage(value: unknown): KernelLanguage | undefined {
  return value === "python" || value === "javascript" ? value : undefined;
}

/** Provision a kernel: make the context dir + fifos, write it, start it. */
async function startKernel(
  driver: Driver,
  store: SandboxStore,
  id: string,
  language: KernelLanguage,
): Promise<CodeContextInfo> {
  const contextId = SandboxStore.newContextId();
  const dir = `/workspace/.sbx/ctx-${contextId}`;
  const setup = await execCapture(
    driver,
    id,
    `mkdir -p ${shellEscape(dir)} && mkfifo ${shellEscape(dir)}/in.fifo ${shellEscape(dir)}/out.fifo`,
  );
  if (setup.exitCode !== 0) {
    throw new Error(`failed to set up code context: ${setup.stderr.trim()}`);
  }
  const kernel = kernelFor(language);
  await driver.writeFile(id, { path: `${dir}/${kernel.filename}`, content: kernel.source });
  const procId = SandboxStore.newProcId();
  const { pid } = await driver.startProcess(id, procId, kernel.command(dir), {});
  const ctx: CodeContextInfo = {
    contextId,
    language,
    dir,
    procId,
    pid,
    seq: 0,
    createdAt: new Date().toISOString(),
  };
  store.addContext(id, ctx);
  return ctx;
}

/** Kill a context's kernel and remove its directory. */
async function teardownKernel(
  driver: Driver,
  id: string,
  ctx: CodeContextInfo,
): Promise<void> {
  try {
    await driver.killProcess(id, ctx.pid, "KILL");
  } catch {
    // Kernel may already be gone; the rm below still cleans up.
  }
  await execCapture(driver, id, `rm -rf ${shellEscape(ctx.dir)}`);
}

async function createCodeContext(
  res: ServerResponse,
  { driver, store, capacity }: Pick<Deps, "driver" | "store" | "capacity">,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!(await ensureLive(res, driver, store, id, capacity))) return;
  const language = parseLanguage(body.language ?? "python");
  if (!language) {
    return sendJson(res, 400, { error: "language must be 'python' or 'javascript'" });
  }
  const ctx = await startKernel(driver, store, id, language);
  sendJson(res, 201, publicContext(ctx));
}

async function deleteCodeContext(
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
  contextId: string,
): Promise<void> {
  const ctx = store.getContext(id, contextId);
  if (!ctx) return sendJson(res, 404, { error: "context not found" });
  await teardownKernel(driver, id, ctx);
  store.removeContext(id, contextId);
  sendJson(res, 200, { contextId, destroyed: true });
}

async function runCode(
  res: ServerResponse,
  { driver, store, capacity }: Pick<Deps, "driver" | "store" | "capacity">,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!(await ensureLive(res, driver, store, id, capacity))) return;
  const code = body.code;
  if (typeof code !== "string") {
    return sendJson(res, 400, { error: "code is required" });
  }
  const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : 30_000;

  // Resolve the context: an explicit one (persistent), or a throwaway kernel
  // for a one-off run.
  let ctx: CodeContextInfo;
  let ephemeral = false;
  if (typeof body.contextId === "string") {
    const found = store.getContext(id, body.contextId);
    if (!found) return sendJson(res, 404, { error: "context not found" });
    ctx = found;
  } else {
    const language = parseLanguage(body.language ?? "python");
    if (!language) {
      return sendJson(res, 400, { error: "language must be 'python' or 'javascript'" });
    }
    ctx = await startKernel(driver, store, id, language);
    ephemeral = true;
  }

  try {
    const result = await runCell(driver, id, ctx, code, timeoutMs);
    if (!ephemeral) store.addContext(id, ctx); // write-through the bumped seq
    sendJson(res, 200, result);
  } finally {
    if (ephemeral) {
      await teardownKernel(driver, id, ctx);
      store.removeContext(id, ctx.contextId);
    }
  }
}

/** Drive one cell through the kernel's fifo handshake and read its result. */
async function runCell(
  driver: Driver,
  id: string,
  ctx: CodeContextInfo,
  code: string,
  timeoutMs: number,
): Promise<CodeResult> {
  const seq = ++ctx.seq;
  await driver.writeFile(id, { path: `${ctx.dir}/cell-${seq}.code`, content: code });
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  // Push the seq to the kernel and block until it signals completion. If the
  // kernel is wedged or the cell runs too long, `timeout` aborts the handshake.
  const handshake = await execCapture(
    driver,
    id,
    `timeout ${seconds} sh -c 'printf "%s" "${seq}" > ${ctx.dir}/in.fifo && read _ < ${ctx.dir}/out.fifo'`,
  );
  if (handshake.exitCode === 124 || handshake.exitCode === 137) {
    return {
      stdout: "",
      stderr: "",
      results: [],
      error: `code execution timed out after ${seconds}s`,
    };
  }
  const raw = await driver.readFile(id, { path: `${ctx.dir}/cell-${seq}.result.json` });
  return JSON.parse(raw) as CodeResult;
}

function publicContext(ctx: CodeContextInfo) {
  return {
    contextId: ctx.contextId,
    language: ctx.language,
    createdAt: ctx.createdAt,
  };
}

async function execInSandbox(
  res: ServerResponse,
  { driver, store, capacity }: Pick<Deps, "driver" | "store" | "capacity">,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  const record = await ensureLive(res, driver, store, id, capacity);
  if (!record) return;

  const command = body.command;
  if (typeof command !== "string" || command.length === 0) {
    return sendJson(res, 400, { error: "command is required" });
  }

  // Resolve an optional session: it contributes a working directory and an env
  // overlay, and its cwd follows `cd` across commands. Env precedence (lowest
  // to highest): sandbox -> session -> request.
  const requestEnv = (body.env as Record<string, string>) ?? {};
  const requestCwd = typeof body.cwd === "string" ? body.cwd : undefined;
  let session: SessionInfo | undefined;
  if (typeof body.sessionId === "string") {
    session = store.getSession(id, body.sessionId);
    if (!session) return sendJson(res, 404, { error: "session not found" });
  }

  const env = { ...record.env, ...(session?.env ?? {}), ...requestEnv };
  const cwd = requestCwd ?? session?.cwd;

  // For a session, capture the working directory the command leaves behind so a
  // later `cd` persists. We append a `pwd` write that runs in the same shell as
  // the user command (newline-delimited so a trailing comment can't swallow it).
  let runCommand = command;
  const cwdFile = session ? `/tmp/hotcell-sess-${session.sessionId}.cwd` : null;
  if (cwdFile) {
    runCommand =
      `{\n${command}\n}\n__hc_rc=$?\n` +
      `pwd > ${cwdFile} 2>/dev/null\nexit $__hc_rc`;
  }

  // Stream output as Server-Sent Events.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const write = (event: ExecEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // The stream is live work: the reaper must see this sandbox as active for
  // the whole run, not just the instant the request arrived.
  store.beginExec(id);
  const execStartedAt = Date.now();
  audit({ event: "sandbox.exec.start", sandboxId: id, driver: record.driver ?? driver.name, attributes: { command: redactCommandForAudit(command), cwd: cwd ?? "" } });
  let auditExitCode = 1;
  const stopKeepalive = startSseKeepalive(res);
  try {
    await driver.exec(id, runCommand, { cwd, env }, (event) => {
      if (event.type === "exit") auditExitCode = event.exitCode;
      write(event);
    });
    if (session && cwdFile) {
      try {
        const next = (await driver.readFile(id, { path: cwdFile })).trim();
        if (next && next !== session.cwd) {
          session.cwd = next;
          store.addSession(id, session); // write-through the cwd change
        }
      } catch {
        // Best-effort cwd capture; keep the previous cwd on failure.
      }
    }
  } catch (err) {
    write({ type: "stderr", data: String(err) });
    write({ type: "exit", exitCode: 1 });
  } finally {
    stopKeepalive();
    audit({ event: "sandbox.exec", sandboxId: id, driver: record.driver ?? driver.name, attributes: { command: redactCommandForAudit(command), cwd: cwd ?? "", exitCode: auditExitCode, durationMs: Date.now() - execStartedAt } });
    store.endExec(id);
    res.end();
  }
}

/**
 * Emit an SSE comment frame on a quiet interval for the life of a stream.
 *
 * An agent inside a sandbox can legitimately produce NOTHING on an exec stream
 * for many minutes (a model thinking between tool calls, a subagent doing the
 * work while the parent waits). HTTP clients infer death from that silence —
 * undici's default fetch kills a body after 5 quiet minutes ("Body Timeout
 * Error"), and it cost a consumer a complete 75-minute run at its final verify
 * step. Comment frames are ignored by every SSE parser but keep bytes flowing,
 * so no client-side timeout policy ever sees silence on a healthy stream.
 */
function startSseKeepalive(res: ServerResponse, intervalMs = 15_000): () => void {
  const timer = setInterval(() => {
    res.write(": hb\n\n");
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function watchFiles(
  req: IncomingMessage,
  res: ServerResponse,
  { driver, store, capacity }: Pick<Deps, "driver" | "store" | "capacity">,
  id: string,
  watchPath: string,
  intervalMs: number | undefined,
): Promise<void> {
  if (!(await ensureLive(res, driver, store, id, capacity))) return;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // Flush headers immediately with an SSE comment so clients (e.g. fetch) get
  // the response before the first change event — which may be far in the future.
  res.write(": watching\n\n");

  // Stop the watcher when the client disconnects.
  const controller = new AbortController();
  req.on("close", () => controller.abort());

  const stopKeepalive = startSseKeepalive(res);
  try {
    await driver.watchFiles(
      id,
      watchPath,
      { intervalMs, signal: controller.signal },
      (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
    );
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: "error", error: String(err) })}\n\n`);
  } finally {
    stopKeepalive();
    res.end();
  }
}

async function handleFileAction(
  res: ServerResponse,
  { driver, store, capacity }: Pick<Deps, "driver" | "store" | "capacity">,
  id: string,
  action: "write" | "read" | "mkdir" | "list",
  body: Record<string, unknown>,
): Promise<void> {
  if (!(await ensureLive(res, driver, store, id, capacity))) return;

  const path = typeof body.path === "string" ? body.path : "";
  if (!path) return sendJson(res, 400, { error: "path is required" });

  try {
    switch (action) {
      case "write": {
        if (typeof body.content !== "string") {
          return sendJson(res, 400, { error: "content is required" });
        }
        await driver.writeFile(id, {
          path,
          content: body.content,
          mode: typeof body.mode === "string" ? body.mode : undefined,
        });
        audit({ event: "sandbox.file.write", sandboxId: id, driver: store.get(id)?.driver ?? driver.name, attributes: { path: path.slice(0, 512), bytes: Buffer.byteLength(body.content, "utf8") } });
        return sendJson(res, 200, { ok: true });
      }
      case "read": {
        const content = await driver.readFile(id, { path });
        audit({ event: "sandbox.file.read", sandboxId: id, driver: store.get(id)?.driver ?? driver.name, attributes: { path: path.slice(0, 512), bytes: Buffer.byteLength(content, "utf8") } });
        return sendJson(res, 200, { content });
      }
      case "mkdir": {
        await driver.mkdir(id, { path, parents: body.parents === true });
        audit({ event: "sandbox.file.mkdir", sandboxId: id, driver: store.get(id)?.driver ?? driver.name, attributes: { path: path.slice(0, 512), parents: body.parents === true } });
        return sendJson(res, 200, { ok: true });
      }
      case "list": {
        const entries = await driver.listFiles(id, { path });
        return sendJson(res, 200, { entries });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sendJson(res, 500, { error: message });
  }
}

async function startProcess(
  res: ServerResponse,
  { driver, store, capacity }: Pick<Deps, "driver" | "store" | "capacity">,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  const record = await ensureLive(res, driver, store, id, capacity);
  if (!record) return;

  const command = body.command;
  if (typeof command !== "string" || command.length === 0) {
    return sendJson(res, 400, { error: "command is required" });
  }
  const procId = SandboxStore.newProcId();
  const opts = {
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    env: { ...record.env, ...((body.env as Record<string, string>) ?? {}) },
  };

  try {
    const { pid, logPath } = await driver.startProcess(id, procId, command, opts);
    const proc: ProcessInfo = {
      procId,
      pid,
      command,
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      logPath,
    };
    store.addProcess(id, proc);
    audit({ event: "sandbox.process.start", sandboxId: id, driver: record.driver ?? driver.name, attributes: { command: redactCommandForAudit(command), cwd: opts.cwd ?? "", procId } });
    return sendJson(res, 201, proc);
  } catch (err) {
    return sendJson(res, 500, { error: errorMessage(err) });
  }
}

async function listProcesses(
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
): Promise<void> {
  if (!store.get(id)) return sendJson(res, 404, { error: "not found" });

  const procs = store.listProcesses(id);
  if (procs.length > 0) {
    try {
      const liveness = await driver.listProcesses(
        id,
        procs.map((p) => ({ procId: p.procId, pid: p.pid })),
      );
      const running = new Map(liveness.map((l) => [l.procId, l.running]));
      for (const p of procs) {
        if (p.status === "running" && running.get(p.procId) === false) {
          p.status = "exited";
          store.addProcess(id, p); // write-through the exited status
        }
      }
    } catch {
      // Liveness refresh is best-effort; fall back to last-known status.
    }
  }
  return sendJson(res, 200, { processes: store.listProcesses(id) });
}

async function killProcess(
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
  procId: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!store.get(id)) return sendJson(res, 404, { error: "not found" });
  const proc = store.getProcess(id, procId);
  if (!proc) return sendJson(res, 404, { error: "process not found" });

  const signal = typeof body.signal === "string" ? body.signal : undefined;
  try {
    await driver.killProcess(id, proc.pid, signal);
    proc.status = "exited";
    store.addProcess(id, proc); // write-through the exited status
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    return sendJson(res, 500, { error: errorMessage(err) });
  }
}

async function streamLogs(
  req: IncomingMessage,
  res: ServerResponse,
  { driver, store }: Pick<Deps, "driver" | "store">,
  id: string,
  procId: string,
  follow: boolean,
): Promise<void> {
  if (!store.get(id)) return sendJson(res, 404, { error: "not found" });
  const proc = store.getProcess(id, procId);
  if (!proc) return sendJson(res, 404, { error: "process not found" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  const stopKeepalive = startSseKeepalive(res);
  try {
    await driver.streamProcessLogs(
      id,
      proc.logPath,
      { follow, signal: controller.signal },
      (data) => res.write(`data: ${JSON.stringify({ type: "log", data })}\n\n`),
    );
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: "log", data: errorMessage(err) })}\n\n`);
  } finally {
    stopKeepalive();
    res.write(`data: ${JSON.stringify({ type: "end" })}\n\n`);
    res.end();
  }
}

async function waitForPort(
  res: ServerResponse,
  { driver, store, capacity }: Pick<Deps, "driver" | "store" | "capacity">,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!(await ensureLive(res, driver, store, id, capacity))) return;
  const port = Number(body.port);
  if (!Number.isInteger(port) || port <= 0) {
    return sendJson(res, 400, { error: "port is required" });
  }
  try {
    const ready = await driver.waitForPort(id, port, {
      timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
      intervalMs: typeof body.intervalMs === "number" ? body.intervalMs : undefined,
      host: typeof body.host === "string" ? body.host : undefined,
    });
    return sendJson(res, 200, { ready });
  } catch (err) {
    return sendJson(res, 500, { error: errorMessage(err) });
  }
}

async function exposePort(
  res: ServerResponse,
  { config, driver, store, capacity }: Pick<Deps, "config" | "driver" | "store" | "capacity">,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!(await ensureLive(res, driver, store, id, capacity))) return;
  const port = Number(body.port);
  if (!Number.isInteger(port) || port <= 0) {
    return sendJson(res, 400, { error: "port is required" });
  }
  const exposed: ExposedPort = {
    port,
    exposeId: `${id}-${port}`,
    token: typeof body.token === "string" ? body.token : null,
    createdAt: new Date().toISOString(),
    url: previewUrl(config, id, port),
  };
  store.addExposed(id, exposed);
  audit({ event: "sandbox.preview.expose", sandboxId: id, driver: store.get(id)?.driver ?? driver.name, attributes: { port, tokenConfigured: exposed.token !== null } });
  return sendJson(res, 201, exposed);
}

function unexposePort(
  res: ServerResponse,
  { store }: Pick<Deps, "store">,
  id: string,
  port: number,
): void {
  if (!store.get(id)) return sendJson(res, 404, { error: "not found" });
  const removed = store.removeExposed(id, port);
  if (!removed) return sendJson(res, 404, { error: "port not exposed" });
  audit({ event: "sandbox.preview.unexpose", sandboxId: id, driver: store.get(id)?.driver, attributes: { port } });
  return sendJson(res, 200, { ok: true });
}

function createSession(
  res: ServerResponse,
  { store }: Pick<Deps, "store">,
  id: string,
  body: Record<string, unknown>,
): void {
  if (!store.get(id)) return sendJson(res, 404, { error: "not found" });
  const sessionId =
    typeof body.id === "string" && body.id.length > 0
      ? body.id
      : SandboxStore.newSessionId();
  if (store.getSession(id, sessionId)) {
    return sendJson(res, 409, { error: "session already exists" });
  }
  const session: SessionInfo = {
    sessionId,
    cwd: typeof body.cwd === "string" ? body.cwd : "/workspace",
    env: (body.env as Record<string, string>) ?? {},
    createdAt: new Date().toISOString(),
  };
  store.addSession(id, session);
  return sendJson(res, 201, session);
}

function setSessionEnv(
  res: ServerResponse,
  { store }: Pick<Deps, "store">,
  id: string,
  sessionId: string,
  body: Record<string, unknown>,
): void {
  if (!store.get(id)) return sendJson(res, 404, { error: "not found" });
  const session = store.getSession(id, sessionId);
  if (!session) return sendJson(res, 404, { error: "session not found" });
  const env = (body.env as Record<string, string>) ?? {};
  session.env = { ...session.env, ...env };
  store.addSession(id, session); // write-through the env change
  return sendJson(res, 200, session);
}

function deleteSession(
  res: ServerResponse,
  { store }: Pick<Deps, "store">,
  id: string,
  sessionId: string,
): void {
  if (!store.get(id)) return sendJson(res, 404, { error: "not found" });
  const removed = store.removeSession(id, sessionId);
  if (!removed) return sendJson(res, 404, { error: "session not found" });
  return sendJson(res, 200, { ok: true });
}

// --- helpers ---------------------------------------------------------------

async function readJson(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const body = await readBodyCapped(req, maxBytes);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return {};
  }
}
