/**
 * API auth check (Docker- and VM-free): the daemon's API key is always on and
 * browsers on other origins are refused. Covers the generated key file, the
 * REST and terminal guards, and the SDK's loopback-only key fallback.
 * Run: `npm run check:auth`.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HotcellClient, localApiKey } from "@hotcell/sdk";
import { ensureApiKey } from "./api-key.js";
import { createApiServer } from "./api/server.js";
import { BackupRegistry } from "./backups.js";
import { loadConfig } from "./config.js";
import type { Driver } from "./driver/types.js";
import { SandboxStore } from "./store.js";

let passed = 0;
const ok = (label: string) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

function keyFileChecks(home: string): string {
  const file = join(home, "api-key");
  const first = ensureApiKey("", file);
  assert.equal(first.source, "generated");
  assert.match(first.key, /^[0-9a-f]{64}$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(home).mode & 0o077, 0);
  ok("no key configured: generates a 256-bit key in a 0600 file");

  const again = ensureApiKey("", file);
  assert.deepEqual([again.source, again.key], ["file", first.key]);
  ok("restart reuses the same key");

  assert.deepEqual(ensureApiKey("operator-key", file), { key: "operator-key", source: "config" });
  ok("an explicit HOTCELL_API_KEY wins over the file");

  chmodSync(file, 0o644);
  ensureApiKey("", file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  ok("a key file with loose permissions is tightened to 0600");

  const junk = join(home, "junk-key");
  writeFileSync(junk, "short\n");
  assert.throws(() => ensureApiKey("", junk), /no usable API key/);
  ok("an unusable key file is reported, not silently replaced");
  return first.key;
}

interface Reply {
  status: number;
  body: string;
}

function call(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function serverChecks(key: string, home: string): Promise<void> {
  const created: string[] = [];
  const driver = {
    name: "container",
    ping: async () => {},
    create: async (o: { id: string }) => {
      created.push(o.id);
      throw new Error("auth-check: create must not be reached");
    },
  } as unknown as Driver;
  const backupsDir = mkdtempSync(join(tmpdir(), "hotcell-auth-backups-"));
  const server = createApiServer({
    config: { ...loadConfig(), host: "127.0.0.1", apiKey: key },
    driver,
    store: new SandboxStore(":memory:"),
    backups: new BackupRegistry(backupsDir),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const auth = { authorization: `Bearer ${key}` };
  try {
    assert.equal((await call(port, "/sandboxes")).status, 401);
    assert.equal((await call(port, "/sandboxes", { headers: auth })).status, 200);
    ok("REST: no key → 401, the key → 200");

    const evilPost = await call(port, "/sandboxes", {
      method: "POST",
      headers: { ...auth, origin: "https://evil.example", "content-type": "text/plain", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ setup: ["curl https://evil.example"] }),
    });
    assert.equal(evilPost.status, 403);
    assert.deepEqual(created, []);
    ok("REST: a cross-site POST is refused before any sandbox is created");

    assert.equal((await call(port, "/sandboxes", { headers: { ...auth, "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await call(port, "/sandboxes", { headers: { ...auth, "sec-fetch-site": "same-site" } })).status, 403);
    assert.equal((await call(port, "/sandboxes", { headers: { ...auth, origin: "null" } })).status, 403);
    ok("REST: cross-site, same-site (other port) and opaque origins are refused");

    const sameOrigin = { ...auth, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" };
    assert.equal((await call(port, "/sandboxes", { headers: sameOrigin })).status, 200);
    ok("REST: the dashboard's own same-origin requests still work");

    assert.equal((await call(port, "/dashboard", { headers: { "sec-fetch-site": "cross-site" } })).status, 200);
    assert.equal((await call(port, "/healthz", { headers: { "sec-fetch-site": "cross-site" } })).status, 200);
    ok("REST: a link to the dashboard and health probes stay open");

    const ws = await call(port, `/sandboxes/x/terminal?key=${key}`, {
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", origin: "https://evil.example" },
    });
    assert.equal(ws.status, 403);
    ok("terminal: a cross-site WebSocket upgrade is refused even with the key");

    process.env.HOTCELL_HOME = home;
    delete process.env.HOTCELL_API_KEY;
    delete process.env.SBX_API_KEY;
    const sandboxes = await new HotcellClient({ endpoint: `http://127.0.0.1:${port}` }).list();
    assert.deepEqual(sandboxes, []);
    assert.equal(localApiKey(`http://127.0.0.1:${port}`), key);
    assert.equal(localApiKey("https://hotcell.example.com"), "");
    ok("SDK: a loopback client finds the local key; a remote endpoint never gets it");
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(backupsDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const home = join(mkdtempSync(join(tmpdir(), "hotcell-auth-")), "home");
  try {
    const key = keyFileChecks(home);
    await serverChecks(key, home);
    console.log(`auth check: ${passed} passed`);
  } finally {
    rmSync(join(home, ".."), { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
