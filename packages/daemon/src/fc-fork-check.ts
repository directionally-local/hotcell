/**
 * Snapshot-fork check (issue #36). Exercises everything about template capture
 * and fork that does **not** need `/dev/kvm`: the vmstate path rewriter, the
 * clone layout (hard-linked memory, reflinked disks, rewritten paths), the
 * template store, and the REST surface (capture → list → fork → delete) against
 * a stub driver.
 *
 * The live restore — actually loading a snapshot into a fresh VMM and reseeding
 * the guest — is gated behind `smoke:fc:full` on a KVM host. Run: `npm run
 * check:fc-fork`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "./api/server.js";
import { BackupRegistry } from "./backups.js";
import { loadConfig } from "./config.js";
import { rewriteSnapshotPaths } from "./driver/fc-api.js";
import { prepareForkClone, readTemplateMeta } from "./driver/firecracker.js";
import type { CreateTemplateOptions, Driver, ForkOptions, TemplateInfo } from "./driver/types.js";
import { SandboxStore } from "./store.js";
import type { TemplateRecord } from "./types.js";

let passed = 0;
const ok = (label: string): void => {
  passed++;
  console.log(`  ✓ ${label}`);
};

/** A vmstate shaped like Firecracker's: absolute paths for drives + vsock. */
function fakeVmstate(dir: string): string {
  return JSON.stringify({
    version: "1.0.0",
    machine_config: { vcpu_count: 2, mem_size_mib: 512 },
    drives: [
      { drive_id: "rootfs", path_on_host: `${dir}/rootfs.img`, is_root_device: true },
      { drive_id: "workspace", path_on_host: `${dir}/workspace.img`, is_root_device: false },
    ],
    vsock: { guest_cid: 3, uds_path: `${dir}/vsock.sock` },
    // A path outside the template dir (the shared read-only kernel) must survive.
    boot_source: { kernel_image_path: "/opt/hotcell/vmlinux" },
  });
}

function pathChecks(): void {
  const from = "/state/_templates/base";
  const to = "/state/abc123";
  const out = JSON.parse(rewriteSnapshotPaths(fakeVmstate(from), from, to)) as any;
  assert.equal(out.drives[0].path_on_host, `${to}/rootfs.img`);
  assert.equal(out.drives[1].path_on_host, `${to}/workspace.img`);
  assert.equal(out.vsock.uds_path, `${to}/vsock.sock`);
  assert.equal(out.boot_source.kernel_image_path, "/opt/hotcell/vmlinux", "paths outside the template are untouched");
  assert.equal(out.machine_config.mem_size_mib, 512, "non-path values are preserved");
  ok("rewriteSnapshotPaths: rewrites every path under the template dir, leaves the rest alone");

  // A sibling directory that merely shares a prefix must not be rewritten.
  const sibling = JSON.parse(
    rewriteSnapshotPaths(JSON.stringify({ p: `${from}-other/x` }), from, to),
  ) as any;
  assert.equal(sibling.p, `${from}-other/x`, "prefix-only matches are not rewritten");
  // Trailing slashes on either side are tolerated.
  const slashed = JSON.parse(
    rewriteSnapshotPaths(JSON.stringify({ p: `${from}/a` }), `${from}/`, `${to}/`),
  ) as any;
  assert.equal(slashed.p, `${to}/a`);
  ok("rewriteSnapshotPaths: prefix-only matches and trailing slashes handled");

  assert.throws(() => rewriteSnapshotPaths("{not json", from, to), "malformed vmstate fails loudly");
  ok("rewriteSnapshotPaths: malformed JSON throws instead of producing a broken clone");
}

