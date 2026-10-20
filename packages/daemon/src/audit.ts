import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { log } from "./logger.js";

export interface AuditEvent {
  event: string;
  sandboxId?: string;
  driver?: string;
  attributes?: Record<string, string | number | boolean | undefined>;
}

interface AuditConfig { path: string; endpoint: string; headers: Record<string, string> }
let cfg: AuditConfig = { path: "", endpoint: "", headers: {} };
let queue: Record<string, unknown>[] = [];
let timer: NodeJS.Timeout | undefined;
let writes = Promise.resolve();

export function configureAudit(config: AuditConfig): void {
  cfg = config;
  if (cfg.endpoint && !timer) {
    timer = setInterval(() => void flush(), 3000);
    timer.unref?.();
  }
}

/** Emit one best-effort local JSONL event and, when configured, queue it for OTLP. */
export function audit(event: AuditEvent): void {
  const safeAttributes = Object.fromEntries(
    Object.entries(event.attributes ?? {}).filter(([key]) => key !== "token.raw"),
  );
  const entry = {
    ...safeAttributes,
    timestamp: new Date().toISOString(),
    schema_version: "1.0",
    event: event.event,
    "sandbox.id": event.sandboxId ?? "",
    "token.id": typeof event.attributes?.["token.raw"] === "string"
      ? createHash("sha256").update(event.attributes["token.raw"] as string).digest("hex")
      : undefined,
    driver: event.driver ?? "",
    host: hostname(),
  };
  if (cfg.path) {
    writes = writes.then(async () => {
      await mkdir(dirname(cfg.path), { recursive: true });
      await appendFile(cfg.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    }).catch((err) => log.warn("audit JSONL write failed", { error: String(err) }));
  }
  if (cfg.endpoint) queue.push(entry);
}

export async function stopAudit(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  await flush();
  await writes;
}

async function flush(): Promise<void> {
  if (!cfg.endpoint || !queue.length) return;
  const batch = queue;
  queue = [];
  const attributes = (entry: Record<string, unknown>) => Object.entries(entry)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value: typeof value === "number"
      ? { intValue: value } : typeof value === "boolean" ? { boolValue: value } : { stringValue: String(value) } }));
  try {
    const response = await fetch(`${cfg.endpoint}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...cfg.headers },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ resourceLogs: [{ resource: { attributes: [
        { key: "service.name", value: { stringValue: "hotcell" } },
      ] }, scopeLogs: [{ scope: { name: "hotcell.audit", version: "1.0" }, logRecords: batch.map((entry) => ({
        timeUnixNano: String(BigInt(Date.parse(String(entry.timestamp))) * 1_000_000n),
        severityNumber: 9,
        severityText: "INFO",
        body: { stringValue: String(entry.event) },
        attributes: attributes(entry),
      })) }] }] }),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
  } catch (err) {
    log.warn("audit OTLP export failed", { error: String(err), events: batch.length });
  }
}
