/**
 * Apple VZ warm-pool (M7b) check. Proves a pre-booted spare microVM is adopted
 * on create — an instant acquire — versus a full cold boot, and that the adopted
 * sandbox is fully functional with an isolated workspace that survives stop/start.
 * Run on a Mac with the VZ artifacts built: `npm run check:warmpool:vz`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AppleVzDriver } from "./driver/applevz.js";

async function main(): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "hotcell-warmpool-"));
  const driver = new AppleVzDriver({
    helperPath: "helpers/hotcell-vz/dist/hotcell-vz",
    kernel: "helpers/hotcell-vz/guest/vmlinux-vz",
    rootfs: "helpers/hotcell-vz/guest/rootfs.img",
    stateDir,
    diskGb: 2,
    imageCacheDir: join(homedir(), ".sbx", "vz", "images"),
    warmPool: 1, // keep one spare base guest pre-booted
  });

  let passed = 0;
  const ok = (l: string) => {
    passed++;
    console.log(`  ✓ ${l}`);
  };

  try {
    // Wait for the background filler to pre-boot the spare.
    const deadline = Date.now() + 40_000;
    while (driver.poolSize() < 1 && Date.now() < deadline) await sleep(200);
    assert.ok(driver.poolSize() >= 1, "warm pool failed to pre-boot a spare");
    ok(`warm pool pre-booted ${driver.poolSize()} spare guest`);

    // Warm acquire: create a base sandbox — should adopt the spare (instant).
    const warmId = "warm01";
    const t0 = Date.now();
    await driver.create({ id: warmId, image: "base", persist: true });
    const warmMs = Date.now() - t0;
    ok(`warm create adopted a spare in ${warmMs}ms`);

    // The adopted sandbox is a real, working VM with its own workspace.
    let out = "";
    await driver.exec(warmId, "uname -s && echo WARM_OK", {}, (e) => {
      if (e.type === "stdout") out += e.data;
    });
    assert.match(out, /Linux/, "adopted guest runs Linux");
    assert.match(out, /WARM_OK/, "adopted guest execs");
    await driver.writeFile(warmId, { path: "/workspace/w.txt", content: "warm-data" });
    assert.equal(await driver.readFile(warmId, { path: "/workspace/w.txt" }), "warm-data");
    ok("adopted guest execs + has a writable workspace");

    // Workspace survives stop/start (canonical path adopted from the slot).
    await driver.stop(warmId);
    await driver.start({ id: warmId, image: "base", persist: true });
    assert.equal(
      await driver.readFile(warmId, { path: "/workspace/w.txt" }),
      "warm-data",
      "adopted workspace persists across stop/start",
    );
    ok("adopted workspace persists across stop/start");

    // Cold baseline: drain the pool, then create — a full boot for comparison.
    await driver.drainPool();
    const coldId = "cold01";
    const t1 = Date.now();
    await driver.create({ id: coldId, image: "base", persist: true });
    const coldMs = Date.now() - t1;
    ok(`cold create (pool drained) booted in ${coldMs}ms`);

    assert.ok(
      warmMs < coldMs,
      `warm acquire (${warmMs}ms) should beat cold boot (${coldMs}ms)`,
    );
    ok(`★ warm acquire ${warmMs}ms ≪ cold boot ${coldMs}ms (${Math.round(coldMs / Math.max(1, warmMs))}× faster)`);

    await driver.destroy(warmId);
    await driver.destroy(coldId);
    ok("destroy both");
  } finally {
    await driver.drainPool().catch(() => {});
    await driver.stop("warm01").catch(() => {});
    await driver.stop("cold01").catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }

  // --- shaped pool: daemon-default limits stay pool-eligible ---------------
  const shapedDir = mkdtempSync(join(tmpdir(), "hotcell-warmpool-shaped-"));
  const shape = { memoryMb: 512, cpus: 1 };
  const shaped = new AppleVzDriver({
    helperPath: "helpers/hotcell-vz/dist/hotcell-vz",
    kernel: "helpers/hotcell-vz/guest/vmlinux-vz",
    rootfs: "helpers/hotcell-vz/guest/rootfs.img",
    stateDir: shapedDir,
    diskGb: 2,
    imageCacheDir: join(homedir(), ".sbx", "vz", "images"),
    warmPool: 2, // two spares — also exercises the parallel filler
    poolLimits: shape,
  });
  try {
    const fillStart = Date.now();
    const deadline = Date.now() + 60_000;
    while (shaped.poolSize() < 2 && Date.now() < deadline) await sleep(200);
    const fillMs = Date.now() - fillStart;
    assert.equal(shaped.poolSize(), 2, "shaped pool failed to pre-boot 2 spares");
    ok(`shaped pool pre-booted 2 spares in ${fillMs}ms (parallel fill)`);

    const stats = shaped.poolStats();
    assert.equal(stats.spares, 2);
    assert.equal(stats.reservedMb, 2 * 512, "pool charges each spare at its memory cap");
    ok(`poolStats charges the shape: ${stats.reservedMb} MiB for ${stats.spares} spares`);

    // A create with the SAME resolved limits adopts (this is the case the old
    // noLimits rule broke: any daemon default disqualified every create).
    const before = shaped.poolSize();
    const tShaped = Date.now();
    await shaped.create({ id: "shaped01", image: "base", persist: true, limits: shape });
    const shapedMs = Date.now() - tShaped;
    assert.equal(shaped.poolSize(), before - 1, "matching-shape create should adopt a spare");
    ok(`create with pool-shaped limits adopted in ${shapedMs}ms`);

    // A create with a DIFFERENT shape must not adopt — exact match only. The
    // background refill races any poolSize-based assertion, so use the
    // unambiguous signal instead: adoption is ~20ms, a cold boot is seconds.
    const tMismatch = Date.now();
    await shaped.create({
      id: "shaped02",
      image: "base",
      persist: true,
      limits: { memoryMb: 256 },
    });
    const mismatchMs = Date.now() - tMismatch;
    assert.ok(mismatchMs > 1000, `mismatched-shape create must cold-boot (took ${mismatchMs}ms)`);
    let out2 = "";
    await shaped.exec("shaped02", "echo MISMATCH_OK", {}, (e) => {
      if (e.type === "stdout") out2 += e.data;
    });
    assert.match(out2, /MISMATCH_OK/, "mismatched-shape create still works (cold path)");
    ok("mismatched-shape create cold-booted and works");

    await shaped.destroy("shaped01");
    await shaped.destroy("shaped02");
    ok("destroy shaped sandboxes");

    console.log(`\nwarmpool-check: ${passed} checks passed`);
  } finally {
    await shaped.drainPool().catch(() => {});
    await shaped.stop("shaped01").catch(() => {});
    await shaped.stop("shaped02").catch(() => {});
    rmSync(shapedDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("warmpool-check FAILED:", err);
    process.exit(1);
  },
);
