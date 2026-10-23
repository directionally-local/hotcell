/**
 * Secrets-at-rest file-mode check. Run: `npm run check:filemodes`.
 *
 * `${HOTCELL_HOME}/config.json` can hold HOTCELL_API_KEY and other secrets, and
 * the daemon's `state.db` (+ its `-wal`/`-shm`) holds egress tokens and injected
 * sandbox env. All of them must be owner-only: the home dir 0700, the files
 * 0600, including files an older version left 0644 (tightened on next read /
 * open). Runs with a permissive umask so a default-mode create would show up.
 * POSIX only (Windows relies on the user-profile ACL). No Docker, no daemon.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let checks = 0;
const ok = (msg: string) => {
  checks++;
  console.log(`  ✓ ${msg}`);
};
const modeOf = (p: string) => (statSync(p).mode & 0o777).toString(8).padStart(3, "0");

async function main(): Promise<void> {
  if (process.platform === "win32") {
    console.log("filemodes-check: skipped on Windows (POSIX modes)");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "hotcell-filemodes-"));
  try {
    process.umask(0o022); // the common default: plain creates would come out 0644/0755
    const home = join(root, "home");
    process.env.HOTCELL_HOME = home; // read at import by both config modules
    const cfg = await import("./configfile.js");

    // 1. First write creates the home 0700 and the file 0600 (no tmp left behind).
    cfg.writeConfigFile({ HOTCELL_API_KEY: "hc_secret" });
    assert.equal(modeOf(home), "700", "home dir is 0700");
    assert.equal(modeOf(cfg.CONFIG_FILE), "600", "config.json is 0600");
    assert.ok(!existsSync(cfg.CONFIG_FILE + ".tmp"), "no tmp file left behind");
    ok("writeConfigFile: home 0700, config.json 0600");

    // 2. A stale, world-readable tmp from an interrupted write is not reused as-is,
    //    and a loose existing home dir is tightened.
    chmodSync(home, 0o755);
    writeFileSync(cfg.CONFIG_FILE + ".tmp", "{}", { mode: 0o644 });
    cfg.writeConfigFile({ HOTCELL_API_KEY: "hc_secret2" });
    assert.equal(modeOf(home), "700", "loose home dir tightened");
    assert.equal(modeOf(cfg.CONFIG_FILE), "600", "config.json 0600 despite stale 0644 tmp");
    ok("writeConfigFile: stale 0644 tmp and 0755 home do not leak through");

    // 3. A 0644 config.json from an older CLI is tightened on read (CLI + daemon).
    chmodSync(cfg.CONFIG_FILE, 0o644);
    assert.equal(cfg.readConfigFile().HOTCELL_API_KEY, "hc_secret2");
    assert.equal(modeOf(cfg.CONFIG_FILE), "600", "CLI read tightens config.json");
    chmodSync(cfg.CONFIG_FILE, 0o644);
    const daemonCfg = await import("@hotcell/daemon/dist/config.js");
    assert.equal(daemonCfg.CONFIG_FILE, cfg.CONFIG_FILE, "daemon and CLI agree on the path");
    assert.equal(modeOf(cfg.CONFIG_FILE), "600", "daemon startup read tightens config.json");
    ok("existing 0644 config.json tightened to 0600 on CLI read and daemon start");

    // 4. state.db and its WAL side files are 0600 even under umask 0 (SQLite's
    //    default create mode is 0644, so this fails without the fix).
    process.umask(0);
    const { SandboxStore } = await import("@hotcell/daemon/dist/store.js");
    const dbDir = join(root, "state");
    const dbPath = join(dbDir, "state.db");
    const store = new SandboxStore(dbPath); // migrate() writes → creates -wal/-shm
    try {
      assert.ok(existsSync(dbPath + "-wal") && existsSync(dbPath + "-shm"), "WAL side files exist while open");
      assert.equal(modeOf(dbDir), "700", "new state dir is 0700");
      for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) assert.equal(modeOf(f), "600", `${f} is 0600`);
    } finally {
      store.close();
    }
    ok("state.db, -wal, -shm created 0600 (umask 0), state dir 0700");

    // 5. Loose files left by an older daemon (incl. a crash-leftover WAL) are tightened at open.
    process.umask(0o022);
    const old = join(root, "old");
    const oldDb = join(old, "state.db");
    mkdirSync(old, { recursive: true });
    // Empty files: SQLite treats a 0-byte db as new and a 0-byte WAL as empty.
    for (const f of [oldDb, oldDb + "-wal", oldDb + "-shm"]) writeFileSync(f, "", { mode: 0o644 });
    const reopened = new SandboxStore(oldDb);
    try {
      for (const f of [oldDb, oldDb + "-wal", oldDb + "-shm"]) assert.equal(modeOf(f), "600", `${f} tightened`);
    } finally {
      reopened.close();
    }
    ok("existing 0644 state.db / -wal / -shm tightened to 0600 at open");

    console.log(`\nfilemodes-check: ${checks} checks passed`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("filemodes-check FAILED:", err);
    process.exit(1);
  },
);
