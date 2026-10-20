import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { log } from "./logger.js";

const HOST_NAME = hostname();
const SERVICE_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
})();

/**
 * Minimal, dependency-free distributed tracing — the Phase 2 "OpenTelemetry
 * traces (create→exec→destroy)" deliverable without pulling in the (large)
 * `@opentelemetry/*` tree.
 *
 * Every finished span is kept in an in-memory ring (served at `GET /traces`) and,
 * when an OTLP/HTTP endpoint is configured, batch-exported as OTLP-JSON to
 * `<endpoint>/v1/traces` so it lands in Jaeger/Tempo/Honeycomb/etc. The wire
 * shape follows the OTLP spec (resourceSpans → scopeSpans → spans) closely
 * enough for standard collectors to ingest.
 */

export type SpanStatus = "unset" | "ok" | "error";

export interface SpanData {
  traceId: string;
  spanId: string;
  parentId?: string;
  name: string;
  /** Wall-clock start, unix nanoseconds (string to survive JSON without precision loss). */
  startUnixNano: string;
  endUnixNano: string;
  durationMs: number;
  attributes: Record<string, string | number | boolean>;
  status: SpanStatus;
}

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  setAttribute(key: string, value: string | number | boolean): this;
  setStatus(status: SpanStatus): this;
  /** Finish the span: record duration, push to the ring, queue for export. */
  end(): void;
}

interface TracerConfig {
  serviceName: string;
  otlpEndpoint: string;
  headers: Record<string, string>;
  ringSize: number;
}

let cfg: TracerConfig = { serviceName: "hotcell", otlpEndpoint: "", headers: {}, ringSize: 200 };
const ring: SpanData[] = [];
let exportQueue: SpanData[] = [];
let flushTimer: NodeJS.Timeout | undefined;

export function configureTracing(opts: Partial<TracerConfig>): void {
  cfg = { ...cfg, ...opts };
  if (cfg.otlpEndpoint && !flushTimer) {
    flushTimer = setInterval(() => void flush(), 5000);
    flushTimer.unref?.();
  }
}

/** Stop the background OTLP flusher (call on daemon shutdown). */
export function stopTracing(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = undefined;
  }
}

/** Recent finished spans, newest first. */
export function recentSpans(): SpanData[] {
  return [...ring].reverse();
}

class ActiveSpan implements Span {
  readonly traceId: string;
  readonly spanId: string;
  private readonly parentId?: string;
  private readonly name: string;
  private readonly startWallMs: number;
  private readonly startHr: bigint;
  private attributes: Record<string, string | number | boolean>;
  private status: SpanStatus = "unset";
  private ended = false;

  constructor(name: string, attributes: Record<string, string | number | boolean>, parent?: Span) {
    this.name = name;
    this.attributes = attributes;
    this.traceId = parent?.traceId ?? randomBytes(16).toString("hex");
    this.spanId = randomBytes(8).toString("hex");
    this.parentId = parent?.spanId;
    this.startWallMs = Date.now();
    this.startHr = process.hrtime.bigint();
  }

  setAttribute(key: string, value: string | number | boolean): this {
    this.attributes[key] = value;
    return this;
  }

  setStatus(status: SpanStatus): this {
    this.status = status;
    return this;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const elapsedNs = process.hrtime.bigint() - this.startHr;
    const startUnixNano = BigInt(this.startWallMs) * 1_000_000n;
    const endUnixNano = startUnixNano + elapsedNs;
    const data: SpanData = {
      traceId: this.traceId,
      spanId: this.spanId,
      parentId: this.parentId,
      name: this.name,
      startUnixNano: startUnixNano.toString(),
      endUnixNano: endUnixNano.toString(),
      durationMs: Number(elapsedNs) / 1e6,
      attributes: this.attributes,
      status: this.status === "unset" ? "ok" : this.status,
    };
    push(data);
  }
}

/** Begin a span. Pass `parent` to nest it within an existing trace. */
export function startSpan(
  name: string,
  attributes: Record<string, string | number | boolean> = {},
  parent?: Span,
): Span {
  return new ActiveSpan(name, attributes, parent);
}

function push(data: SpanData): void {
  ring.push(data);
  while (ring.length > cfg.ringSize) ring.shift();
  if (cfg.otlpEndpoint) exportQueue.push(data);
}

async function flush(): Promise<void> {
  if (exportQueue.length === 0 || !cfg.otlpEndpoint) return;
  const batch = exportQueue;
  exportQueue = [];
  try {
    const res = await fetch(`${cfg.otlpEndpoint}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...cfg.headers },
      body: JSON.stringify(toOtlp(batch, cfg.serviceName)),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    // Best-effort: drop this batch but keep the daemon healthy.
    log.warn("otlp export failed", { error: String(err), spans: batch.length });
  }
}

/** Build an OTLP/JSON ExportTraceServiceRequest from a batch of spans. */
function toOtlp(spans: SpanData[], serviceName: string) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: serviceName } },
            { key: "service.version", value: { stringValue: SERVICE_VERSION } },
            { key: "host.name", value: { stringValue: HOST_NAME } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "hotcell", version: SERVICE_VERSION },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              parentSpanId: s.parentId,
              name: s.name,
              kind: 2, // SERVER
              startTimeUnixNano: s.startUnixNano,
              endTimeUnixNano: s.endUnixNano,
              attributes: Object.entries(s.attributes).map(([key, value]) => ({
                key,
                value: otlpValue(value),
              })),
              status: { code: s.status === "error" ? 2 : 1 },
            })),
          },
        ],
      },
    ],
  };
}

function otlpValue(value: string | number | boolean) {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
  }
  return { stringValue: value };
}
