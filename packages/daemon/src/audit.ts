import { appendFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { log } from "./logger.js";

export type AuditSeverity = "INFO" | "WARN" | "ERROR";

export interface AuditEvent {
  event: string;
  sandboxId?: string;
  driver?: string;
  /** Explicit action override; otherwise derived from the stable event name. */
  action?: string;
  /** Defaults to INFO; denial/rejection/drop events are WARN. */
  severity?: AuditSeverity;
  attributes?: Record<string, string | number | boolean | undefined>;
}

export interface AuditConfig { path: string; endpoint: string; headers: Record<string, string> }
interface PendingAudit {
  entry: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: number;
}

export const AUDIT_LIMITS = {
  maxQueueEvents: 2048,
  maxBatchEvents: 128,
  maxBatchBytes: 512 * 1024,
  maxAttempts: 3,
  /** Batches sent back to back per timer tick, so a busy daemon keeps up. */
  maxBatchesPerTick: 16,
  /** Upper bound on how long shutdown waits for the queue to drain. */
  shutdownDrainMs: 10_000,
} as const;

const HOST_NAME = hostname();
const SERVICE_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
})();

let cfg: AuditConfig = { path: "", endpoint: "", headers: {} };
let queue: PendingAudit[] = [];
let timer: NodeJS.Timeout | undefined;
let writes = Promise.resolve();
let flushInFlight: Promise<boolean> | undefined;
let lastQueueWarningAt = 0;

export function configureAudit(config: AuditConfig): void {
  cfg = config;
  if (cfg.endpoint && !timer) {
    timer = setInterval(() => void drainAudit(AUDIT_LIMITS.maxBatchesPerTick), 3000);
    timer.unref?.();
  }
}

/** Emit one best-effort local JSONL event and, when configured, queue it for OTLP. */
export function audit(event: AuditEvent): void {
  const entry = buildAuditEntry(event);
  if (cfg.path) {
    const path = cfg.path;
    writes = writes.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, JSON.stringify(entry) + "\n", { mode: 0o600 });
    }).catch((err) => log.warn("audit JSONL write failed", { error: String(err) }));
  }
  if (cfg.endpoint) enqueue({ entry, attempts: 0, nextAttemptAt: 0 });
}

/** Build a stable local audit event; exported to keep serialization unit-testable. */
export function buildAuditEntry(event: AuditEvent, at = new Date()): Record<string, unknown> {
  const rawToken = event.attributes?.["token.raw"];
  const attributes = Object.fromEntries(
    Object.entries(event.attributes ?? {}).filter(([key]) => key !== "token.raw"),
  );
  const severity = event.severity ?? severityForEvent(event.event);
  const action = event.action ?? actionForEvent(event.event);
  return {
    ...attributes,
    timestamp: at.toISOString(),
    schema_version: "1.0",
    event: event.event,
    "event.action": action,
    "beacon.event.action": action,
    "session.id": event.sandboxId ?? "",
    "sandbox.id": event.sandboxId ?? "",
    "token.id": typeof rawToken === "string"
      ? createHash("sha256").update(rawToken).digest("hex")
      : undefined,
    driver: event.driver ?? "",
    host: HOST_NAME,
    "host.name": HOST_NAME,
    severityText: severity,
    severityNumber: severityNumber(severity),
  };
}

/** Convert an OTLP AnyValue; JSON numbers with fractions must use doubleValue. */
export function toOtlpAnyValue(value: unknown): Record<string, unknown> {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
  }
  return { stringValue: String(value) };
}

/** Build an OTLP/JSON ExportLogsServiceRequest from already-normalized events. */
export function buildOtlpLogsPayload(entries: Record<string, unknown>[]) {
  return {
    resourceLogs: [{
      resource: { attributes: [
        { key: "service.name", value: { stringValue: "hotcell" } },
        { key: "service.version", value: { stringValue: SERVICE_VERSION } },
        { key: "host.name", value: { stringValue: HOST_NAME } },
      ] },
      scopeLogs: [{
        scope: { name: "hotcell.audit", version: "1.0" },
        logRecords: entries.map((entry) => ({
          timeUnixNano: String(BigInt(Date.parse(String(entry.timestamp))) * 1_000_000n),
          severityNumber: entry.severityNumber ?? 9,
          severityText: entry.severityText ?? "INFO",
          body: { stringValue: String(entry.event ?? "") },
          attributes: Object.entries(entry)
            .filter(([key, value]) => value !== undefined
              && key !== "timestamp" && key !== "event"
              && key !== "severityText" && key !== "severityNumber")
            .map(([key, value]) => ({ key, value: toOtlpAnyValue(value) })),
        })),
      }],
    }],
  };
}

