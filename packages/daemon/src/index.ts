#!/usr/bin/env node
import { get as httpGet } from "node:http";
import { BackupRegistry } from "./backups.js";
import { configureAudit, stopAudit } from "./audit.js";
import { Capacity } from "./capacity.js";
import { BootScheduler } from "./boot-scheduler.js";
import { loadConfig, loadProviderConfigs } from "./config.js";
import { ensureApiKey } from "./api-key.js";
import { DriverRouter } from "./driver/router.js";
import { startReaper } from "./lifecycle.js";
import { configureLogger, log } from "./logger.js";
import { MetricsHistory, startSampler } from "./metrics.js";
import { configureTracing, stopTracing } from "./tracing.js";
import { SandboxStore } from "./store.js";
import { createApiServer } from "./api/server.js";
import { createProxyServer } from "./proxy/server.js";
import { buildProviders, createEgressProxy, type EgressServer } from "./proxy/egress.js";
import { loadProviderKeyMap } from "./keystore.js";
import { loadModelPrices } from "./pricing.js";
import { brotliRuntimeAdvisory } from "./runtime-advisory.js";
import { ensureEgressFirewall, startEgressDropMonitor } from "./net/firewall.js";
import { errorMessage } from "./util.js";

/** A loopback bind host (unreachable from sandboxes on native-Linux dockerd). */
function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Turn an EADDRINUSE on the API port into a clear, actionable message instead of
 * an unhandled 'error' crash — probing the port first so we can tell "a hotcell
 * daemon is already running" apart from "some other process has the port".
 */
function reportPortInUse(host: string, port: number): void {
  const done = (lines: string[]) => {
    for (const l of lines) log.error(l);
    process.exit(1);
  };
  const req = httpGet({ host, port, path: "/healthz", timeout: 800 }, (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => {
      let hotcell = false;
      try { hotcell = JSON.parse(body)?.ok === true; } catch {}
      done(hotcell
        ? [`a hotcell daemon is already running on ${host}:${port}`,
           `  → use it as-is (hotcell ls), or start a second one on another port: HOTCELL_PORT=<n> hotcelld`]
        : [`port ${port} is already in use by another process`,
           `  → free it, or run hotcell elsewhere: HOTCELL_PORT=<n> hotcelld`]);
    });
  });
  req.on("timeout", () => req.destroy());
  req.on("error", () => done([`port ${port} is already in use`,
    `  → free it, or run hotcell elsewhere: HOTCELL_PORT=<n> hotcelld`]));
}

