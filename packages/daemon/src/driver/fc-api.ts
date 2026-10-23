import { request } from "node:http";
import { connect, type Socket } from "node:net";

/**
 * Firecracker control plane — the host-agnostic pieces of the `firecracker`
 * driver that compile and unit-test anywhere (no `/dev/kvm`): the VM
 * configuration the daemon PUTs over Firecracker's HTTP-API-over-unix-socket,
 * and the virtio-vsock UDS handshake the daemon uses to reach the in-guest agent.
 *
 * Only the *live boot* (spawning `firecracker`, the real vsock round-trip) needs
 * a KVM host; everything here is pure logic + thin I/O, exercised by `check:fc`.
 */

/** A single Firecracker API call (a PUT/PATCH of a JSON body to the API socket). */
export interface FcApiCall {
  method: "PUT" | "PATCH";
  path: string;
  body: Record<string, unknown>;
}

/** Inputs for a microVM's boot configuration. */
export interface FcVmSpec {
  kernelPath: string;
  /** Read-only base rootfs (becomes /dev/vda). */
  rootfsPath: string;
  /** Read-write per-sandbox workspace disk (becomes /dev/vdb). */
  workspacePath: string;
  vcpus: number;
  memMib: number;
  /** Host unix-socket path Firecracker exposes for guest vsock. */
  vsockUds: string;
  /** Guest context id (host is 2; guests use 3+). */
  guestCid?: number;
  /** Override the kernel command line (mainly for tests). */
  bootArgs?: string;
  /**
   * Mount the rootfs read-write instead of the default read-only shared mode.
   * Used by "trusted VM" (networked) sandboxes that need to write to `/` (apt,
   * node into /opt, etc.). Requires a private per-sandbox rootfs copy.
   */
  rootfsReadOnly?: boolean;
  /**
   * Opt-in guest networking. When set, the microVM gets an eth0 backed by the
   * host TAP device, auto-configured at boot via the kernel `ip=` param (no
   * in-guest tooling needed). Off by default — the flagship posture is a guest
   * with NO network device (egress only over vsock).
   */
  net?: FcNetSpec;
}

/** TAP-backed guest networking parameters (host side sets up the TAP + NAT). */
export interface FcNetSpec {
  /** Host TAP device name (e.g. `hctap0`). */
  tap: string;
  /** Guest MAC address. */
  guestMac: string;
  /** Guest IP (e.g. `172.16.0.2`). */
  guestIp: string;
  /** Gateway = the host TAP IP (e.g. `172.16.0.1`). */
  gatewayIp: string;
  /** Netmask (e.g. `255.255.255.0`). */
  mask: string;
}

/** Default kernel cmdline: serial console, no PCI, our agent as init, ro root. */
export const FC_DEFAULT_BOOT_ARGS =
  "console=ttyS0 reboot=k panic=1 pci=off init=/init root=/dev/vda ro";

/**
 * Build the ordered list of API calls that fully configure a microVM, ready to
 * `InstanceStart`. Pure — the driver applies these in order over the API socket.
 * The drive order matters: the root device is /dev/vda, the workspace /dev/vdb
 * (matching the shared guest init, which mounts /dev/vdb at /workspace).
 */
export function buildFcApiCalls(spec: FcVmSpec): FcApiCall[] {
  // With networking, auto-configure eth0 via the kernel `ip=` param at boot:
  //   ip=<guest>::<gw>:<mask>::eth0:off   (no in-guest tooling required).
  let baseArgs = spec.bootArgs ?? FC_DEFAULT_BOOT_ARGS;
  if (spec.rootfsReadOnly === false) baseArgs = baseArgs.replace("root=/dev/vda ro", "root=/dev/vda rw");
  const bootArgs = spec.net
    ? `${baseArgs} ip=${spec.net.guestIp}::${spec.net.gatewayIp}:${spec.net.mask}::eth0:off`
    : baseArgs;
  const calls: FcApiCall[] = [
    {
      method: "PUT",
      path: "/boot-source",
      body: { kernel_image_path: spec.kernelPath, boot_args: bootArgs },
    },
    {
      method: "PUT",
      path: "/machine-config",
      body: { vcpu_count: spec.vcpus, mem_size_mib: spec.memMib, smt: false },
    },
    {
      method: "PUT",
      path: "/drives/rootfs",
      body: {
        drive_id: "rootfs",
        path_on_host: spec.rootfsPath,
        is_root_device: true,
        is_read_only: spec.rootfsReadOnly ?? true,
      },
    },
    {
      method: "PUT",
      path: "/drives/workspace",
      body: {
        drive_id: "workspace",
        path_on_host: spec.workspacePath,
        is_root_device: false,
        is_read_only: false,
      },
    },
    {
      method: "PUT",
      path: "/vsock",
      body: { guest_cid: spec.guestCid ?? 3, uds_path: spec.vsockUds },
    },
  ];
  if (spec.net) {
    calls.push({
      method: "PUT",
      path: "/network-interfaces/eth0",
      body: { iface_id: "eth0", host_dev_name: spec.net.tap, guest_mac: spec.net.guestMac },
    });
  }
  return calls;
}