function cloneChecks(root: string): void {
  const templateDir = join(root, "_templates", "base");
  const cloneDir = join(root, "clone1");
  mkdirSync(templateDir, { recursive: true });
  mkdirSync(cloneDir, { recursive: true });
  writeFileSync(join(templateDir, "snapshot.vmstate"), fakeVmstate(templateDir));
  writeFileSync(join(templateDir, "snapshot.mem"), Buffer.alloc(4096, 7));
  writeFileSync(join(templateDir, "workspace.img"), Buffer.alloc(8192, 1));
  writeFileSync(
    join(templateDir, "meta.json"),
    JSON.stringify({
      name: "base",
      image: "base",
      limits: { memoryMb: 512, cpus: 2 },
      createdAt: new Date().toISOString(),
      disks: ["workspace.img"],
      sourceDir: "/state/src",
    }),
  );

  const { vmstate, memFile } = prepareForkClone(templateDir, cloneDir);
  assert.equal(vmstate, join(cloneDir, "snapshot.vmstate"));
  assert.equal(memFile, join(cloneDir, "snapshot.mem"));

  const clone = JSON.parse(readFileSync(vmstate, "utf8")) as any;
  assert.equal(clone.drives[1].path_on_host, join(cloneDir, "workspace.img"));
  assert.equal(clone.vsock.uds_path, join(cloneDir, "vsock.sock"));
  assert.equal(clone.boot_source.kernel_image_path, "/opt/hotcell/vmlinux");
  ok("prepareForkClone: the clone's vmstate points at the clone's own disks + vsock");

  const template = JSON.parse(readFileSync(join(templateDir, "snapshot.vmstate"), "utf8")) as any;
  assert.equal(template.drives[1].path_on_host, join(templateDir, "workspace.img"), "the template is not mutated");
  ok("prepareForkClone: the template's own vmstate is left untouched (it can be forked again)");

  // The memory file is hard-linked, not copied: a fork must not cost a gigabyte.
  assert.equal(
    statSync(memFile).ino,
    statSync(join(templateDir, "snapshot.mem")).ino,
    "the memory file is shared by inode (copy-on-write mapping)",
  );
  // The workspace disk is a real copy: guest writes must not reach the template.
  assert.notEqual(
    statSync(join(cloneDir, "workspace.img")).ino,
    statSync(join(templateDir, "workspace.img")).ino,
    "the workspace disk is a private copy",
  );
  ok("prepareForkClone: memory is hard-linked (free), the workspace disk is private");

  assert.throws(() => readTemplateMeta(join(root, "_templates", "nope")), /metadata missing/);
  ok("readTemplateMeta: a missing template fails with an actionable error");
}

function storeChecks(): void {
  const store = new SandboxStore(":memory:");
  const record: TemplateRecord = {
    name: "base",
    driver: "firecracker",
    image: "base",
    limits: { memoryMb: 512 },
    sourceSandboxId: "abc",
    createdAt: new Date().toISOString(),
    sizeBytes: 1234,
  };
  store.addTemplate(record);
  assert.deepEqual(store.getTemplate("base"), record);
  assert.equal(store.listTemplates().length, 1);
  // Upsert, not duplicate.
  store.addTemplate({ ...record, sizeBytes: 99 });
  assert.equal(store.listTemplates().length, 1);
  assert.equal(store.getTemplate("base")!.sizeBytes, 99);
  assert.equal(store.removeTemplate("base"), true);
  assert.equal(store.getTemplate("base"), undefined);
  assert.equal(store.removeTemplate("base"), false);
  store.close();
  ok("store: templates upsert, list, and delete (idempotent)");
}

interface Reply {
  status: number;
  body: string;
}

