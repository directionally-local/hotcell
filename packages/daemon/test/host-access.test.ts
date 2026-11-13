import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type Docker from "dockerode";
import { ContainerDriver } from "../src/driver/container.js";
import {
  checkHomeDir,
  checkHostAccess,
  checkNetworks,
  checkUser,
  checkWorkspaceDir,
  hostAccessFromLabels,
  hostAccessLabels,
  parseWorkspaceRoots,
} from "../src/host-access.js";

// Real path: macOS temp dirs sit behind the /var → /private/var symlink.
const base = realpathSync(mkdtempSync(join(tmpdir(), "hotcell-host-access-")));
const root = join(base, "srv");
const project = join(root, "project");
const outside = join(base, "etc");
const homes = join(base, "homes");
const home = join(homes, "default", "home");
mkdirSync(home, { recursive: true });
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

describe("checkUser", () => {
  it("takes a numeric UID:GID, root included", () => {
    assert.deepEqual(checkUser("1000:1000"), { user: "1000:1000" });
    assert.deepEqual(checkUser("0:0"), { user: "0:0" });
    assert.deepEqual(checkUser("0001:02"), { user: "1:2" });
  });

  it("refuses names, a missing group, extra fields and out-of-range ids", () => {
    for (const bad of ["root", "1000", "1000:", ":1000", "ubuntu:ubuntu", "1000:1000:1", "-1:0", " 1000:1000", "4294967295:0", 1000, undefined]) {
      assert.ok("error" in checkUser(bad), String(bad));
    }
  });
});

describe("checkHostAccess (the create body)", () => {
  const context = { driver: "container", workspaceRoots: [root], homeRoots: [homes], egressEnforce: false };

  it("keeps a home directory under HOTCELL_HOME_ROOTS beside the workspace, and refuses one elsewhere", () => {
    const result = checkHostAccess({ workspaceDir: project, homeDir: home, user: "1000:1000" }, context);
    assert.ok("access" in result);
    const labels = hostAccessLabels(result.access);
    assert.deepEqual(labels, { "hotcell.workspace-dir": project, "hotcell.user": "1000:1000", "hotcell.home-dir": home });
    assert.deepEqual(hostAccessFromLabels(labels), { workspaceDir: project, user: "1000:1000", homeDir: home });
    assert.match((checkHostAccess({ homeDir: home }, context) as { error: string }).error, /homeDir needs workspaceDir/);
    assert.match((checkHostAccess({ workspaceDir: project, homeDir: project }, context) as { error: string }).error, /not under HOTCELL_HOME_ROOTS/);
    assert.match((checkHostAccess({ workspaceDir: project, homeDir: home }, { ...context, homeRoots: [] }) as { error: string }).error, /off on this daemon.*HOTCELL_HOME_ROOTS/);
    assert.match((checkHostAccess({ workspaceDir: homes, homeDir: home }, { ...context, workspaceRoots: [base] }) as { error: string }).error, /must not contain one another/);
    assert.match((checkHostAccess({ labels: { "hotcell.home-dir": home } }, context) as { error: string }).error, /set by the daemon/);
    assert.deepEqual(checkHomeDir(home, [homes]), { dir: home });
  });

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
    assert.match((checkHostAccess({ labels: { "hotcell.user": "0:0" } }, context) as { error: string }).error, /set by the daemon/);
  });

  it("keeps a user with a host workspace, and refuses one without", () => {
    const result = checkHostAccess({ workspaceDir: project, user: "1000:1000" }, context);
    assert.ok("access" in result);
    const labels = hostAccessLabels(result.access);
    assert.deepEqual(labels, { "hotcell.workspace-dir": project, "hotcell.user": "1000:1000" });
    assert.deepEqual(hostAccessFromLabels(labels), { workspaceDir: project, user: "1000:1000" });
    assert.match((checkHostAccess({ user: "1000:1000" }, context) as { error: string }).error, /needs workspaceDir/);
    assert.match((checkHostAccess({ workspaceDir: project, user: "ubuntu" }, context) as { error: string }).error, /numeric UID:GID/);
    assert.match((checkHostAccess({ workspaceDir: project, user: "1000:1000" }, { ...context, driver: "firecracker" }) as { error: string }).error, /container driver/);
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

function driverWith(docker: Docker, roots: string[], egress = false, homeRoots: string[] = [homes]): ContainerDriver {
  const driver = new ContainerDriver(
    docker,
    egress ? { enforce: true, network: "hotcell-egress", subnet: "10.200.0.0/24", dns: "" } : undefined,
    { baseDir: join(base, "agent"), binaryPath: process.execPath, transport: "unix" },
    undefined,
    { workspaceRoots: roots, homeRoots },
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

  it("runs a sandbox with a user as that user, and lets it create its agent socket", async () => {
    const fake = fakeDocker({});
    chmodSync(join(base, "agent"), 0o755);
    await driverWith(fake.docker, [root]).create({ id: "u1", image: "cell:1", labels: { "hotcell.workspace-dir": project, "hotcell.user": "1000:1000" } });
    const config = fake.created[0] as { User?: string };
    assert.equal(config.User, "1000:1000");
    assert.equal(statSync(join(base, "agent", "u1")).mode & 0o777, 0o733, "the user can create the socket, not list the directory");
    assert.equal(statSync(join(base, "agent")).mode & 0o777, 0o700, "the base directory stays the daemon's alone");
  });

  it("mounts a home directory at /home/agent beside the workspace, and nothing else", async () => {
    const fake = fakeDocker({});
    await driverWith(fake.docker, [root]).create({ id: "h1", image: "cell:1", labels: { "hotcell.workspace-dir": project, "hotcell.home-dir": home, "hotcell.user": "1000:1000" } });
    const config = fake.created[0] as { HostConfig: { Binds: string[] } };
    assert.deepEqual(config.HostConfig.Binds.filter((bind) => !bind.includes("hotcell-agent") && !bind.endsWith(":/run/hotcell")), [`${project}:/workspace`, `${home}:/home/agent`]);
    assert.equal(config.HostConfig.Binds.length, 4);
  });

  it("refuses at launch a home directory the daemon no longer allows", async () => {
    const fake = fakeDocker({});
    await assert.rejects(driverWith(fake.docker, [root], false, []).create({ id: "h2", image: "cell:1", labels: { "hotcell.workspace-dir": project, "hotcell.home-dir": home } }), /HOTCELL_HOME_ROOTS/);
    await assert.rejects(driverWith(fake.docker, [root]).create({ id: "h3", image: "cell:1", labels: { "hotcell.home-dir": home } }), /needs a host workspace/);
    assert.equal(fake.created.length, 0);
  });

  it("refuses at launch a user label that isn't numeric or comes without a workspace", async () => {
    const fake = fakeDocker({});
    await assert.rejects(driverWith(fake.docker, [root]).create({ id: "u2", image: "cell:1", labels: { "hotcell.workspace-dir": project, "hotcell.user": "root" } }), /numeric UID:GID/);
    await assert.rejects(driverWith(fake.docker, [root]).create({ id: "u3", image: "cell:1", labels: { "hotcell.user": "1000:1000" } }), /needs a host workspace/);
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
    assert.equal((config as { User?: string }).User, undefined, "the image's user, as before");
    assert.equal(statSync(join(base, "agent", "c1")).mode & 0o777, 0o700);
  });
});
