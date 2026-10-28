import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Docker from "dockerode";
import { ContainerDriver } from "./driver/container.js";

async function main(): Promise<void> {
  const binary = process.env.HOTCELL_AGENT_BIN ?? "/tmp/hotcell-agent-check";
  assert.ok(existsSync(binary), `build the Go agent first: ${binary}`);
  const root = mkdtempSync(join(tmpdir(), "hotcell-container-agent-check-"));
  const id = "ca-check";
  const agentBaseDir = join(tmpdir(), `hca${process.pid}`);
  const socketPath = join(agentBaseDir, id, "a.sock");
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });

  let child: ChildProcess | undefined;
  let createConfig: Record<string, unknown> | undefined;
  const fakeDocker = {
    listImages: async () => [{ RepoTags: ["check-image:latest"] }],
    createVolume: async () => ({}),
    createContainer: async (opts: Record<string, unknown>) => {
      createConfig = opts;
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
              HOTCELL_AGENT_LISTEN: `unix://${socketPath}`,
            },
            stdio: "ignore",
          });
          child.once("error", (err) => console.error("agent process failed:", err));
        },
      };
    },
    getContainer: () => ({
      inspect: async () => {
        const config = createConfig as {
          Env?: string[];
          Labels?: Record<string, string>;
          HostConfig?: { Binds?: string[] };
        } | undefined;
        const mounts: Array<{ Type: string; Name?: string; Source?: string; Destination: string }> = [];
        for (const bind of config?.HostConfig?.Binds ?? []) {
          const split = bind.lastIndexOf(":");
          const source = bind.slice(0, split);
          const destination = bind.slice(split + 1);
          if (destination === "/workspace") mounts.push({ Type: "volume", Name: source, Destination: destination });
          if (destination === "/run/hotcell") mounts.push({ Type: "bind", Source: source, Destination: destination });
        }
        return { Config: { Env: config?.Env, Labels: config?.Labels }, Mounts: mounts };
      },
      remove: async () => {
        if (child && child.exitCode === null) {
          child.kill("SIGTERM");
          await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
        }
      },
    }),
    getVolume: () => ({ remove: async () => {} }),
  } as unknown as Docker;

  try {
    const driver = new ContainerDriver(fakeDocker, undefined, {
      baseDir: agentBaseDir,
      binaryPath: binary,
      transport: "unix",
    });
    await driver.create({
      id,
      image: "check-image:latest",
      env: { HOTCELL_CHECK_CREATE_ENV: "create-env-ok" },
    });

    const config = createConfig as {
      Entrypoint: string[];
      Env: string[];
      HostConfig: { Binds: string[] };
    };
    assert.deepEqual(config.Entrypoint, ["/hotcell-agent"]);
    assert.ok(config.HostConfig.Binds.includes(`${binary}:/hotcell-agent:ro`));
    assert.ok(config.HostConfig.Binds.includes(`${join(agentBaseDir, id)}:/run/hotcell`));
    assert.ok(config.Env.includes("HOTCELL_AGENT_LISTEN=unix:///run/hotcell/a.sock"));

    let stdout = "";
    let stderr = "";
    let exitEventCode: number | undefined;
    const exitCode = await driver.exec(
      id,
      "printf '%s' \"$HOTCELL_CHECK_CREATE_ENV\"; printf 'stderr-ok' >&2",
      { cwd: workspace },
      (event) => {
        if (event.type === "stdout") stdout += event.data;
        if (event.type === "stderr") stderr += event.data;
        if (event.type === "exit") exitEventCode = event.exitCode;
      },
    );
    assert.equal(exitCode, 0);
    assert.equal(exitEventCode, 0, "exec emits its terminal exit event");
    assert.equal(stdout, "create-env-ok");
    assert.equal(stderr, "stderr-ok");

    const file = join(workspace, "agent-file.txt");
    await driver.writeFile(id, { path: file, content: "agent-file-ok" });
    assert.equal(await driver.readFile(id, { path: file }), "agent-file-ok");
    const listed = await driver.listFiles(id, { path: workspace });
    assert.ok(listed.some((entry) => entry.name === "agent-file.txt"));

    stdout = "";
    await driver.exec(id, "printf '%s' \"$HOTCELL_AGENT_LISTEN\"", { cwd: workspace }, (event) => {
      if (event.type === "stdout") stdout += event.data;
    });
    assert.equal(stdout, "", "the agent transport setting is not inherited by user commands");

    await driver.destroy(id);
    assert.equal(existsSync(join(agentBaseDir, id)), false, "destroy cleans up the host socket directory");
    console.log("container-agent-check: create config, exec, files, env isolation, and cleanup passed");
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    rmSync(agentBaseDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("container-agent-check FAILED:", err);
  process.exitCode = 1;
});
