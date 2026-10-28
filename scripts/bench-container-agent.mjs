import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { performance } from "node:perf_hooks";
import { ContainerDriver } from "../packages/daemon/dist/driver/container.js";

const docker = new Docker();
const image = process.env.HOTCELL_BENCH_IMAGE ?? "python:3.11-slim-bookworm";
const iterations = clamp(Number(process.env.HOTCELL_BENCH_ITERATIONS ?? 50), 10, 500);
const warmups = 5;
const suffix = `${process.pid}-${Date.now().toString(36)}`;
const agentId = `agent-bench-${suffix}`;
const oldName = `sbx-agent-bench-old-${suffix}`;
const oldVolumeName = `sbx-agent-bench-old-${suffix}-workspace`;
const filePath = "/workspace/agent-bench.txt";
const content = "hotcell-agent-benchmark-content-0123456789".repeat(3);
const encoded = Buffer.from(content, "utf8").toString("base64");
const agentDriver = new ContainerDriver(docker);
let oldContainer;

// Mirrors the pre-agent ContainerDriver.exec/execCapture requests from 288e7d4.
async function dockerExec(container, command, login = false) {
  const exec = await container.exec({
    Cmd: ["/bin/bash", login ? "-lc" : "-c", command],
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: "/workspace",
    Env: [],
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
  stderr.on("data", (chunk) => { err += chunk.toString("utf8"); });
  docker.modem.demuxStream(stream, stdout, stderr);
  await new Promise((resolve, reject) => {
    stream.once("end", resolve);
    stream.once("error", reject);
  });
  stdout.end();
  stderr.end();
  const result = await exec.inspect();
  if ((result.ExitCode ?? 0) !== 0) throw new Error(err.trim() || `Docker exec exited ${result.ExitCode}`);
  return out;
}

async function measure(fn) {
  const started = performance.now();
  await fn();
  return performance.now() - started;
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return {
    n: sorted.length,
    medianMs: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    minMs: round(sorted[0]),
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function clamp(value, min, max) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : min;
}

async function measurePair(baseline, agent) {
  for (let i = 0; i < warmups; i++) {
    await baseline();
    await agent();
  }
  const baselineSamples = [];
  const agentSamples = [];
  for (let i = 0; i < iterations; i++) {
    const first = i % 2 === 0;
    if (first) {
      baselineSamples.push(await measure(baseline));
      agentSamples.push(await measure(agent));
    } else {
      agentSamples.push(await measure(agent));
      baselineSamples.push(await measure(baseline));
    }
  }
  const before = stats(baselineSamples);
  const after = stats(agentSamples);
  return {
    dockerExec: before,
    guestAgent: after,
    medianSpeedup: round(before.medianMs / after.medianMs),
  };
}

try {
  await docker.ping();
  const info = await docker.info();
  await agentDriver.create({ id: agentId, image }); // also pulls the image if missing

  await docker.createVolume({ Name: oldVolumeName });
  oldContainer = await docker.createContainer({
    name: oldName,
    Image: image,
    Cmd: ["sleep", "infinity"],
    WorkingDir: "/workspace",
    HostConfig: { AutoRemove: false, Binds: [`${oldVolumeName}:/workspace`] },
  });
  await oldContainer.start();
  oldContainer = docker.getContainer(oldName);

  const operations = {
    exec: await measurePair(
      () => dockerExec(oldContainer, "true", true),
      async () => {
        const code = await agentDriver.exec(agentId, "true", {}, () => {});
        if (code !== 0) throw new Error(`agent exec exited ${code}`);
      },
    ),
    writeFile: await measurePair(
      async () => {
        const output = await dockerExec(oldContainer, `mkdir -p /workspace && printf '%s' '${encoded}' | base64 -d > ${filePath} && echo ok`);
        if (output.trim() !== "ok") throw new Error(`baseline write failed: ${output}`);
      },
      () => agentDriver.writeFile(agentId, { path: filePath, content }),
    ),
    readFile: await measurePair(
      async () => {
        const output = await dockerExec(oldContainer, `cat ${filePath}`);
        if (output !== content) throw new Error("baseline read returned unexpected contents");
      },
      async () => {
        const output = await agentDriver.readFile(agentId, { path: filePath });
        if (output !== content) throw new Error("agent read returned unexpected contents");
      },
    ),
  };

  console.log(JSON.stringify({
    benchmark: "container Docker exec vs guest agent",
    image,
    iterations,
    warmups,
    host: {
      platform: process.platform,
      arch: process.arch,
      dockerVersion: info.ServerVersion,
      dockerOs: info.OperatingSystem,
      dockerArch: info.Architecture,
      dockerCpus: info.NCPU,
      dockerMemoryMiB: Math.round(info.MemTotal / (1024 * 1024)),
    },
    operations,
  }, null, 2));
} finally {
  if (oldContainer) {
    await oldContainer.remove({ force: true }).catch(() => {});
  }
  await docker.getVolume(oldVolumeName).remove({ force: true }).catch(() => {});
  await agentDriver.destroy(agentId).catch(() => {});
}