/** The action that boots a configured VM. */
export const FC_START_ACTION: FcApiCall = {
  method: "PUT",
  path: "/actions",
  body: { action_type: "InstanceStart" },
};

/** The call that pauses a running VM's vCPUs (required before /snapshot/create). */
export const FC_PAUSE_VM: FcApiCall = {
  method: "PATCH",
  path: "/vm",
  body: { state: "Paused" },
};

/** Build the call that writes a Full snapshot (device state + guest RAM) to disk. */
export function buildSnapshotCreateCall(vmstatePath: string, memPath: string): FcApiCall {
  return {
    method: "PUT",
    path: "/snapshot/create",
    body: { snapshot_type: "Full", snapshot_path: vmstatePath, mem_file_path: memPath },
  };
}

/**
 * Build the call that restores a **fresh, unconfigured** VMM process from a
 * snapshot and resumes it immediately. The snapshot pins the original host paths
 * (kernel/rootfs/workspace drives, vsock UDS), so those files must still exist at
 * the same locations; Firecracker re-binds the vsock UDS listener itself on load.
 */
export function buildSnapshotLoadCall(vmstatePath: string, memPath: string): FcApiCall {
  return {
    method: "PUT",
    path: "/snapshot/load",
    body: {
      snapshot_path: vmstatePath,
      mem_backend: { backend_type: "File", backend_path: memPath },
      resume_vm: true,
    },
  };
}

/**
 * Parse Firecracker's vsock host→guest handshake reply. After the host connects
 * to the vsock UDS and writes `CONNECT <port>\n`, Firecracker replies with a line
 * `OK <hostPort>\n` on success, or `OK`-less text on failure. Returns the rest of
 * the buffer after the newline (which may already hold agent bytes) when the line
 * is present, or null if no complete line has arrived yet. Pure — unit-tested.
 */
export function parseVsockHandshake(buf: Buffer): { ok: boolean; line: string; leftover: Buffer } | null {
  const nl = buf.indexOf(0x0a);
  if (nl === -1) return null; // wait for a complete line
  const line = buf.subarray(0, nl).toString("utf8").trim();
  return { ok: /^OK\s+\d+/.test(line), line, leftover: buf.subarray(nl + 1) };
}

/** Thin client for Firecracker's HTTP API over its unix socket. */
export class FcApi {
  constructor(private readonly socketPath: string) {}

  /** Apply one API call; resolves on 2xx, rejects with the body otherwise. */
  call(c: FcApiCall): Promise<void> {
    const data = Buffer.from(JSON.stringify(c.body));
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          method: c.method,
          path: c.path,
          headers: { "content-type": "application/json", "content-length": data.length },
        },
        (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => {
            const code = res.statusCode ?? 0;
            if (code >= 200 && code < 300) resolve();
            else reject(new Error(`firecracker ${c.path} -> ${code}: ${body}`));
          });
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  }

  /** Apply a sequence of calls in order. */
  async applyAll(calls: FcApiCall[]): Promise<void> {
    for (const c of calls) await this.call(c);
  }
}

/**
 * Connect to a guest vsock port through Firecracker's UDS multiplexer: open the
 * UDS, write `CONNECT <port>\n`, await the `OK <port>` line, and hand back the
 * live socket plus any bytes that arrived after the handshake (often the agent's
 * Hello). The caller wires the socket into an `AgentConn`.
 */
export function fcVsockConnect(
  udsPath: string,
  port: number,
  timeoutMs = 15000,
): Promise<{ socket: Socket; leftover: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = connect(udsPath);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`firecracker vsock connect to :${port} timed out`));
    }, timeoutMs);
    const onData = (d: Buffer): void => {
      buf = Buffer.concat([buf, d]);
      const parsed = parseVsockHandshake(buf);
      if (!parsed) return; // wait for the full line
      socket.off("data", onData);
      clearTimeout(timer);
      if (!parsed.ok) {
        socket.destroy();
        reject(new Error(`firecracker vsock handshake failed: "${parsed.line}"`));
        return;
      }
      resolve({ socket, leftover: parsed.leftover });
    };
    socket.on("connect", () => socket.write(`CONNECT ${port}\n`));
    socket.on("data", onData);
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** One iptables rule a networked sandbox's TAP needs (pure data; see {@link fcTapSetupCommands}). */
export interface FcTapRule {
  table: "filter" | "nat";
  chain: string;
  /** `insert` = top of the chain (guards that must win over any earlier ACCEPT); `append` = end. */
  position: "insert" | "append";
  /** Match + target, e.g. `["-i", "hct2", "-j", "DROP"]`. */
  spec: string[];
}