function call(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function restChecks(): Promise<void> {
  const forked: ForkOptions[] = [];
  const captured: CreateTemplateOptions[] = [];
  const deleted: string[] = [];
  const driver = {
    name: "firecracker",
    ping: async () => {},
    supportsTemplates: () => true,
    create: async () => {
      throw new Error("fc-fork-check: a template create must fork, not cold-boot");
    },
    fork: async (opts: ForkOptions) => {
      forked.push(opts);
    },
    createTemplate: async (opts: CreateTemplateOptions): Promise<TemplateInfo> => {
      captured.push(opts);
      return {
        name: opts.name,
        image: opts.image,
        limits: opts.limits,
        createdAt: new Date().toISOString(),
        sizeBytes: 4096,
        sourceSandboxId: opts.sourceId,
      };
    },
    deleteTemplate: async (name: string) => {
      deleted.push(name);
    },
    destroy: async () => {},
  } as unknown as Driver;

  const store = new SandboxStore(":memory:");
  const backupsDir = mkdtempSync(join(tmpdir(), "hotcell-fc-fork-backups-"));
  const server = createApiServer({
    config: { ...loadConfig(), host: "127.0.0.1", apiKey: "" },
    driver,
    store,
    backups: new BackupRegistry(backupsDir),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const json = { "content-type": "application/json" };
  try {
    // A template needs a running source sandbox.
    const missing = await call(port, "/templates", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "base", from: "nope" }),
    });
    assert.equal(missing.status, 404);
    ok("REST: capturing from an unknown sandbox is a 404");

    const source = store.get("src1") ?? {
      id: "src1",
      image: "base",
      status: "running" as const,
      createdAt: new Date().toISOString(),
      driver: "firecracker",
      labels: {},
      env: {},
      persist: true,
      lastActivityAt: new Date().toISOString(),
      sleepAfterMs: 0,
      limits: { memoryMb: 512, cpus: 2 },
      usage: {
        cpuSeconds: 0,
        memByteSeconds: 0,
        egressBytes: 0,
        providerCalls: 0,
        providerBytes: 0,
        providerTokensIn: 0,
        providerTokensOut: 0,
        providerCost: 0,
        lastCpuTotalNs: 0,
        lastSampledAt: "",
      },
    };
    store.add(source);

    const badName = await call(port, "/templates", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "Bad Name!", from: "src1" }),
    });
    assert.equal(badName.status, 400);
    ok("REST: template names are validated (they double as directory names)");

    const created = await call(port, "/templates", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "base", from: "src1" }),
    });
    assert.equal(created.status, 201, created.body);
    const template = JSON.parse(created.body) as TemplateRecord;
    assert.equal(template.name, "base");
    assert.equal(template.driver, "firecracker");
    assert.deepEqual(template.limits, { memoryMb: 512, cpus: 2 });
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.sourceId, "src1");
    ok("REST: POST /templates captures on the source's driver and persists the record");

    const dup = await call(port, "/templates", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "base", from: "src1" }),
    });
    assert.equal(dup.status, 409);
    ok("REST: capturing the same name twice is a 409");

    const listed = await call(port, "/templates");
    assert.equal(listed.status, 200);
    assert.equal((JSON.parse(listed.body) as { templates: TemplateRecord[] }).templates.length, 1);
    ok("REST: GET /templates lists captured templates");

    // A fork inherits image/driver/limits from the template.
    const forkedRes = await call(port, "/sandboxes", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ template: "base" }),
    });
    assert.equal(forkedRes.status, 201, forkedRes.body);
    const sandbox = JSON.parse(forkedRes.body) as { id: string; image: string; driver: string; limits: unknown };
    assert.equal(sandbox.image, "base");
    assert.equal(sandbox.driver, "firecracker");
    assert.deepEqual(sandbox.limits, { memoryMb: 512, cpus: 2 });
    assert.equal(forked.length, 1);
    assert.equal(forked[0]!.template, "base");
    assert.equal(forked[0]!.id, sandbox.id);
    ok("REST: POST /sandboxes {template} forks (never cold-boots) and inherits the shape");

    const baked = await call(port, "/sandboxes", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ template: "base", repo: "https://github.com/a/b.git" }),
    });
    assert.equal(baked.status, 400);
    assert.match(baked.body, /baked in/);
    ok("REST: provisioning flags are refused alongside a template");

    const wrongShape = await call(port, "/sandboxes", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ template: "base", memoryMb: 4096 }),
    });
    assert.equal(wrongShape.status, 400);
    assert.match(wrongShape.body, /must match/);
    ok("REST: a fork cannot change the snapshot's resource shape");

    const unknown = await call(port, "/sandboxes", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ template: "ghost" }),
    });
    assert.equal(unknown.status, 404);
    ok("REST: forking an unknown template is a 404");

    const removed = await call(port, "/templates/base", { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.deepEqual(deleted, ["base"]);
    assert.equal(store.getTemplate("base"), undefined);
    assert.equal((await call(port, "/templates/base", { method: "DELETE" })).status, 404);
    ok("REST: DELETE /templates/:name removes the row and the driver's snapshot");
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(backupsDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "hotcell-fc-fork-"));
  try {
    pathChecks();
    cloneChecks(root);
    storeChecks();
    await restChecks();
    console.log(`\nfc-fork-check: ${passed} checks passed (host-agnostic; live restore is smoke:fc:full)`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("fc-fork-check FAILED:", err);
    process.exit(1);
  },
);
