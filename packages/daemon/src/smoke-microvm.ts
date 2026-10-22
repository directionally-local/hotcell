/**
 * MicroVM parity smoke. Boots an in-process daemon backed by a **microVM
 * driver** — Apple VZ (default) or Firecracker via `SBX_SMOKE_DRIVER` — and
 * drives the full sandbox surface through the daemon's HTTP/SSE stack via the
 * public TypeScript SDK — the same flow `npm run smoke` exercises against the
 * container driver. This is the plan's parity gate: the *same* end-to-end flow
 * must work on every driver, proving the driver abstraction holds from
 * REST → SSE → SDK down to a real microVM.
 *
 * Unlike the driver-direct checks (`applevz-check.ts`, `smoke-fc.ts`), this goes
 * through the daemon server, the preview proxy, and the SDK — so it covers the
 * integration those don't.
 *  - applevz: needs a Mac with the VZ helper + guest artifacts built
 *    (`npm run build:vz`, `build:agent`, `build-guest.sh`). `npm run smoke:vz`.
 *  - firecracker: needs a Linux KVM host with `firecracker`, a guest kernel at
 *    `helpers/hotcell-vz/guest/vmlinux-fc`, and the amd64 agent staged (see plan
 *    Appendix B). `npm run smoke:fc:full`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { BackupRegistry } from "./backups.js";
import { Capacity } from "./capacity.js";
import { loadConfig } from "./config.js";
import { DriverRouter } from "./driver/router.js";
import { MetricsHistory } from "./metrics.js";
import { SandboxStore } from "./store.js";
import { createApiServer } from "./api/server.js";
import { createProxyServer } from "./proxy/server.js";
import { HotcellClient, type Sandbox } from "@hotcell/sdk";

async function main(): Promise<number> {
  // Force the microVM driver + isolated ports/state so the run leaves nothing
  // behind and never collides with a dev daemon on the default ports.
  const driverName = process.env.SBX_SMOKE_DRIVER ?? "applevz";
  process.env.SBX_DRIVER = driverName;
  const config = loadConfig();
  config.driver = driverName;
  config.port = 4790;
  config.proxyPort = 4791;
  config.backupDir = await mkdtemp(join(tmpdir(), "hotcell-mvm-backups-"));
  const dbDir = await mkdtemp(join(tmpdir(), "hotcell-mvm-db-"));
  config.dbPath = join(dbDir, "state.db");
  const stateDir = await mkdtemp(join(tmpdir(), "hotcell-mvm-state-"));
  if (driverName === "firecracker") {
    config.fcStateDir = stateDir; // image cache stays at the stable default
  } else {
    config.vzStateDir = stateDir;
    config.vzImageCacheDir = join(homedir(), ".sbx", "vz", "images"); // stable cache
  }
  // The prebuilt "base" rootfs sentinel is an arm64 VZ artifact; Firecracker
  // hosts convert an OCI image for the host arch instead (cached after first use).
  const image =
    process.env.SBX_SMOKE_IMAGE ?? (driverName === "firecracker" ? "alpine:3.20" : "base");

  const store = new SandboxStore(config.dbPath);
  const driver = new DriverRouter(config, store, config.driver);
  const backups = new BackupRegistry(config.backupDir);
  const history = new MetricsHistory(config.metricsHistory);
  const capacity = new Capacity(store, config, null, history);

  const server = createApiServer({ config, driver, store, backups, history, capacity });
  await new Promise<void>((r) => server.listen(config.port, config.host, r));
  const proxy = createProxyServer({ config, driver, store });
  await new Promise<void>((r) => proxy.listen(config.proxyPort, config.proxyHost, r));
  const endpoint = `http://${config.host}:${config.port}`;
  const proxyEndpoint = `http://${config.proxyHost}:${config.proxyPort}`;
  const client = new HotcellClient({ endpoint });

  let passed = 0;
  const ok = (l: string) => {
    passed++;
    console.error(`  ✓ ${l}`);
  };
  const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  let sandbox: Sandbox | undefined;
  try {
    // 1. Health + info: the daemon reports the microVM driver.
    const health = await client.health();
    assert(health.ok, "daemon health not ok");
    const info = await client.info();
    assert(info.driver === driverName, `expected driver=${driverName}, got ${info.driver}`);
    ok(`daemon up on the ${driverName} driver (${endpoint})`);

    // 2. Create a microVM sandbox.
    sandbox = await client.getSandbox(undefined, { image });
    ok(`created microVM sandbox ${sandbox.id} (${image})`);

    // 3. exec streams stdout/exit over SSE and runs in a real Linux VM.
    const uname = await sandbox.exec("echo hi-from-vm && uname -sm");
    assert(uname.exitCode === 0, `exec exit ${uname.exitCode}`);
    assert(/hi-from-vm/.test(uname.stdout), "exec stdout missing");
    assert(/Linux (aarch64|x86_64)/.test(uname.stdout), "not a real Linux VM");
    ok(`exec over SSE → ${uname.stdout.trim().replace(/\n/g, " | ")}`);

    // 4. Files: write/read/mkdir/list through REST.
    await sandbox.writeFile("/workspace/hello.txt", "vz-files");
    assert((await sandbox.readFile("/workspace/hello.txt")) === "vz-files", "readFile mismatch");
    await sandbox.mkdir("/workspace/sub");
    const files = await sandbox.listFiles("/workspace");
    assert(files.some((f) => f.name === "hello.txt"), "listFiles missing file");
    assert(files.some((f) => f.name === "sub" && f.isDirectory), "listFiles missing dir");
    ok("files: write / read / mkdir / list");

    // 5. Sandbox env + session cwd persistence.
    await sandbox.setEnvVars({ SBX_MVM_SMOKE: "env-ok" });
    const envOut = await sandbox.exec("echo $SBX_MVM_SMOKE");
    assert(/env-ok/.test(envOut.stdout), "sandbox env not applied");
    const session = await sandbox.createSession({ cwd: "/workspace/sub" });
    await session.exec("echo cwd-marker > here.txt");
    const cwdRead = await sandbox.readFile("/workspace/sub/here.txt");
    assert(/cwd-marker/.test(cwdRead), "session cwd not honored");
    ok("env applied + session cwd persists");

    // 6. Background process + port readiness + preview proxy fetch.
    const proc = await sandbox.startProcess(httpServerCommand(9000, "mvm-preview-ok"));
    assert(Number.isFinite(proc.pid), "startProcess returned no pid");
    const ready = await sandbox.waitForPort(9000, { timeoutMs: 8000 });
    assert(ready, "port 9000 never became ready");
    await sandbox.exposePort(9000);
    const preview = await fetch(`${proxyEndpoint}/_hotcell/${sandbox.id}/9000/`);
    const previewBody = await preview.text();
    assert(/mvm-preview-ok/.test(previewBody), `preview proxy did not serve: ${previewBody.slice(0, 60)}`);
    ok("background process → waitForPort → preview proxy round-trip");

    // 7. watch: open the stream, create a file, see the event. The SDK watch is
    //    an async generator; calling return() closes the underlying SSE stream.
    const watchGen = sandbox.watch("/workspace", { intervalMs: 200 });
    let sawWatch = false;
    const watching = (async () => {
      for await (const ev of watchGen) {
        if (/watched\.txt/.test(ev.path)) {
          sawWatch = true;
          break;
        }
      }
    })().catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    await sandbox.writeFile("/workspace/watched.txt", "x");
    for (let i = 0; i < 30 && !sawWatch; i++) await new Promise((r) => setTimeout(r, 100));
    await watchGen.return(undefined); // unblock + close the stream if still pending
    await watching;
    assert(sawWatch, "watch never reported the new file");
    ok("watch streamed a create event");

    // 8. Backup → mutate → restore → rollback.
    await sandbox.writeFile("/workspace/keep.txt", "in-backup");
    const backup = await sandbox.createBackup();
    await sandbox.writeFile("/workspace/keep.txt", "MUTATED");
    await sandbox.restoreBackup(backup.backupId);
    assert((await sandbox.readFile("/workspace/keep.txt")) === "in-backup", "restore did not roll back");
    ok("backup → mutate → restore → rollback");

    // 9. Metrics: the sampler/stats path reports usage through the daemon.
    const metrics = await sandbox.metrics();
    assert(metrics.live ? metrics.live.memBytes > 0 : true, "live metrics memBytes should be > 0");
    ok(`metrics endpoint served (live mem ${metrics.live ? (metrics.live.memBytes / 1e6).toFixed(0) + "MB" : "n/a"})`);

    // 10. Persistence across stop/start (cold resume; workspace survives).
    await sandbox.stop();
    await sandbox.start();
    assert((await sandbox.readFile("/workspace/keep.txt")) === "in-backup", "workspace lost across stop/start");
    ok("workspace persists across stop/start");

    // 11. Manual pause = memory snapshot: a background process AND an exposed
    //     server survive, and an inbound preview request transparently WAKES the
    //     paused sandbox (what lets the reaper hibernate port-exposing sandboxes).
    const survivor = await sandbox.startProcess("while true; do sleep 1; done");
    await sandbox.startProcess(httpServerCommand(9100, "wake-ok"));
    assert(await sandbox.waitForPort(9100, { timeoutMs: 8000 }), "port 9100 never ready");
    await sandbox.exposePort(9100);
    await sandbox.pause();
    const woke = await fetch(`${proxyEndpoint}/_hotcell/${sandbox.id}/9100/`);
    assert(/wake-ok/.test(await woke.text()), "preview request did not wake the paused sandbox");
    const back = await sandbox.exec(`kill -0 ${survivor.pid} 2>/dev/null && echo SURVIVED`);
    assert(/SURVIVED/.test(back.stdout), "background process did not survive pause/resume");
    ok("pause (memory snapshot) → preview request wakes the VM; processes alive");

    console.error(`\n[smoke-microvm] passed — ${passed} checks (full surface on the ${driverName} driver)`);
    return 0;
  } catch (err) {
    console.error(`[smoke-microvm] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    if (sandbox) await sandbox.destroy().catch(() => {});
    await new Promise<void>((r) => proxy.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    await rm(config.backupDir, { recursive: true, force: true }).catch(() => {});
    await rm(dbDir, { recursive: true, force: true }).catch(() => {});
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().then((code) => process.exit(code));

/**
 * A shell one-liner serving `body` over HTTP on `port` with whatever the image has:
 * busybox nc (the Alpine base) or python3 (hotcell-base and other Debian images,
 * which ship no nc).
 */
function httpServerCommand(port: number, body: string): string {
  const dir = `/tmp/http-${port}`;
  return (
    `if command -v nc >/dev/null; then while true; do printf 'HTTP/1.0 200 OK\\r\\n\\r\\n${body}' | nc -l -p ${port} 2>/dev/null; done; ` +
    `else mkdir -p ${dir} && printf '${body}' > ${dir}/index.html && cd ${dir} && exec python3 -m http.server ${port}; fi`
  );
}
