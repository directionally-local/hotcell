import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AUDIT_LIMITS,
  audit,
  buildAuditEntry,
  buildOtlpLogsPayload,
  configureAudit,
  drainAudit,
  flushAudit,
  redactCommandForAudit,
  redactSecrets,
  safeRepoForLog,
  stopAudit,
} from "./audit.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupRegistry } from "./backups.js";
import { SandboxStore } from "./store.js";

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
  // -u is only a secret when it carries user:password.
  assert.equal(redactCommandForAudit("git push -u origin main"), "git push -u origin main");
  assert.equal(redactCommandForAudit("sort -u names.txt"), "sort -u names.txt");
  assert.equal(redactCommandForAudit("curl -u alice:s3cret https://x.test").includes("s3cret"), false);
  assert.equal(redactCommandForAudit("curl --user=alice:s3cret https://x.test").includes("s3cret"), false);

  // Driver logs of setup steps / repo URLs (redactSecrets is the full-length
  // form the drivers log with). The gateway-wired git remote embeds the
  // sandbox's egress token as URL userinfo.
  const egressToken = SandboxStore.newEgressToken();
  const remoteStep = `git -C /workspace/app remote set-url origin 'http://x-access-token:${egressToken}@127.0.0.1:4751/github-git/o/app.git'`;
  for (const redact of [redactSecrets, redactCommandForAudit]) {
    const out = redact(remoteStep);
    assert.equal(out.includes(egressToken), false, "egress token leaked from git remote step");
    assert.ok(out.includes("127.0.0.1:4751/github-git/o/app.git"), "host/path kept for debugging");
  }
  assert.equal(redactSecrets(`echo ${egressToken}`).includes(egressToken), false, "bare egress token redacted");
  for (const url of ["https://alice:ghp_notreallyatoken@github.com/o/r.git", "https://alice:p@ss@github.com/o/r", "ssh://git:s3cret@host/r"]) {
    const out = redactSecrets(`git clone --depth 1 '${url}'`);
    assert.equal(/notreallyatoken|p@ss|ss@github|s3cret/.test(out), false, "URL userinfo leaked: " + out);
  }
  const long = "x".repeat(600) + " https://u:longsecret@h/r";
  assert.equal(redactSecrets(long).length > 512, true, "log redaction does not truncate");
  assert.equal(redactSecrets(long).includes("longsecret"), false);
  assert.equal(safeRepoForLog("https://user:pat123@github.com/o/r.git?x=1#f"), "https://github.com/o/r.git");
  assert.equal(safeRepoForLog("https://github.com/o/r"), "https://github.com/o/r");

  // Backup ids are validated inside BackupRegistry: a traversal id never maps
  // to a path outside the backup dir.
  {
    const root = mkdtempSync(join(tmpdir(), "hotcell-backups-"));
    try {
      const reg = new BackupRegistry(join(root, "backups"));
      writeFileSync(join(root, "outside.json"), JSON.stringify({ backupId: "x", sandboxId: "s", createdAt: "", bytes: 1 }));
      writeFileSync(join(root, "outside.tar"), "not yours");
      for (const bad of ["../outside", "../../etc/passwd", "a/b", "", "ABCDEF012345", "0123456789ab.", "0123456789abc"]) {
        assert.equal(await reg.get(bad), undefined, `get(${bad}) must be undefined`);
        assert.equal(await reg.remove(bad), false, `remove(${bad}) must be false`);
        assert.throws(() => reg.tarPath(bad), /invalid backup id/, `tarPath(${bad}) must throw`);
      }
      const id = SandboxStore.newBackupId();
      await reg.save({ backupId: id, sandboxId: "s1", createdAt: new Date().toISOString(), bytes: 3 });
      assert.equal((await reg.get(id))?.sandboxId, "s1", "a minted id round-trips");
      assert.equal((await reg.list()).length, 1);
      assert.equal(await reg.remove(id), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

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

    const beforeDrain = requestBodies.length;
    for (let i = 0; i < AUDIT_LIMITS.maxBatchEvents * 3; i++) {
      audit({ event: "drain.sample", sandboxId: "drain-test", attributes: { index: i } });
    }
    await drainAudit(AUDIT_LIMITS.maxBatchesPerTick);
    assert.equal(requestBodies.length - beforeDrain, 3, "one drain sends every ready batch");

    const beforeShutdown = requestBodies.length;
    for (let i = 0; i < AUDIT_LIMITS.maxBatchEvents * 2; i++) {
      audit({ event: "shutdown.sample", sandboxId: "shutdown-test", attributes: { index: i } });
    }
    await drainAudit(Number.POSITIVE_INFINITY, Date.now() + AUDIT_LIMITS.shutdownDrainMs);
    assert.equal(requestBodies.length - beforeShutdown, 2, "shutdown drain empties the queue");

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
