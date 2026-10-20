import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AUDIT_LIMITS,
  audit,
  buildAuditEntry,
  buildOtlpLogsPayload,
  configureAudit,
  flushAudit,
  redactCommandForAudit,
  stopAudit,
} from "./audit.js";

type Attribute = { key: string; value: Record<string, unknown> };
type LogRecord = { attributes: Attribute[]; severityText: string; severityNumber: number };
type Payload = {
  resourceLogs: Array<{
    resource: { attributes: Attribute[] };
    scopeLogs: Array<{ logRecords: LogRecord[] }>;
  }>;
};

function attribute(attrs: Attribute[], key: string): Record<string, unknown> | undefined {
  return attrs.find((item) => item.key === key)?.value;
}

async function main(): Promise<void> {
  const event = buildAuditEntry({
    event: "sandbox.exec",
    sandboxId: "sbx-test",
    driver: "container",
    attributes: { cost: 0.375, calls: 3, "token.raw": "never-export-this" },
  }, new Date("2026-01-02T03:04:05.000Z"));
  assert.equal(event["session.id"], "sbx-test");
  assert.equal(event["event.action"], "command.executed");
  assert.equal(event["beacon.event.action"], "command.executed");
  assert.equal(event["token.raw"], undefined);
  assert.equal(typeof event["token.id"], "string");

  const payload = buildOtlpLogsPayload([event]) as unknown as Payload;
  const resourceAttrs = payload.resourceLogs[0]!.resource.attributes;
  assert.equal(attribute(resourceAttrs, "service.name")?.stringValue, "hotcell");
  assert.ok(attribute(resourceAttrs, "service.version")?.stringValue);
  assert.ok(attribute(resourceAttrs, "host.name")?.stringValue);
  const record = payload.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
  assert.deepEqual(attribute(record.attributes, "cost"), { doubleValue: 0.375 });
  assert.deepEqual(attribute(record.attributes, "calls"), { intValue: 3 });
  assert.equal(attribute(record.attributes, "session.id")?.stringValue, "sbx-test");
  assert.equal(attribute(record.attributes, "event.action")?.stringValue, "command.executed");
  assert.equal(record.severityText, "INFO");

  const denied = buildAuditEntry({ event: "gateway.policy.rejected", sandboxId: "sbx-test" });
  const deniedRecord = (buildOtlpLogsPayload([denied]) as unknown as Payload).resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
  assert.equal(denied["event.action"], "egress.denied");
  assert.equal(deniedRecord.severityText, "WARN");
  assert.equal(deniedRecord.severityNumber, 13);
  const connectionDenied = buildAuditEntry({ event: "egress.connection.denied", sandboxId: "sbx-test" });
  const connectionRecord = (buildOtlpLogsPayload([connectionDenied]) as unknown as Payload).resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
  assert.equal(connectionDenied["event.action"], "egress.denied");
  assert.equal(connectionRecord.severityText, "WARN");

  const redactionCases: Array<[string, string]> = [
    ['curl -H "x-api-key: header-secret" https://example.test', "header-secret"],
    ['curl -H "Authorization: Bearer auth-secret" https://example.test', "auth-secret"],
    ["agent --token flag-secret", "flag-secret"],
    ["agent --token=equals-secret", "equals-secret"],
    ['curl -u "user:password-secret" https://example.test', "user:password-secret"],
    ["echo AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
  ];
  for (const [command, secret] of redactionCases) {
    assert.equal(redactCommandForAudit(command).includes(secret), false, "secret leaked: " + command);
  }
  assert.equal(redactCommandForAudit("echo hello").includes("hello"), true);

  const requestBodies: Payload[] = [];
  let requests = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      requests += 1;
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown as Payload);
      res.writeHead(requests === 1 ? 503 : 200);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  configureAudit({ path: "", endpoint: "http://127.0.0.1:" + address.port, headers: { "x-audit-check": "1" } });
  try {
    audit({ event: "sandbox.exec", sandboxId: "retry-test", attributes: { cost: 0.5 } });
    await flushAudit();
    assert.equal(requests, 1, "first OTLP attempt should be made");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await flushAudit();
    assert.equal(requests, 2, "failed OTLP batch should be retried");
    const retried = requestBodies[1]!.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
    assert.deepEqual(attribute(retried.attributes, "cost"), { doubleValue: 0.5 });

    const beforeBatches = requests;
    for (let i = 0; i < AUDIT_LIMITS.maxBatchEvents + 2; i++) {
      audit({ event: "batch.sample", sandboxId: "batch-test", attributes: { index: i } });
    }
    await flushAudit();
    await flushAudit();
    const boundedBatches = requestBodies.slice(beforeBatches);
    assert.equal(boundedBatches.length, 2);
    assert.deepEqual(boundedBatches.map((body) => body.resourceLogs[0]!.scopeLogs[0]!.logRecords.length), [128, 2]);

    const beforeQueue = requestBodies.length;
    for (let i = 0; i < AUDIT_LIMITS.maxQueueEvents + 2; i++) {
      audit({ event: "queue.sample", sandboxId: "queue-test", attributes: { index: i } });
    }
    for (let i = 0; i < Math.ceil(AUDIT_LIMITS.maxQueueEvents / AUDIT_LIMITS.maxBatchEvents); i++) {
      await flushAudit();
    }
    const queuedLogs = requestBodies.slice(beforeQueue)
      .flatMap((body) => body.resourceLogs[0]!.scopeLogs[0]!.logRecords);
    assert.equal(queuedLogs.length, AUDIT_LIMITS.maxQueueEvents, "queue must remain bounded");
    assert.ok(requestBodies.slice(beforeQueue).every((body) =>
      body.resourceLogs[0]!.scopeLogs[0]!.logRecords.length <= AUDIT_LIMITS.maxBatchEvents));

    const beforeOversized = requests;
    audit({ event: "oversized.sample", sandboxId: "large", attributes: { value: "x".repeat(AUDIT_LIMITS.maxBatchBytes + 1024) } });
    await flushAudit();
    assert.equal(requests, beforeOversized, "an oversized single record must not be sent");
  } finally {
    await stopAudit();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
  console.log("audit check passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
