import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type Docker from "dockerode";
import { ContainerDriver } from "../src/driver/container.js";
import {
  checkHostAccess,
  checkNetworks,
  checkWorkspaceDir,
  hostAccessFromLabels,
  hostAccessLabels,
  parseWorkspaceRoots,
} from "../src/host-access.js";

const base = mkdtempSync(join(tmpdir(), "hotcell-host-access-"));
const root = join(base, "srv");
const project = join(root, "project");
const outside = join(base, "etc");
mkdirSync(project, { recursive: true });
mkdirSync(outside, { recursive: true });
symlinkSync(outside, join(root, "escape"));
after(() => rmSync(base, { recursive: true, force: true }));

describe("HOTCELL_WORKSPACE_ROOTS", () => {
  it("keeps absolute paths only, without trailing slashes", () => {
    assert.deepEqual(parseWorkspaceRoots(" /srv/project/ , relative, ,/data"), ["/srv/project", "/data"]);
    assert.deepEqual(parseWorkspaceRoots(undefined), []);
  });
});

describe("checkWorkspaceDir", () => {
  it("accepts the root itself and directories below it", () => {
    assert.deepEqual(checkWorkspaceDir(project, [project]), { dir: project });
    assert.deepEqual(checkWorkspaceDir(project, [root]), { dir: project });
  });

  it("is off when no roots are configured", () => {
    assert.match((checkWorkspaceDir(project, []) as { error: string }).error, /off on this daemon/);
  });

  it("refuses paths outside the roots, relative paths, / and a sibling with the same prefix", () => {
    assert.match((checkWorkspaceDir(outside, [root]) as { error: string }).error, /not under HOTCELL_WORKSPACE_ROOTS/);
    assert.match((checkWorkspaceDir("srv/project", [root]) as { error: string }).error, /absolute/);
    assert.match((checkWorkspaceDir("/", ["/"]) as { error: string }).error, /must not be \//);
    mkdirSync(`${project}-other`, { recursive: true });
    assert.match((checkWorkspaceDir(`${project}-other`, [project]) as { error: string }).error, /not under/);
  });

  it("resolves symlinks before checking, so a link out of the root is refused", () => {
    assert.match((checkWorkspaceDir(join(root, "escape"), [root]) as { error: string }).error, /not under/);
  });

  it("refuses a missing directory and characters that would break a bind spec", () => {
    assert.match((checkWorkspaceDir(join(root, "missing"), [root]) as { error: string }).error, /does not exist/);
    assert.match((checkWorkspaceDir(`${project}:/etc`, [root]) as { error: string }).error, /must not contain/);
  });
});

describe("checkNetworks", () => {
  it("takes user-defined networks in order, without repeats", () => {
    assert.deepEqual(checkNetworks(["dl-model-net", "dl-model-net-egress", "dl-model-net"]), { networks: ["dl-model-net", "dl-model-net-egress"] });
  });

  it("refuses the host, none and default bridge networks, and bad names", () => {
    for (const name of ["host", "none", "bridge"]) assert.ok("error" in checkNetworks([name]));
    assert.ok("error" in checkNetworks(["a b"]));
    assert.ok("error" in checkNetworks([]));
  });
});

describe("checkHostAccess (the create body)", () => {
  const context = { driver: "container", workspaceRoots: [root], egressEnforce: false };

  it("returns the labels that carry the choice to every later start", () => {
    const result = checkHostAccess({ workspaceDir: project, networks: ["n1"] }, context);
    assert.ok("access" in result);
    const labels = hostAccessLabels(result.access);
    assert.deepEqual(labels, { "hotcell.workspace-dir": project, "hotcell.networks": "n1" });
    assert.deepEqual(hostAccessFromLabels(labels), { workspaceDir: project, networks: ["n1"] });
  });

  it("refuses the reserved labels from a caller", () => {
    const result = checkHostAccess({ labels: { "hotcell.workspace-dir": "/" } }, context);
    assert.match((result as { error: string }).error, /set by the daemon/);
  });

  it("is container-only, never with a repo clone, a template or egress enforcement", () => {
    assert.match((checkHostAccess({ workspaceDir: project }, { ...context, driver: "firecracker" }) as { error: string }).error, /container driver/);
    assert.match((checkHostAccess({ workspaceDir: project, repo: "https://github.com/a/b" }, context) as { error: string }).error, /repo/);
    assert.match((checkHostAccess({ networks: ["n1"] }, { ...context, template: true }) as { error: string }).error, /template/);
    assert.match((checkHostAccess({ networks: ["n1"] }, { ...context, egressEnforce: true }) as { error: string }).error, /EGRESS_ENFORCE/);
  });

  it("changes nothing for a create that asks for neither", () => {
    assert.deepEqual(checkHostAccess({ labels: { name: "x" } }, context), { access: {} });
  });
});

/** A Docker that records the container config and which networks exist with which labels. */
function fakeDocker(networks: Record<string, Record<string, string>>) {
  const created: Array<Record<string, unknown>> = [];
  const connected: string[] = [];
  const volumes: string[] = [];
  const docker = {
    info: async () => ({ Architecture: "x86_64" }),
    listImages: async () => [{ RepoTags: ["cell:1"] }],
    createVolume: async (opts: { Name: string }) => { volumes.push(opts.Name); return {}; },
    createContainer: async (opts: Record<string, unknown>) => {
      created.push(opts);
      return { start: async () => {} };
    },
    getContainer: () => ({
      inspect: async () => { throw Object.assign(new Error("no such container"), { statusCode: 404 }); },
      remove: async () => {},
    }),
    getVolume: () => ({ remove: async () => {} }),
    getNetwork: (name: string) => ({
      inspect: async () => {
        if (!(name in networks)) throw Object.assign(new Error("no such network"), { statusCode: 404 });
        return { Name: name, Labels: networks[name] };
      },
      connect: async (opts: { Container: string }) => { connected.push(`${name}:${opts.Container}`); },
    }),
  } as unknown as Docker;
  return { docker, created, connected, volumes };
}

function driverWith(docker: Docker, roots: string[], egress = false): ContainerDriver {
  const driver = new ContainerDriver(
    docker,
    egress ? { enforce: true, network: "hotcell-egress", subnet: "10.200.0.0/24", dns: "" } : undefined,
    { baseDir: join(base, "agent"), binaryPath: process.execPath, transport: "unix" },
    undefined,
    { workspaceRoots: roots },
  );
  // No real agent in a unit test: the container "starts" instantly.
  (driver as unknown as { waitForAgent: () => Promise<void> }).waitForAgent = async () => {};
  return driver;
}

describe("ContainerDriver with a host workspace and custom networks", () => {
  const attachable = { "hotcell.attachable": "true" };

  it("bind-mounts exactly that directory at /workspace, joins the networks, and makes no volume", async () => {
    const fake = fakeDocker({ "dl-model-net": attachable, "dl-model-net-egress": attachable });
    const driver = driverWith(fake.docker, [root]);
    await driver.create({ id: "a1", image: "cell:1", labels: { "hotcell.workspace-dir": project, "hotcell.networks": "dl-model-net,dl-model-net-egress" } });
    const config = fake.created[0] as { HostConfig: { Binds: string[]; NetworkMode?: string; ExtraHosts?: string[]; Privileged?: boolean; DeviceRequests?: unknown } };
    const workspaceBinds = config.HostConfig.Binds.filter((bind) => bind.endsWith(":/workspace"));
    assert.deepEqual(workspaceBinds, [`${project}:/workspace`]);
    // Besides the workspace: only the agent binary (read-only) and its socket directory.
    assert.equal(config.HostConfig.Binds.length, 3);
    assert.ok(!config.HostConfig.Binds.some((bind) => bind.includes("docker.sock")));
    assert.equal(config.HostConfig.NetworkMode, "dl-model-net");
    assert.equal(config.HostConfig.ExtraHosts, undefined, "the host isn't advertised to a sandbox on its own networks");
    assert.equal(config.HostConfig.Privileged, undefined);
    assert.equal(config.HostConfig.DeviceRequests, undefined, "no GPU");
    assert.deepEqual(fake.connected, ["dl-model-net-egress:sbx-a1"]);
    assert.deepEqual(fake.volumes, []);
  });

  it("refuses at launch a directory the daemon no longer allows, or a network without the label", async () => {
    const fake = fakeDocker({ open: {}, ok: attachable });
    await assert.rejects(driverWith(fake.docker, []).create({ id: "b1", image: "cell:1", labels: { "hotcell.workspace-dir": project } }), /off on this daemon/);
    await assert.rejects(driverWith(fake.docker, [root]).create({ id: "b2", image: "cell:1", labels: { "hotcell.networks": "open" } }), /not labelled hotcell\.attachable=true/);
    await assert.rejects(driverWith(fake.docker, [root]).create({ id: "b3", image: "cell:1", labels: { "hotcell.networks": "missing" } }), /does not exist/);
    await assert.rejects(driverWith(fake.docker, [root], true).create({ id: "b4", image: "cell:1", labels: { "hotcell.networks": "ok" } }), /egress enforcement/);
    assert.equal(fake.created.length, 0, "nothing was created");
  });

  it("leaves an ordinary sandbox as before: a named volume and the host gateway", async () => {
    const fake = fakeDocker({});
    await driverWith(fake.docker, [root]).create({ id: "c1", image: "cell:1" });
    const config = fake.created[0] as { HostConfig: { Binds: string[]; NetworkMode?: string; ExtraHosts?: string[] } };
    assert.ok(config.HostConfig.Binds.includes("sbx-c1-workspace:/workspace"));
    assert.equal(config.HostConfig.NetworkMode, undefined);
    assert.deepEqual(config.HostConfig.ExtraHosts, ["host.docker.internal:host-gateway"]);
    assert.deepEqual(fake.volumes, ["sbx-c1-workspace"]);
  });
});