/**
 * The host firewall rules for a networked (`networked: true`) Firecracker
 * sandbox's TAP, in install order. The guest gets NAT'd internet out of the
 * default-route interface `ext` and nothing else:
 *
 * - **INPUT drop on the TAP**: the guest never needs a host-local service. Its
 *   eth0 is configured statically by the kernel `ip=` param (no DHCP), DNS goes
 *   to public resolvers (forwarded, not the gateway), and the egress gateway is
 *   reached over vsock through the in-guest loopback relay — so without this,
 *   the TAP gateway IP (or any other host address) would expose every host
 *   service bound on 0.0.0.0 to code in the VM.
 * - **FORWARD drop to 169.254.0.0/16**: the cloud instance-metadata service
 *   (GCE/AWS/Azure `169.254.169.254`) hands out the host's credentials and
 *   routes out of `ext`, so the generic ACCEPT below would otherwise let it through.
 * - **FORWARD drop to anything but `ext`**: no routing into other sandboxes'
 *   TAPs or local bridges (docker0, …) even when the FORWARD policy is ACCEPT.
 *
 * Guards are inserted at the top of their chain so no earlier ACCEPT (Docker,
 * ufw, …) can shadow them. Teardown deletes exactly this list
 * ({@link fcTapTeardownCommands}), so setup and teardown stay symmetric.
 */
export function fcTapRules(tap: string, ext: string, subnet: string): FcTapRule[] {
  return [
    { table: "filter", chain: "INPUT", position: "insert", spec: ["-i", tap, "-j", "DROP"] },
    { table: "filter", chain: "FORWARD", position: "insert", spec: ["-i", tap, "-d", "169.254.0.0/16", "-j", "DROP"] },
    { table: "filter", chain: "FORWARD", position: "insert", spec: ["-i", tap, "!", "-o", ext, "-j", "DROP"] },
    { table: "nat", chain: "POSTROUTING", position: "append", spec: ["-s", subnet, "-o", ext, "-j", "MASQUERADE"] },
    { table: "filter", chain: "FORWARD", position: "append", spec: ["-i", tap, "-o", ext, "-j", "ACCEPT"] },
    {
      table: "filter",
      chain: "FORWARD",
      position: "append",
      spec: ["-i", ext, "-o", tap, "-m", "state", "--state", "RELATED,ESTABLISHED", "-j", "ACCEPT"],
    },
  ];
}

function iptablesPrefix(r: FcTapRule): string {
  return r.table === "nat" ? "iptables -t nat" : "iptables";
}

/** The /30 a sandbox's TAP owns, derived from its guest IP (`172.16.N.2` → `172.16.N.0/30`). */
export function fcTapSubnet(net: FcNetSpec): string {
  return net.guestIp.replace(/\.\d+$/, ".0") + "/30";
}

/**
 * Shell commands (run with `bash -lc`, in order) that create a networked
 * sandbox's TAP and install {@link fcTapRules}. Each rule is idempotent
 * (`-C … || -I/-A …`). IPv6 is disabled on the TAP before it comes up, so the
 * host gets no link-local address the guest could reach host services on (and
 * nothing IPv6, e.g. AWS's `fd00:ec2::254` metadata, is ever routed for it).
 */
export function fcTapSetupCommands(net: FcNetSpec, ext: string): string[] {
  const tap = net.tap;
  const cmds = [
    `ip tuntap add dev ${tap} mode tap 2>/dev/null || true`,
    `[ ! -d /proc/sys/net/ipv6 ] || sysctl -wq net.ipv6.conf.${tap}.disable_ipv6=1`,
    `ip addr add ${net.gatewayIp}/30 dev ${tap} 2>/dev/null || true`,
    `ip link set ${tap} up`,
    `sysctl -wq net.ipv4.ip_forward=1`,
  ];
  for (const r of fcTapRules(tap, ext, fcTapSubnet(net))) {
    const ipt = iptablesPrefix(r);
    const spec = r.spec.join(" ");
    const add = r.position === "insert" ? `${ipt} -I ${r.chain} 1 ${spec}` : `${ipt} -A ${r.chain} ${spec}`;
    cmds.push(`${ipt} -C ${r.chain} ${spec} 2>/dev/null || ${add}`);
  }
  return cmds;
}

/** Best-effort inverse of {@link fcTapSetupCommands}: delete every rule it added, then the TAP. */
export function fcTapTeardownCommands(net: FcNetSpec, ext: string): string[] {
  const cmds = fcTapRules(net.tap, ext, fcTapSubnet(net)).map(
    (r) => `${iptablesPrefix(r)} -D ${r.chain} ${r.spec.join(" ")} 2>/dev/null || true`,
  );
  cmds.push(`ip link del ${net.tap} 2>/dev/null || true`);
  return cmds;
}
