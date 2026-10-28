import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type Docker from "dockerode";
import { Capacity } from "./capacity.js";
import { loadConfig } from "./config.js";
import { ContainerDriver } from "./driver/container.js";
import type { SandboxStore } from "./store.js";

interface FakeState {
  name: string;
  options: Record<string, unknown>;
  port?: number;
  socketDir?: string;
  workspaceVolume?: string;
  workspaceDir: string;
  ip: string;
  running: boolean;
  child?: ChildProcess;
}

async function main(): Promise<void> {
  const binary = process.env.HOTCELL_AGENT_BIN ?? "/tmp/hotcell-agent-check";
  assert.ok(existsSync(binary), `build the Go agent first: ${binary}`);
  const root = mkdtempSync(join(tmpdir(), "hotcell-container-warmpool-check-"));
  const volumeRoot = join(root, "volumes");
  mkdirSync(volumeRoot, { recursive: true });
  const containers = new Map<string, FakeState>();
  const volumes = new Map<string, { path: string; labels: Record<string, string> }>();
  const createdNames: string[] = [];
  const renames: Array<{ from: string; to: string }> = [];
  let activeStarts = 0;
  let maxConcurrentStarts = 0;
  let nextIp = 10;

  const volumeDirectory = (name: string) => join(volumeRoot, name);
  const inspectState = (state: FakeState) => {
    const labels = (state.options.Labels ?? {}) as Record<string, string>;
    const env = (state.options.Env ?? []) as string[];
    const hostConfig = (state.options.HostConfig ?? {}) as { Binds?: string[]; NetworkMode?: string };
    const network = hostConfig.NetworkMode ?? "bridge";
    return {
      Config: { Env: env, Labels: labels },
      State: { Running: state.running },
      Mounts: [
        ...(state.workspaceVolume
          ? [{ Type: "volume", Name: state.workspaceVolume, Source: volumeDirectory(state.workspaceVolume), Destination: "/workspace" }]
          : []),
        ...(state.socketDir ? [{ Type: "bind", Source: state.socketDir, Destination: "/run/hotcell" }] : []),
      ],
      NetworkSettings: {
        Ports: state.port ? { "49173/tcp": [{ HostIp: "127.0.0.1", HostPort: String(state.port) }] } : {},
        Networks: { [network]: { IPAddress: state.ip } },
      },
    };
  };

  const startState = async (state: FakeState): Promise<void> => {
    if (state.running) return;
    activeStarts++;
    maxConcurrentStarts = Math.max(maxConcurrentStarts, activeStarts);
    await sleep(20);
    const envEntries = ((state.options.Env ?? []) as string[]).map((entry) => {
      const split = entry.indexOf("=");
      return [entry.slice(0, split), entry.slice(split + 1)] as const;
    });
    state.child = spawn(binary, [], {
      env: {
        ...process.env,
        ...Object.fromEntries(envEntries),
        HOTCELL_AGENT_LISTEN: state.port
          ? `tcp://127.0.0.1:${state.port}`
          : `unix://${join(state.socketDir!, "a.sock")}`,
      },
      stdio: "ignore",
    });
    state.running = true;
    state.child.once("exit", () => { state.running = false; });
    activeStarts--;
  };

  const killState = async (state: FakeState): Promise<void> => {
    const child = state.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
    state.running = false;
  };

  const notFound = () => Object.assign(new Error("container not found"), { statusCode: 404 });
  const getState = (name: string): FakeState => {
    const state = containers.get(name);
    if (!state) throw notFound();
    return state;
  };
  let networkCreated = false;
  const fakeDocker = {
    listImages: async () => [{ RepoTags: ["check-image:latest", "other-image:latest"] }],
    info: async () => ({ Architecture: "aarch64", MemTotal: 8 * 1024 ** 3, NCPU: 8 }),
    createVolume: async (opts: { Name: string; Labels?: Record<string, string> }) => {
      const path = volumeDirectory(opts.Name);
      mkdirSync(path, { recursive: true });
      volumes.set(opts.Name, { path, labels: opts.Labels ?? {} });
      return {};
    },
    createNetwork: async () => {
      if (networkCreated) throw Object.assign(new Error("network already exists"), { statusCode: 409 });
      networkCreated = true;
      return {};
    },
    listContainers: async () => [...containers.values()].map((state) => {
      const details = inspectState(state);
      return {
        Id: state.name,
        Names: [`/${state.name}`],
        Labels: (state.options.Labels ?? {}) as Record<string, string>,
        NetworkSettings: details.NetworkSettings,
      };
    }),
    createContainer: async (opts: Record<string, unknown>) => {
      const name = String(opts.name);
      const hostConfig = (opts.HostConfig ?? {}) as { Binds?: string[]; NetworkMode?: string };
      const workspaceBind = hostConfig.Binds?.find((bind) => bind.endsWith(":/workspace"));
      const workspaceVolume = workspaceBind?.slice(0, workspaceBind.lastIndexOf(":"));
      const socketBind = hostConfig.Binds?.find((bind) => bind.endsWith(":/run/hotcell"));
      const socketDir = socketBind?.slice(0, socketBind.lastIndexOf(":"));
      const envEntries = (opts.Env as string[]).map((entry) => {
        const split = entry.indexOf("=");
        return [entry.slice(0, split), entry.slice(split + 1)] as const;
      });
      const agentListen = Object.fromEntries(envEntries).HOTCELL_AGENT_LISTEN as string;
      const workspaceDir = workspaceVolume
        ? (volumes.get(workspaceVolume)?.path ?? volumeDirectory(workspaceVolume))
        : join(root, "ephemeral", name);
      mkdirSync(workspaceDir, { recursive: true });
      const state: FakeState = {
        name,
        options: opts,
        port: agentListen.startsWith("tcp://") ? await reserveTcpPort() : undefined,
        socketDir,
        workspaceVolume,
        workspaceDir,
        ip: `10.200.0.${nextIp++}`,
        running: false,
      };
      containers.set(name, state);
      createdNames.push(name);
      return {
        start: async () => startState(state),
        inspect: async () => inspectState(state),
      };
    },
    getContainer: (name: string) => ({
      inspect: async () => inspectState(getState(name)),
      start: async () => startState(getState(name)),
      stop: async () => killState(getState(name)),
      rename: async ({ name: next }: { name: string }) => {
        const state = getState(name);
        if (containers.has(next)) throw Object.assign(new Error("name already exists"), { statusCode: 409 });
        containers.delete(state.name);
        const previous = state.name;
        state.name = next;
        containers.set(next, state);
        renames.push({ from: previous, to: next });
      },
      remove: async () => {
        const state = getState(name);
        await killState(state);
        containers.delete(state.name);
      },
      wait: async () => ({}),
    }),
    getVolume: (name: string) => ({
      remove: async () => {
        if (!volumes.has(name)) throw notFound();
        const volume = volumes.get(name)!;
        volumes.delete(name);
        rmSync(volume.path, { recursive: true, force: true });
      },
    }),
  } as unknown as Docker;

  const shape = { memoryMb: 256, cpus: 1 };
  const transport = process.platform === "linux" ? "unix" : "tcp";
  const driver = new ContainerDriver(
    fakeDocker,
    { enforce: true, network: "hotcell-test-egress", subnet: "10.200.0.0/24", dns: "10.200.0.2" },
    { baseDir: join(root, "agent"), binaryPath: binary },
    {
      depth: 5,
      image: "check-image:latest",
      limits: shape,
      reservationMb: 128,
      stateDir: join(root, "pool-state"),
    },
  );
  const sandboxIds = ["warm-a", "warm-b", "cold-shape", "cold-image", "cold-labeled"];

  try {
    await waitFor(() => driver.poolSize() === 5, 45_000, "five pre-started spares");
    assert.ok(maxConcurrentStarts > 1, "refill starts multiple spares concurrently");
    assert.ok(maxConcurrentStarts <= 4, `refill concurrency ${maxConcurrentStarts} exceeds its cap`);
    assert.deepEqual(driver.poolStats(), { spares: 5, reservedMb: 5 * 256 });
    const capacityConfig = loadConfig();
    capacityConfig.admission = "enforce";
    capacityConfig.hostMemoryMb = 1500;
    capacityConfig.overcommit = 1;
    capacityConfig.defaultReservationMb = 256;
    const capacity = new Capacity(
      { list: () => [] } as unknown as SandboxStore,
      capacityConfig,
      null,
      undefined,
      () => driver.poolStats(),
    );
    assert.equal(capacity.snapshot().memory.committedMb, 5 * 256);
    assert.equal(capacity.admit(256).ok, false, "pool memory is reserved before admitting new sandboxes");
    console.log(`  ✓ ${transport} pool pre-started 5 spares with bounded refill and admission reservation (max concurrent starts ${maxConcurrentStarts})`);

    const poolNamesBefore = [...containers.keys()].filter((name) => name.startsWith("sbx-pool-"));
    const firstSpare = containers.get(poolNamesBefore[0]!);
    assert.ok(firstSpare);
    assert.equal(await driver.sandboxIdForEgressIp(firstSpare.ip), undefined, "pool spares have no sandbox identity yet");
    const createdBeforeAdopt = createdNames.length;
    await driver.create({
      id: "warm-a",
      image: "check-image:latest",
      persist: true,
      limits: shape,
      env: {
        HOTCELL_CHECK_CREATE_ENV: "warm-a-env",
        HOTCELL_AGENT_LISTEN: "tcp://127.0.0.1:1",
        HOTCELL_AGENT_TOKEN: "user-token-must-not-win",
      },
    });
    assert.ok(renames.some((rename) => rename.to === "sbx-warm-a"), "matching create adopts a pool container");
    assert.ok(!createdNames.slice(createdBeforeAdopt).includes("sbx-warm-a"), "warm create did not create a new container");
    const warmA = containers.get("sbx-warm-a")!;
    const warmAVolume = warmA.workspaceVolume!;
    assert.ok(poolNamesBefore.includes(renames.find((rename) => rename.to === "sbx-warm-a")!.from));
    assert.equal((warmA.options.Labels as Record<string, string>)["sbx.id"], undefined, "adopted labels do not impersonate the pool slot id");
    assert.equal((warmA.options.HostConfig as { NetworkMode?: string }).NetworkMode, "hotcell-test-egress");

    let output = "";
    const code = await driver.exec(
      "warm-a",
      "printf '%s' \"$HOTCELL_CHECK_CREATE_ENV$HOTCELL_AGENT_TOKEN$HOTCELL_AGENT_LISTEN\"",
      { cwd: warmA.workspaceDir },
      (event) => { if (event.type === "stdout") output += event.data; },
    );
    assert.equal(code, 0);
    assert.equal(output, "warm-a-env", "user env applies; transport settings remain private");
    const marker = join(warmA.workspaceDir, "workspace.txt");
    await driver.writeFile("warm-a", { path: marker, content: "warm-a-only" });
    assert.equal(await driver.readFile("warm-a", { path: marker }), "warm-a-only");
    assert.equal(await driver.sandboxIdForEgressIp(warmA.ip), "warm-a", "renamed container IP maps to its sandbox id");
    console.log("  ✓ exact-shape adoption applies env, preserves egress identity, and uses a fresh workspace");

    await waitFor(() => driver.poolSize() >= 1, 20_000, "pool refill");
    await driver.create({ id: "warm-b", image: "check-image:latest", persist: true, limits: shape });
    const warmB = containers.get("sbx-warm-b")!;
    assert.notEqual(warmB.workspaceVolume, warmAVolume, "each adopted spare owns a distinct workspace volume");
    assert.equal(existsSync(join(warmB.workspaceDir, "workspace.txt")), false, "sandbox workspaces are isolated");

    const beforeMismatch = createdNames.length;
    await driver.create({ id: "cold-shape", image: "check-image:latest", persist: true, limits: { memoryMb: 128 } });
    await driver.create({ id: "cold-image", image: "other-image:latest", persist: true, limits: shape });
    await driver.create({
      id: "cold-labeled",
      image: "check-image:latest",
      persist: true,
      limits: shape,
      labels: { team: "agents" },
    });
    assert.ok(createdNames.includes("sbx-cold-shape"), "shape mismatch uses cold create");
    assert.ok(createdNames.includes("sbx-cold-image"), "image mismatch uses cold create");
    assert.equal(
      (containers.get("sbx-cold-labeled")!.options.Labels as Record<string, string>).team,
      "agents",
      "custom Docker labels are preserved by the cold path",
    );
    assert.ok(createdNames.length >= beforeMismatch + 3);
    console.log("  ✓ image and resource-shape mismatches use the cold path");

    await driver.stop("warm-a");
    await driver.start({ id: "warm-a", image: "check-image:latest", persist: true, limits: shape, env: { HOTCELL_CHECK_CREATE_ENV: "warm-a-env" } });
    const restarted = containers.get("sbx-warm-a")!;
    assert.equal(restarted.workspaceVolume, warmAVolume, "stop/start reattaches the adopted volume");
    assert.equal(await driver.readFile("warm-a", { path: join(restarted.workspaceDir, "workspace.txt") }), "warm-a-only");
    console.log("  ✓ stop/start preserves the slot volume without retaining the old container");

    for (const id of sandboxIds) await driver.destroy(id);
    await waitFor(() => driver.poolSize() === 5, 25_000, "pool refill after destroys");
    console.log("  ✓ destroy removes leased volumes and refill restores the pool");

    await driver.drainPool();
    const staleId = "pool-stale-check";
    const staleName = `sbx-${staleId}`;
    const staleVolume = `sbx-${staleId}-workspace`;
    await fakeDocker.createVolume({
      Name: staleVolume,
      Labels: { "sbx.managed": "true", "hotcell.pool": "true", "hotcell.pool.slot": staleId },
    });
    const staleDir = volumeDirectory(staleVolume);
    containers.set(staleName, {
      name: staleName,
      options: {
        name: staleName,
        Env: [],
        Labels: { "sbx.managed": "true", "hotcell.pool": "true", "hotcell.pool.slot": staleId },
        HostConfig: { Binds: [`${staleVolume}:/workspace`] },
      },
      port: await reserveTcpPort(),
      workspaceVolume: staleVolume,
      workspaceDir: staleDir,
      ip: `10.200.0.${nextIp++}`,
      running: false,
    });
    new ContainerDriver(
      fakeDocker,
      undefined,
      { baseDir: join(root, "disabled-agent"), binaryPath: binary, transport: "tcp" },
      { depth: 0, image: "check-image:latest", limits: shape, reservationMb: 128, stateDir: join(root, "disabled-pool") },
    );
    await waitFor(() => !containers.has(staleName), 5000, "stale spares removed after disabling the pool");
    assert.equal(volumes.has(staleVolume), false, "stale spare workspace volume is removed too");
    console.log("  ✓ startup removes abandoned spares when pool depth is disabled");
  } finally {
    for (const id of sandboxIds) await driver.destroy(id).catch(() => {});
    await driver.drainPool();
    await waitFor(() => containers.size === 0, 5000, "fake containers cleaned up").catch(() => {});
    for (const volume of [...volumes.values()]) rmSync(volume.path, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

async function reserveTcpPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not reserve a TCP port");
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return address.port;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(50);
  assert.ok(predicate(), `timed out waiting for ${what}`);
}

main().catch((err) => {
  console.error("container-warmpool-check FAILED:", err);
  process.exitCode = 1;
});
