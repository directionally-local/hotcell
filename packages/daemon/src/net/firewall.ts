import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { platform } from "node:os";
import { promisify } from "node:util";
import { audit } from "../audit.js";
import type { Config } from "../config.js";
import { log } from "../logger.js";

const exec = promisify(execFile);
const CHAIN = "SBX-EGRESS";
const DROP_LOG_PREFIX = "HOTCELL_EGRESS_DROP ";
const DROP_RULE = "hotcell-default-deny";

export interface FirewallDrop {
  sourceIp: string;
  destinationIp: string;
  protocol: string;
  port: number;
}

export interface EgressSandboxRef {
  sandboxId: string;
  driver: string;
}

export type EgressSourceResolver = (sourceIp: string) => Promise<EgressSandboxRef | undefined>;

/** Derive the bridge gateway IP (`.1`) from a `/24`-style subnet base. */
export function gatewayOf(subnet: string): string {
  const base = subnet.split("/")[0] ?? subnet;
  const octets = base.split(".");
  if (octets.length !== 4) return base;
  octets[3] = "1";
  return octets.join(".");
}

/** Parse one Linux kernel LOG record emitted by the Hotcell default-deny rule. */
export function parseEgressFirewallDrop(line: string): FirewallDrop | undefined {
  const marker = line.indexOf(DROP_LOG_PREFIX);
  if (marker < 0) return undefined;
  const message = line.slice(marker + DROP_LOG_PREFIX.length);
  const fields: Record<string, string> = {};
  for (const match of message.matchAll(/(?:^|\s)([A-Z][A-Z0-9_]*)=([^\s]*)/g)) {
    fields[match[1]!] = match[2]!;
  }
  if (!fields.SRC || !fields.DST) return undefined;
  const parsedPort = Number(fields.DPT);
  return {
    sourceIp: fields.SRC,
    destinationIp: fields.DST,
    protocol: (fields.PROTO ?? "unknown").toLowerCase(),
    port: Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : 0,
  };
}

