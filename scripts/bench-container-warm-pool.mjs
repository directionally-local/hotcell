import Docker from "dockerode";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { ContainerDriver } from "../packages/daemon/dist/driver/container.js";

const docker = new Docker();
const image = process.env.HOTCELL_BENCH_IMAGE ?? "python:3.11-slim-bookworm";
const depth = clamp(Number(process.env.HOTCELL_BENCH_POOL_DEPTH ?? 5), 1, 50);
const repetitions = clamp(Number(process.env.HOTCELL_BENCH_REPETITIONS ?? 3), 1, 20);
const requestedMemoryMb = Number(process.env.HOTCELL_BENCH_MEMORY_MB ?? 0);
const memoryMb = Number.isFinite(requestedMemoryMb) && requestedMemoryMb > 0 ? Math.floor(requestedMemoryMb) : 0;
const stateRoot = mkdtempSync(join(tmpdir(), "hotcell-container-warmpool-bench-"));
const defaultLimits = memoryMb > 0 ? { memoryMb } : {};

function makeDriver(name, poolDepth) {
  const root = join(stateRoot, name);
  return new ContainerDriver(
    docker,
    undefined,
    { baseDir: join(root, "agent") },
    {
      depth: poolDepth,
      image,
      limits: defaultLimits,
      reservationMb: memoryMb || 256,
      stateDir: join(root, "pool-state"),
    },
  );
}

function clamp(value, min, max) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : min;
}

function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  const round = (n) => Math.round(n * 100) / 100;
  return { n: sorted.length, medianMs: round(percentile(0.5)), p95Ms: round(percentile(0.95)), minMs: round(sorted[0]) };
}

async function waitForPool(driver, expected) {
  const deadline = Date.now() + 60_000;
  while (driver.poolSize() < expected && Date.now() < deadline) await sleep(100);
  if (driver.poolSize() < expected) throw new Error(`warm pool filled ${driver.poolSize()}/${expected} spares`);
}

async function runBatch(driver, label) {
  const ids = Array.from({ length: depth }, (_, i) => `${label}-${i}-${Date.now().toString(36)}`);
  const samples = await Promise.all(ids.map(async (id) => {
    const started = performance.now();
    try {
      await driver.create({ id, image, persist: true, limits: defaultLimits });
      const exitCode = await driver.exec(id, "python3 -V", {}, () => {});
      if (exitCode !== 0) throw new Error(`python probe exited ${exitCode}`);
      return performance.now() - started;
    } finally {
      await driver.destroy(id).catch(() => {});
    }
  }));
  return samples;
}

const coldDriver = makeDriver("cold", 0);
let warmDriver;
const coldSamples = [];
const warmSamples = [];

try {
  await docker.ping();
  const host = await docker.info();
  // Pull and exercise the image before timing either path.
  const preflightId = `pool-bench-preflight-${process.pid}`;
  await coldDriver.create({ id: preflightId, image, persist: true, limits: defaultLimits });
  await coldDriver.exec(preflightId, "python3 -V", {}, () => {});
  await coldDriver.destroy(preflightId);

  // Warm up the no-pool driver, then gather cold batches without pool refill CPU.
  for (let i = 0; i < 2; i++) await runBatch(coldDriver, `cold-warmup-${i}`);
  for (let i = 0; i < repetitions; i++) coldSamples.push(...await runBatch(coldDriver, `cold-${i}`));

  warmDriver = makeDriver("warm", depth);
  await waitForPool(warmDriver, depth);
  for (let i = 0; i < 2; i++) {
    await runBatch(warmDriver, `pool-warmup-${i}`);
    await waitForPool(warmDriver, depth);
  }
  for (let i = 0; i < repetitions; i++) {
    await waitForPool(warmDriver, depth);
    warmSamples.push(...await runBatch(warmDriver, `warm-${i}`));
  }

  const cold = summary(coldSamples);
  const warm = summary(warmSamples);
  console.log(JSON.stringify({
    benchmark: "container burst create + python probe",
    image,
    poolDepth: depth,
    memoryLimitMb: memoryMb || null,
    repetitions,
    warmupsPerPath: 2,
    host: {
      platform: process.platform,
      arch: process.arch,
      dockerVersion: host.ServerVersion,
      dockerOs: host.OperatingSystem,
      dockerArch: host.Architecture,
      dockerCpus: host.NCPU,
      dockerMemoryMiB: Math.round(host.MemTotal / (1024 * 1024)),
    },
    cold,
    warm,
    medianSpeedup: Math.round((cold.medianMs / warm.medianMs) * 100) / 100,
  }, null, 2));
} finally {
  await coldDriver.drainPool();
  await warmDriver?.drainPool();
  await sleep(1500); // allow any in-flight refill to observe the drained target
  rmSync(stateRoot, { recursive: true, force: true });
}
