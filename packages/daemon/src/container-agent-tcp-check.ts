import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Docker from "dockerode";
import { ContainerDriver } from "./driver/container.js";

async function main(): Promise<void> {
  const binary = process.env.HOTCELL_AGENT_BIN ?? "/tmp/hotcell-agent-check";
  assert.ok(existsSync(binary), `build the Go agent first: ${binary}`);
  const root = mkdtempSync(join(tmpdir(), "hotcell-container-agent-tcp-check-"));
  const baseDir = join(root, "sockets");
  const id = "ca-tcp-check";
  let child: ChildProcess | undefined;
  let createConfig: Record<string, unknown> | undefined;
  let hostPort: number | undefined;

  const inspect = () => ({
    Config: { Env: createConfig?.Env as string[] | undefined },
    NetworkSettings: {
      Ports: hostPort
        ? { "49173/tcp": [{ HostIp: "127.0.0.1", HostPort: String(hostPort) }] }
        : {},
    },
  });
  const fakeDocker = {
    listImages: async () => [{ RepoTags: ["check-image:latest"] }],
    createVolume: async () => ({}),
    createContainer: async (opts: Record<string, unknown>) => {
      createConfig = opts;
      hostPort = await reserveTcpPort();
      return {
        start: async () => {
          const envEntries = (opts.Env as string[]).map((entry) => {
            const split = entry.indexOf("=");
            return [entry.slice(0, split), entry.slice(split + 1)] as const;
          });
          child = spawn(binary, [], {
            env: {
              ...process.env,
              ...Object.fromEntries(envEntries),
              HOTCELL_AGENT_LISTEN: `tcp://127.0.0.1:${hostPort}`,
            },
            stdio: "ignore",
          });
          child.once("error", (err) => console.error("agent process failed:", err));
        },
        inspect: async () => inspect(),
      };
    },
    getContainer: () => ({
      inspect: async () => inspect(),
      remove: async () => {
        if (child && child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1500);
            child!.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
            child!.kill("SIGTERM");
          });
        }
      },
    }),
    getVolume: () => ({ remove: async () => {} }),
  } as unknown as Docker;

  const driver = new ContainerDriver(fakeDocker, undefined, {
    baseDir,
    binaryPath: binary,
    transport: "tcp",
  });

  try {
    await driver.create({
      id,
      image: "check-image:latest",
      env: {
        HOTCELL_CHECK_CREATE_ENV: "create-env-ok",
        HOTCELL_AGENT_LISTEN: "tcp://127.0.0.1:1",
        HOTCELL_AGENT_TOKEN: "user-supplied-token-must-not-win",
      },
    });

    const config = createConfig as {
      Entrypoint: string[];
      Env: string[];
      ExposedPorts: Record<string, unknown>;
      HostConfig: {
        Binds: string[];
        PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>>;
      };
    };
    assert.deepEqual(config.Entrypoint, ["/hotcell-agent"]);
    assert.ok(config.HostConfig.Binds.some((bind) => bind.endsWith(":/hotcell-agent:ro")));
    assert.ok(
      !config.HostConfig.Binds.some((bind) => bind.endsWith(":/run/hotcell")),
      "TCP mode does not bind-mount a socket",
    );
    assert.deepEqual(config.ExposedPorts, { "49173/tcp": {} });
    assert.deepEqual(config.HostConfig.PortBindings["49173/tcp"], [{ HostIp: "127.0.0.1", HostPort: "" }]);
    assert.ok(config.Env.includes("HOTCELL_AGENT_LISTEN=tcp://0.0.0.0:49173"));
    const token = config.Env.find((entry) => entry.startsWith("HOTCELL_AGENT_TOKEN="))?.slice("HOTCELL_AGENT_TOKEN=".length);
    assert.match(token ?? "", /^[a-f0-9]{64}$/);

    // Simulate a daemon restart: endpoint discovery must recover host port + token
    // from Docker inspect rather than depending on the in-memory cache.
    (driver as unknown as { agentTcpEndpoints: Map<string, unknown> }).agentTcpEndpoints.clear();
    let stdout = "";
    let exitEventCode: number | undefined;
    const exitCode = await driver.exec(
      id,
      "printf '%s' \"$HOTCELL_CHECK_CREATE_ENV\"; printf '%s' \"$HOTCELL_AGENT_TOKEN$HOTCELL_AGENT_LISTEN\"",
      { cwd: root },
      (event) => {
        if (event.type === "stdout") stdout += event.data;
        if (event.type === "exit") exitEventCode = event.exitCode;
      },
    );
    assert.equal(exitCode, 0);
    assert.equal(exitEventCode, 0);
    assert.equal(stdout, "create-env-ok", "agent transport secrets are not inherited by user commands");

    const file = join(root, "tcp-agent-file.txt");
    await driver.writeFile(id, { path: file, content: "tcp-agent-file-ok" });
    assert.equal(await driver.readFile(id, { path: file }), "tcp-agent-file-ok");
    const listed = await driver.listFiles(id, { path: root });
    assert.ok(listed.some((entry) => entry.name === "tcp-agent-file.txt"));

    await driver.destroy(id);
    assert.equal(existsSync(join(baseDir, id)), false, "TCP mode leaves no host socket directory");
    console.log("container-agent-tcp-check: loopback binding, auth recovery, exec, files, and env isolation passed");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
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

main().catch((err) => {
  console.error("container-agent-tcp-check FAILED:", err);
  process.exitCode = 1;
});