/** Kernel log timestamps are monotonic microseconds since boot (`/dev/kmsg`). */
function kernelUptimeUs(line: string): number | undefined {
  const semicolon = line.indexOf(";");
  if (semicolon < 0) return undefined; // journalctl output has no kmsg metadata
  const metadata = line.slice(0, semicolon).replace(/^<\d+>/, "").split(",");
  const value = Number(metadata[2]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Host-side default-deny egress firewall for sandboxes (Linux only).
 * Traffic that misses the gateway/DNS allow rules is logged (rate-limited) and
 * then dropped. The daemon consumes those kernel records and resolves the source
 * container IP through Docker's `sbx.id` label before emitting an audit event.
 */
export async function ensureEgressFirewall(config: Config): Promise<boolean> {
  if (!config.egressEnforce) return false;
  if (platform() !== "linux") {
    log.warn(
      "egress enforcement requested but host is not Linux — fail-closed firewall is ADVISORY only " +
        "(proxy env is injected, but direct egress is NOT blocked). Use the microVM driver for hard isolation.",
      { platform: platform() },
    );
    return false;
  }

  const subnet = config.egressSubnet;
  const gateway = gatewayOf(subnet);
  const port = String(config.egressPort);
  const dns = config.egressDnsResolver;

  try {
    // Create (ignore "exists"), then flush so we rebuild cleanly each boot.
    await ipt(["-N", CHAIN]).catch(() => {});
    await ipt(["-F", CHAIN]);
    const allowRules: string[][] = [
      ["-m", "state", "--state", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
      ["-p", "tcp", "-d", gateway, "--dport", port, "-j", "ACCEPT"],
      ["-p", "udp", "-d", dns || gateway, "--dport", "53", "-j", "ACCEPT"],
      ["-p", "tcp", "-d", dns || gateway, "--dport", "53", "-j", "ACCEPT"],
    ];
    for (const rule of allowRules) await ipt(["-A", CHAIN, ...rule]);

    // Logging is optional; install the DROP regardless if LOG/limit is unsupported.
    let logInstalled = false;
    try {
      await ipt([
        "-A", CHAIN,
        "-m", "conntrack", "--ctstate", "NEW",
        "-m", "limit", "--limit", "20/second", "--limit-burst", "50",
        "-j", "LOG", "--log-prefix", DROP_LOG_PREFIX, "--log-level", "4",
      ]);
      logInstalled = true;
    } catch (err) {
      log.warn("egress firewall drop logging unavailable; DROP enforcement remains active", {
        error: String((err as Error)?.message ?? err),
      });
    }
    await ipt(["-A", CHAIN, "-j", "DROP"]);

    // Jump from DOCKER-USER for our subnet, exactly once.
    const jump = ["-s", subnet, "-j", CHAIN];
    const present = await ipt(["-C", "DOCKER-USER", ...jump]).then(
      () => true,
      () => false,
    );
    if (!present) await ipt(["-I", "DOCKER-USER", ...jump]);
    log.info("egress firewall installed (default-deny)", {
      subnet, gateway, port, dns: dns || "embedded", dropAudit: logInstalled,
    });
    return logInstalled;
  } catch (err) {
    log.error(
      "egress firewall: failed to install iptables rules — egress is NOT locked down. " +
        "Run the daemon with root / CAP_NET_ADMIN, or disable SBX_EGRESS_ENFORCE.",
      { error: String((err as Error)?.message ?? err) },
    );
    return false;
  }
}

/**
 * Consume Linux kernel firewall logs. `/dev/kmsg` is preferred; if its permissions
 * prevent access, fall back to `journalctl -k -f`. The rate-limited firewall rule
 * protects the kernel log from a sandbox generating a denial storm.
 */
export function startEgressDropMonitor(
  resolveSource: EgressSourceResolver,
  config: Config,
): () => void {
  if (platform() !== "linux") return () => {};

  let stopped = false;
  let reader: Readable | undefined;
  let journal: ChildProcess | undefined;
  let pending = "";
  let processing = Promise.resolve();
  let startUptimeUs = 0;
  try {
    startUptimeUs = Number(readFileSync("/proc/uptime", "utf8").trim().split(/\s+/)[0]) * 1_000_000;
    if (!Number.isFinite(startUptimeUs)) startUptimeUs = 0;
  } catch {
    // Without /proc uptime, the parser still works; it may replay buffered records.
  }

  const handleLine = (line: string) => {
    const drop = parseEgressFirewallDrop(line);
    if (!drop) return;
    const eventTime = kernelUptimeUs(line);
    if (eventTime !== undefined && eventTime < startUptimeUs) return;
    processing = processing.then(async () => {
      if (stopped) return;
      let source: EgressSandboxRef | undefined;
      try {
        source = await resolveSource(drop.sourceIp);
      } catch (err) {
        log.warn("could not map a firewall drop to a sandbox", {
          sourceIp: drop.sourceIp,
          error: String((err as Error)?.message ?? err),
        });
      }
      audit({
        event: "egress.connection.denied",
        sandboxId: source?.sandboxId,
        driver: source?.driver ?? "container",
        attributes: {
          host: drop.destinationIp,
          port: drop.port,
          protocol: drop.protocol,
          rule: DROP_RULE,
          direction: "outbound",
          "source.ip": drop.sourceIp,
          network: config.egressNetwork,
        },
      });
    }).catch((err) => log.warn("failed to process an egress firewall record", {
      error: String((err as Error)?.message ?? err),
    }));
  };

  const handleChunk = (chunk: string | Buffer) => {
    pending += chunk.toString();
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      handleLine(line);
    }
    if (pending.length > 16_384) pending = "";
  };

  const startJournalFallback = () => {
    if (stopped || journal) return;
    const child = spawn("journalctl", ["-k", "-f", "-o", "cat", "--since=now"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    journal = child;
    child.stdout?.on("data", handleChunk);
    child.once("error", (err) => log.warn("egress drop audit unavailable (no kernel log reader)", {
      error: String(err),
    }));
    child.once("exit", (code) => {
      if (!stopped) log.warn("kernel journal reader exited", { code });
    });
  };

  const stream = createReadStream("/dev/kmsg", { encoding: "utf8" });
  reader = stream;
  stream.on("data", handleChunk);
  stream.once("error", (err) => {
    if (stopped) return;
    log.warn("cannot read /dev/kmsg; trying journalctl for egress drop audit", {
      error: String(err),
    });
    startJournalFallback();
  });
  return () => {
    stopped = true;
    reader?.destroy();
    journal?.kill("SIGTERM");
  };
}

/** Run an `iptables` command, throwing with stderr on failure. */
async function ipt(args: string[]): Promise<void> {
  await exec("iptables", ["-w", ...args]);
}