/** Best-effort bounded shutdown flush; a dead collector cannot hold shutdown forever. */
export async function stopAudit(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  await drainAudit(Number.POSITIVE_INFINITY, Date.now() + AUDIT_LIMITS.shutdownDrainMs);
  await writes;
}

/**
 * Send ready batches back to back until the queue has nothing ready, a send fails,
 * `maxBatches` is reached or `deadline` passes. Failed batches wait for their backoff.
 */
export async function drainAudit(maxBatches: number, deadline = Number.POSITIVE_INFINITY): Promise<void> {
  for (let sent = 0; sent < maxBatches && Date.now() < deadline; sent++) {
    if (!cfg.endpoint || !queue.some((item) => item.nextAttemptAt <= Date.now())) return;
    if (!(await flushAudit())) return;
  }
}

/**
 * Flush at most one bounded batch. Failures are retried a limited number of times.
 * Resolves false when the send failed.
 */
export async function flushAudit(): Promise<boolean> {
  if (flushInFlight) return flushInFlight;
  if (!cfg.endpoint || !queue.length) return true;
  const operation = deliverOneBatch();
  flushInFlight = operation;
  try {
    return await operation;
  } finally {
    if (flushInFlight === operation) flushInFlight = undefined;
  }
}

async function deliverOneBatch(): Promise<boolean> {
  const batch = takeBatch();
  if (batch.length === 0) return true;
  try {
    const response = await fetch(cfg.endpoint + "/v1/logs", {
      method: "POST",
      headers: { "content-type": "application/json", ...cfg.headers },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify(buildOtlpLogsPayload(batch.map((item) => item.entry))),
    });
    if (!response.ok) throw new Error("status " + response.status);
    return true;
  } catch (err) {
    const now = Date.now();
    let dropped = 0;
    for (const item of batch) {
      item.attempts += 1;
      if (item.attempts >= AUDIT_LIMITS.maxAttempts) {
        dropped += 1;
        continue;
      }
      item.nextAttemptAt = now + Math.min(30_000, 1000 * 2 ** (item.attempts - 1));
      enqueue(item);
    }
    log.warn("audit OTLP export failed", {
      error: String(err), events: batch.length, retrying: batch.length - dropped, dropped,
    });
    return false;
  }
}

function takeBatch(): PendingAudit[] {
  const batch: PendingAudit[] = [];
  let index = 0;
  const now = Date.now();
  while (index < queue.length && batch.length < AUDIT_LIMITS.maxBatchEvents) {
    const item = queue[index]!;
    if (item.nextAttemptAt > now) {
      index += 1;
      continue;
    }
    const candidateBody = JSON.stringify(buildOtlpLogsPayload([
      ...batch.map((pending) => pending.entry), item.entry,
    ]));
    if (Buffer.byteLength(candidateBody, "utf8") > AUDIT_LIMITS.maxBatchBytes) {
      if (batch.length > 0) break;
      queue.splice(index, 1);
      log.warn("oversized audit event dropped from OTLP queue", {
        maxBytes: AUDIT_LIMITS.maxBatchBytes,
      });
      continue;
    }
    queue.splice(index, 1);
    batch.push(item);
  }
  return batch;
}

function enqueue(item: PendingAudit): void {
  if (queue.length >= AUDIT_LIMITS.maxQueueEvents) {
    queue.shift();
    if (Date.now() - lastQueueWarningAt >= 60_000) {
      lastQueueWarningAt = Date.now();
      log.warn("audit OTLP queue full; oldest event dropped", {
        maxQueueEvents: AUDIT_LIMITS.maxQueueEvents,
      });
    }
  }
  queue.push(item);
}