async function main(): Promise<void> {
  const config = loadConfig();
  // Auth is always on: an explicit HOTCELL_API_KEY, else a generated local key.
  const auth = ensureApiKey(config.apiKey);
  config.apiKey = auth.key;
  configureLogger({ level: config.logLevel, format: config.logFormat });
  const runtimeAdvisory = brotliRuntimeAdvisory();
  if (runtimeAdvisory) log.warn(runtimeAdvisory);
  configureAudit({ path: config.auditPath, endpoint: config.auditOtlpEndpoint, headers: config.auditOtlpHeaders });
  configureTracing({
    serviceName: "hotcell",
    otlpEndpoint: config.otlpEndpoint,
    headers: config.otlpHeaders,
    ringSize: config.traceRing,
  });
  const store = new SandboxStore(config.dbPath);
  // Per-sandbox driver router: dispatches each sandbox's ops to the runtime
  // driver it was created with (container ↔ applevz), defaulting to SBX_DRIVER.
  const driver = new DriverRouter(config, store, config.driver);
  const backups = new BackupRegistry(config.backupDir);
  const history = new MetricsHistory(config.metricsHistory);

  // Fail fast with a friendly message if the selected driver isn't available
  // (Docker not running, or a microVM driver requested without host support).
  // Each driver's ping() throws a complete, user-facing, actionable sentence;
  // `hotcell start` reads this line back out of the daemon log and prints it.
  try {
    await driver.ping();
  } catch (err) {
    log.error(`couldn't start the "${driver.name}" driver`, { error: errorMessage(err) });
    process.exit(1);
  }

  // A `creating` record at boot means a create was interrupted by a daemon
  // restart. We can't know how far provisioning got, so be honest: mark it
  // `error` (pollers see the reason and can destroy/retry) and tear down
  // whatever half-built resources materialized.
  for (const record of store.list()) {
    if (record.status !== "creating") continue;
    record.status = "error";
    record.statusReason = "daemon restarted during create";
    store.add(record);
    for (const t of store.listEgressTokens(record.id)) store.removeEgressToken(t.token);
    void driver.destroy(record.id).catch(() => {});
    log.warn("create was interrupted by a daemon restart; marked error", { sandbox: record.id });
  }

  // Host capacity for the meter + admission control (best-effort detection).
  const host = await driver.hostInfo().catch(() => null);
  const capacity = new Capacity(store, config, host, history, () => driver.poolStats());
  const bootScheduler = new BootScheduler(
    config.microvmBootConcurrency,
    config.microvmBootQueueTimeoutMs,
  );
  if (host) {
    log.info("host capacity", {
      memoryMb: host.memoryMb,
      cpus: host.cpus,
      admission: capacity.enforced ? "enforce" : "off",
    });
  }

  // Provider-key hot-reload: `hotcell keys add/rm` POSTs /reload-keys, which
  // re-reads keys (file/keychain/env) and live-swaps the egress gateway.
  // `egress` is assigned below; the closure reads it at call time.
  let egress: EgressServer | undefined;
  const reloadKeys = () => {
    config.providerKeys = loadProviderKeyMap();
    // Shapes too: `hotcell keys add <new-provider>` writes a base URL + auth
    // header alongside the key, and a route needs both to exist.
    config.providerConfigs = loadProviderConfigs();
    const rebuilt = buildProviders(config);
    egress?.reloadProviders(rebuilt);
    log.info("provider keys reloaded", { providers: Object.keys(rebuilt).length });
    return { providers: Object.keys(rebuilt).length };
  };

  const server = createApiServer({ config, driver, store, backups, history, capacity, bootScheduler, reloadKeys });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") return reportPortInUse(config.host, config.port);
    log.error("daemon failed to start", { error: String(err) });
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    log.info("daemon listening", {
      url: `http://${config.host}:${config.port}`,
      driver: driver.name,
      image: config.defaultImage,
      auth: auth.source === "config" ? "on (HOTCELL_API_KEY)" : `on (key file ${auth.file})`,
      otlp: config.otlpEndpoint || "off",
      auditOtlp: config.auditOtlpEndpoint || "off",
    });
  });

  const proxy = createProxyServer({ config, driver, store, capacity });
  proxy.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") return reportPortInUse(config.proxyHost, config.proxyPort);
    log.error("preview proxy failed to start", { error: String(err) });
    process.exit(1);
  });
  proxy.listen(config.proxyPort, config.proxyHost, () => {
    log.info("preview proxy listening", {
      url: `http://${config.proxyHost}:${config.proxyPort}`,
      previews: `http://<id>-<port>.localhost:${config.proxyPort}/`,
    });
  });

  // Egress credential proxy (LLM gateway): injects provider keys into outbound
  // calls and meters them. Runs whenever a port is configured; routes 404 until
  // provider keys (SBX_PROVIDER_KEY_*) are set.
  // Install the host default-deny egress firewall (Linux + SBX_EGRESS_ENFORCE only;
  // advisory no-op otherwise). Best-effort: logs and continues if it can't.
  let stopEgressDropMonitor = () => {};
  const dropLoggingInstalled = await ensureEgressFirewall(config);

  // Reconcile the egress bridge network at boot so a subnet collision (e.g. a
  // stale network from a pre-rename daemon) fails fast with an actionable message
  // instead of a 422 on the first create.
  if (config.egressEnforce && typeof driver.initEgress === "function") {
    await driver.initEgress();
  }
  if (dropLoggingInstalled) {
    stopEgressDropMonitor = startEgressDropMonitor(
      (sourceIp) => driver.resolveEgressSourceIp(sourceIp),
      config,
    );
  }

  const providers = buildProviders(config);
  const prices = loadModelPrices(config.modelPricesPath);
  // Native-Linux enforcement footgun: sandboxes reach the daemon via the bridge
  // gateway (host.docker.internal → ~172.17.0.1), so a loopback-only egress bind
  // is unreachable from them and every outbound call (npm, the LLM gateway) fails
  // with ECONNREFUSED. When enforcement is on, the platform is Linux, and the
  // operator hasn't pinned a host explicitly, bind 0.0.0.0 — access is still gated
  // by the per-sandbox egress token + the host firewall. Block the port at your
  // cloud firewall.
  const egressHostSet = !!(process.env.HOTCELL_EGRESS_HOST ?? process.env.SBX_EGRESS_HOST);
  const egressBindHost =
    config.egressEnforce && !egressHostSet && process.platform === "linux" && isLoopback(config.egressHost)
      ? "0.0.0.0"
      : config.egressHost;
  if (egressBindHost !== config.egressHost) {
    log.info("egress proxy binding 0.0.0.0 for native-Linux enforcement (token-gated; firewall the port)", {
      port: config.egressPort,
    });
  }
  egress =
    config.egressPort > 0 ? createEgressProxy({ config, store, providers, prices }) : undefined;
  egress?.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") return reportPortInUse(egressBindHost, config.egressPort);
    log.error("egress proxy failed to start", { error: String(err) });
    process.exit(1);
  });
  egress?.listen(config.egressPort, egressBindHost, () => {
    log.info("egress proxy listening", {
      url: `http://${egressBindHost}:${config.egressPort}`,
      providers: Object.keys(providers).length ? Object.keys(providers).join(",") : "none configured",
    });
  });

  // Idle reaper: auto-pause sandboxes left idle past their sleepAfterMs.
  const reaper =
    config.reapIntervalMs > 0
      ? startReaper({ driver, store, intervalMs: config.reapIntervalMs })
      : undefined;

  // Metrics sampler: integrate per-sandbox CPU/mem usage for the cost meter.
  const sampler =
    config.metricsIntervalMs > 0
      ? startSampler({ driver, store, history, intervalMs: config.metricsIntervalMs })
      : undefined;

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down");
    if (reaper) clearInterval(reaper);
    if (sampler) clearInterval(sampler);
    stopEgressDropMonitor();
    // Failsafe: `server.close()`'s callback waits for every connection to drain,
    // and an attached terminal WebSocket / SSE exec stream / keep-alive client
    // NEVER drains — without this the process lingers forever as a listener-less
    // zombie (ports freed, exit never reached). Hard-exit after a short grace.
    const failsafe = setTimeout(() => {
      try {
        store.close();
      } catch {
        /* already closed */
      }
      process.exit(0);
    }, 5000);
    failsafe.unref();
    await driver.shutdown().catch(() => {}); // tear down the VZ warm pool, if any
    stopTracing();
    await stopAudit();
    egress?.close();
    egress?.closeAllConnections();
    proxy.close();
    // L4 preview proxy may be a raw net.Server (no closeAllConnections); its
    // lingering tunnels are covered by the failsafe timer.
    (proxy as { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    // Sever live connections (incl. upgraded WS sockets) so close() can complete.
    server.closeAllConnections();
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  log.error("fatal", { error: String(err?.stack ?? err) });
  process.exit(1);
});
