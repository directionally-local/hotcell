/**
 * Firecracker host-agnostic check. Exercises the pieces of the `firecracker`
 * driver that need no `/dev/kvm` — the API-call builders, the vsock CONNECT
 * handshake parser, and the driver's fail-fast `ping`/`hostInfo` — so the
 * Linux-specific code is validated on any host (incl. this Mac / CI). The live
 * boot is gated behind `smoke:fc` on a KVM box. Run: `npm run check:fc`.
 */
import assert from "node:assert/strict";
import {
  buildFcApiCalls,
  buildSnapshotCreateCall,
  buildSnapshotLoadCall,
  FC_DEFAULT_BOOT_ARGS,
  FC_PAUSE_VM,
  FC_START_ACTION,
  fcTapSetupCommands,
  fcTapTeardownCommands,
  parseVsockHandshake,
} from "./driver/fc-api.js";
import { FirecrackerDriver } from "./driver/firecracker.js";

let passed = 0;
const ok = (l: string) => {
  passed++;
  console.log(`  ✓ ${l}`);
};

async function main(): Promise<void> {
  // 1. API calls fully configure a VM in the right order with the right shapes.
  const calls = buildFcApiCalls({
    kernelPath: "/k/vmlinux",
    rootfsPath: "/k/rootfs.img",
    workspacePath: "/k/ws.img",
    vcpus: 2,
    memMib: 512,
    vsockUds: "/k/v.sock",
  });
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/boot-source", "/machine-config", "/drives/rootfs", "/drives/workspace", "/vsock"],
    "API calls cover boot/machine/drives/vsock in order",
  );
  const boot = calls[0]!.body as { kernel_image_path: string; boot_args: string };
  assert.equal(boot.kernel_image_path, "/k/vmlinux");
  assert.equal(boot.boot_args, FC_DEFAULT_BOOT_ARGS);
  const mc = calls[1]!.body as { vcpu_count: number; mem_size_mib: number };
  assert.equal(mc.vcpu_count, 2);
  assert.equal(mc.mem_size_mib, 512);
  // The root device is /dev/vda (ro), the workspace /dev/vdb (rw) — matches the
  // shared guest init that mounts /dev/vdb at /workspace.
  const rootDrive = calls[2]!.body as { is_root_device: boolean; is_read_only: boolean };
  assert.equal(rootDrive.is_root_device, true);
  assert.equal(rootDrive.is_read_only, true);
  const wsDrive = calls[3]!.body as { is_root_device: boolean; is_read_only: boolean };
  assert.equal(wsDrive.is_root_device, false);
  assert.equal(wsDrive.is_read_only, false);
  const vsock = calls[4]!.body as { uds_path: string; guest_cid: number };
  assert.equal(vsock.uds_path, "/k/v.sock");
  assert.equal(vsock.guest_cid, 3);
  ok("buildFcApiCalls: correct order, shapes, and vda(ro)/vdb(rw) drive layout");

  assert.equal((FC_START_ACTION.body as { action_type: string }).action_type, "InstanceStart");
  ok("FC_START_ACTION boots the VM");

  // 1b. Snapshot API calls: pause → create(Full) → load(File mem backend, resume).
  assert.equal(FC_PAUSE_VM.method, "PATCH");
  assert.equal(FC_PAUSE_VM.path, "/vm");
  assert.equal((FC_PAUSE_VM.body as { state: string }).state, "Paused");
  const snapCreate = buildSnapshotCreateCall("/s/x.vmstate", "/s/x.mem");
  assert.equal(snapCreate.path, "/snapshot/create");
  const scBody = snapCreate.body as { snapshot_type: string; snapshot_path: string; mem_file_path: string };
  assert.equal(scBody.snapshot_type, "Full");
  assert.equal(scBody.snapshot_path, "/s/x.vmstate");
  assert.equal(scBody.mem_file_path, "/s/x.mem");
  const snapLoad = buildSnapshotLoadCall("/s/x.vmstate", "/s/x.mem");
  assert.equal(snapLoad.path, "/snapshot/load");
  const slBody = snapLoad.body as {
    snapshot_path: string;
    mem_backend: { backend_type: string; backend_path: string };
    resume_vm: boolean;
  };
  assert.equal(slBody.snapshot_path, "/s/x.vmstate");
  assert.equal(slBody.mem_backend.backend_type, "File");
  assert.equal(slBody.mem_backend.backend_path, "/s/x.mem");
  assert.equal(slBody.resume_vm, true);
  ok("snapshot API calls: PATCH /vm Paused → /snapshot/create(Full) → /snapshot/load(resume)");

  // 2. Custom boot args (e.g. the pidsLimit cmdline) pass through.
  const withPids = buildFcApiCalls({
    kernelPath: "/k",
    rootfsPath: "/r",
    workspacePath: "/w",
    vcpus: 1,
    memMib: 256,
    vsockUds: "/v",
    bootArgs: `${FC_DEFAULT_BOOT_ARGS} hotcell.pids=64 sbx.pids=64`,
  });
  assert.match((withPids[0]!.body as { boot_args: string }).boot_args, /hotcell\.pids=64/);
  ok("custom boot args (pidsLimit cmdline) flow through");

  // 2b. Opt-in networking adds a network-interface + the kernel ip= autoconfig.
  const withNet = buildFcApiCalls({
    kernelPath: "/k",
    rootfsPath: "/r",
    workspacePath: "/w",
    vcpus: 1,
    memMib: 256,
    vsockUds: "/v",
    net: {
      tap: "hct2",
      guestMac: "02:fc:00:00:00:02",
      guestIp: "172.16.2.2",
      gatewayIp: "172.16.2.1",
      mask: "255.255.255.252",
    },
  });
  const nic = withNet.find((c) => c.path === "/network-interfaces/eth0");
  assert.ok(nic, "network-interface call is present when networked");
  assert.equal((nic!.body as { host_dev_name: string }).host_dev_name, "hct2");
  assert.match(
    (withNet[0]!.body as { boot_args: string }).boot_args,
    /ip=172\.16\.2\.2::172\.16\.2\.1:255\.255\.255\.252::eth0:off/,
  );
  assert.ok(!buildFcApiCalls({ kernelPath: "/k", rootfsPath: "/r", workspacePath: "/w", vcpus: 1, memMib: 256, vsockUds: "/v" }).some((c) => c.path.includes("network-interfaces")), "no NIC by default");
  ok("opt-in networking: eth0 NIC + kernel ip= autoconfig (none by default)");

  // 2c. Networked TAP firewall: NAT out of the default-route iface only. The
  // guest must not reach host services (INPUT), cloud metadata (169.254/16) or
  // other TAPs/bridges, and teardown must delete every rule setup installed.
  {
    const net = { tap: "hct7", guestMac: "02:fc:00:00:00:07", guestIp: "172.16.7.2", gatewayIp: "172.16.7.1", mask: "255.255.255.252" };
    const setup = fcTapSetupCommands(net, "ens4");
    const teardown = fcTapTeardownCommands(net, "ens4");
    const idxOf = (re: RegExp) => setup.findIndex((c) => re.test(c));
    const guardInput = idxOf(/^iptables -C INPUT -i hct7 -j DROP .*\|\| iptables -I INPUT 1 -i hct7 -j DROP$/);
    const guardMeta = idxOf(/^iptables -C FORWARD -i hct7 -d 169\.254\.0\.0\/16 -j DROP .*\|\| iptables -I FORWARD 1 /);
    const guardIface = idxOf(/^iptables -C FORWARD -i hct7 ! -o ens4 -j DROP .*\|\| iptables -I FORWARD 1 /);
    const accept = idxOf(/-A FORWARD -i hct7 -o ens4 -j ACCEPT$/);
    const masq = idxOf(/^iptables -t nat -C POSTROUTING -s 172\.16\.7\.0\/30 -o ens4 -j MASQUERADE/);
    const linkUp = idxOf(/^ip link set hct7 up$/);
    const noV6 = idxOf(/net\.ipv6\.conf\.hct7\.disable_ipv6=1/);
    for (const [name, i] of Object.entries({ guardInput, guardMeta, guardIface, accept, masq, linkUp, noV6 })) {
      assert.ok(i >= 0, `setup includes ${name}`);
    }
    assert.ok(Math.max(guardInput, guardMeta, guardIface) < Math.min(accept, masq), "guards are installed before the NAT ACCEPT");
    assert.ok(noV6 < linkUp, "IPv6 is disabled on the TAP before it comes up (no host link-local)");
    assert.ok(!setup.some((c) => / -A INPUT .* -j ACCEPT/.test(c) || / -I INPUT .* -j ACCEPT/.test(c)), "no INPUT ACCEPT for the TAP");
    // Teardown symmetry: one -D per rule setup adds, with the identical spec.
    const added = setup
      .filter((c) => c.includes(" -C "))
      .map((c) => c.split(" 2>/dev/null")[0]!.replace(" -C ", " -D "));
    const deleted = teardown.filter((c) => c.includes(" -D ")).map((c) => c.split(" 2>/dev/null")[0]!);
    assert.deepEqual(deleted.slice().sort(), added.slice().sort(), "teardown deletes exactly the rules setup added");
    assert.equal(teardown[teardown.length - 1], "ip link del hct7 2>/dev/null || true", "teardown removes the TAP last");
    ok("networked TAP firewall: no host INPUT, no 169.254/16, ext-only FORWARD, symmetric teardown");
  }

  // 3. vsock handshake parser: incomplete → null; OK line → split leftover; bad → not ok.
  assert.equal(parseVsockHandshake(Buffer.from("OK 1024")), null, "no newline yet → null");
  const okParse = parseVsockHandshake(Buffer.from("OK 1024\nHELLOBYTES"));
  assert.ok(okParse && okParse.ok, "OK line parses as ok");
  assert.equal(okParse!.leftover.toString(), "HELLOBYTES", "post-handshake bytes preserved");
  const badParse = parseVsockHandshake(Buffer.from("CONNECTION RESET\n"));
  assert.ok(badParse && !badParse.ok, "non-OK line parses as not ok");
  ok("vsock CONNECT handshake parser: incomplete / ok+leftover / failure");

  // 4. Driver fail-fast on a non-KVM host (this Mac): ping names /dev/kvm.
  const driver = new FirecrackerDriver({
    fcBin: "firecracker",
    kernel: "/nonexistent/vmlinux",
    rootfs: "helpers/hotcell-vz/guest/rootfs.img",
    stateDir: "/tmp/hotcell-fc-check",
    diskGb: 8,
    imageCacheDir: "/tmp/hotcell-fc-check/images",
  });
  assert.equal(driver.name, "firecracker");
  if (process.platform !== "linux") {
    await assert.rejects(() => driver.ping(), /\/dev\/kvm/, "ping fails fast with a /dev/kvm message off-KVM");
    ok("ping fails fast naming /dev/kvm (host without KVM)");
  } else {
    ok("ping skipped (on Linux — may have /dev/kvm; live boot is smoke:fc)");
  }

  // 5. hostInfo works anywhere (os fallback when /proc is absent).
  const host = await driver.hostInfo();
  assert.ok(host.memoryMb > 0, "hostInfo reports memory");
  assert.ok(host.cpus > 0, "hostInfo reports cpus");
  ok(`hostInfo: ${host.memoryMb}MB / ${host.cpus} cpus`);

  console.log(`\nfc-check: ${passed} checks passed (host-agnostic; live boot gated on KVM)`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("fc-check FAILED:", err);
    process.exit(1);
  },
);