function actionForEvent(event: string): string {
  const known: Record<string, string> = {
    "sandbox.create": "sandbox.created",
    "sandbox.start": "sandbox.started",
    "sandbox.stop": "sandbox.stopped",
    "sandbox.pause": "sandbox.paused",
    "sandbox.resume": "sandbox.resumed",
    "sandbox.destroy": "sandbox.destroyed",
    "sandbox.admission_denied": "sandbox.create.denied",
    "sandbox.exec.start": "command.started",
    "sandbox.exec": "command.executed",
    "sandbox.process.start": "process.started",
    "sandbox.file.read": "file.read",
    "sandbox.file.write": "file.written",
    "sandbox.file.mkdir": "file.directory_created",
    "sandbox.terminal.open": "terminal.connected",
    "sandbox.terminal.close": "terminal.disconnected",
    "sandbox.preview.expose": "preview.port_exposed",
    "sandbox.preview.unexpose": "preview.port_unexposed",
    "sandbox.backup.create": "backup.created",
    "sandbox.backup.restore": "backup.restored",
    "sandbox.backup.delete": "backup.deleted",
    "egress.firewall.drop": "egress.denied",
    "egress.connection.allowed": "egress.allowed",
    "egress.connection.denied": "egress.denied",
    "gateway.call": "gateway.request.completed",
    "gateway.policy.rejected": "egress.denied",
    "gateway.spend_cap_reached": "spend.limit_reached",
    "auth.rejected": "authentication.denied",
    "auth.host_rejected": "authentication.host_denied",
  };
  return known[event] ?? event;
}

function severityForEvent(event: string): AuditSeverity {
  if (/\.(?:error|failed)$/.test(event)) return "ERROR";
  if (/(?:denied|rejected|expired|drop|refused|spend_cap_reached|limit_reached)/i.test(event)) return "WARN";
  return "INFO";
}

function severityNumber(severity: AuditSeverity): number {
  return severity === "ERROR" ? 17 : severity === "WARN" ? 13 : 9;
}

/**
 * Redact likely credential forms from a shell command (or command output)
 * string: KEY=/TOKEN= assignments, auth headers and flags, `-u user:pass`,
 * well-known key prefixes, hotcell egress tokens, and URL userinfo
 * (`https://user:pat@host`, the gateway's `http://x-access-token:<token>@…`
 * git remote). Full length — for daemon logs; audit uses
 * {@link redactCommandForAudit}, which also truncates.
 */
export function redactSecrets(command: string): string {
  return command
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi, "$1[REDACTED]")
    .replace(/((?:^|\s)(?:-H|--header)(?:\s+|=))(["'])(?:authorization|x-api-key)\s*:[\s\S]*?\2/gi, "$1$2[REDACTED]$2")
    .replace(/((?:^|\s)(?:-H|--header)(?:\s+|=))(authorization|x-api-key)\s*:\s*(?:bearer\s+)?[^\s"';&|]+/gi, "$1$2: [REDACTED]")
    .replace(/((?:^|\s)(?:--token|--api[-_]?key|--secret|--password|--auth)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi, "$1[REDACTED]")
    .replace(/((?:^|\s)(?:-u|--user)(?:=|\s+))(?:"[^"]*:[^"]*"|'[^']*:[^']*'|[^\s;&|:'"]*:[^\s;&|]+)/gi, "$1[REDACTED]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(x-api-key\s*:\s*)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|hc-[0-9a-f]{48})\b/g, "[REDACTED]")
    // URL userinfo, any scheme; greedy up to the LAST `@` before the path, so
    // a password containing `@` doesn't leak its tail.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s"']+@/gi, "$1[REDACTED]@");
}

/** Redact likely credential forms from shell command strings before audit logging. */
export function redactCommandForAudit(command: string): string {
  return redactSecrets(command).slice(0, 512);
}

/** A repo URL safe to log: userinfo, query and fragment stripped, capped. */
export function safeRepoForLog(repo: string): string {
  return repo.replace(/:\/\/[^/\s]+@/g, "://").split(/[?#]/, 1)[0]?.slice(0, 512) ?? "";
}
