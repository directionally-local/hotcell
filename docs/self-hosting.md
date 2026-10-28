# Self-hosting on Linux (GCP / AWS)

[← back to README](../README.md)

The container driver is the same codepath on macOS and Linux — it talks to the Docker Engine API, not anything host-specific — so a Mac Mini and a GCE/EC2 Linux VM run hotcell identically. On a fresh Ubuntu/Debian VM:

```bash
# 1. Docker (native dockerd — the daemon finds /var/run/docker.sock automatically)
curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker "$USER"   # re-login

# 2. Node ≥22 (for node:sqlite + global WebSocket), then install
node -v   # must be ≥ 22
npm install -g hotcell        # or clone + `npm install && npm run build` to hack on it

# 3. Start the daemon. For remote access, bind a real interface + require a key:
HOTCELL_HOST=0.0.0.0 HOTCELL_API_KEY="$(openssl rand -hex 24)" hotcell start
```

> For a long-running service, run the raw entrypoint under a process manager (systemd) instead of `hotcell start` — the bin is **`hotcelld`**. A systemd unit is also where you grant `CAP_NET_ADMIN` for enforced egress (below).

## Egress on Linux

Auto-handled on macOS Docker Desktop; on Linux there are three things to know:

- **Gateway reachability.** Sandboxes call back to the daemon via `host.docker.internal`. The daemon maps that name to the bridge gateway for you (`ExtraHosts: host-gateway`), but the gateway must also *bind* somewhere the bridge can reach — loopback isn't. Set **`HOTCELL_EGRESS_HOST=0.0.0.0`** (protected by the per-sandbox token + your VM firewall) if you use `--egress`.
- **Default-deny enforcement** (`HOTCELL_EGRESS_ENFORCE=true`) installs host `DOCKER-USER` iptables, so the daemon needs iptables privileges — run it as root or grant `CAP_NET_ADMIN` (e.g. a systemd unit with `AmbientCapabilities=CAP_NET_ADMIN`). Keep `HOTCELL_EGRESS_ADVERTISE_HOST=host.docker.internal` under enforcement so the proxy + firewall agree on the gateway address. Validated on GCP Ubuntu 24.04.
- **Non-default Docker runtimes** (colima, remote, rootless): export `DOCKER_HOST` — docker-modem honors it. Native `dockerd` and Docker Desktop need nothing.

> **Stronger isolation (microVMs):** the default container driver shares the host kernel. For VM-grade per-sandbox isolation, both microVM drivers ship live behind the same interface — the **Firecracker driver** on Linux (needs `/dev/kvm`: a bare-metal box or a *nested-virtualization* GCE/EC2 instance) and the **Apple VZ driver** on macOS. Select per sandbox (`driver: "firecracker" | "applevz"`) or daemon-wide (`HOTCELL_DRIVER`). Both boot in well under a second via warm pools and support pause/resume via a full-VM memory snapshot. See [plan.md](plan.md).

## Security model

hotcell is **single-tenant** by design: the API offers arbitrary command execution *inside* sandboxes (that's the point), so anyone who can reach the API controls them. Treat API access as shell access.

- **Bind + auth.** Loopback by default, and the API always requires a key: set `HOTCELL_API_KEY`, or the daemon generates one in `~/.hotcell/api-key` (0600) that the local CLI and SDKs pick up on their own. Sandboxes can reach the host (`host.docker.internal`), so an open API would let one sandbox drive the others. Requests a browser marks as cross-site are refused too. Exposing it on a network? Bind a real interface via `HOTCELL_HOST` and give remote clients the key. The dashboard asks for it, or open `/dashboard#key=<key>`.
- **Keys out of the sandbox.** Provider keys live on the daemon; sandboxes get revocable, policy-scoped tokens (see the [egress control plane](egress.md)). Combined with `HOTCELL_EGRESS_ENFORCE` on Linux, even a stolen token can't be exfiltrated — there's nowhere to send it.
- **Spend bounds.** Per-token (`--spend-cap`) and per-sandbox (`--egress-spend-cap`) hard ceilings cap LLM cost even if a token is abused before you revoke it.
- **Browser guard.** On a loopback bind, the API rejects requests whose `Host` isn't loopback / `HOTCELL_HOST` / `HOTCELL_ALLOWED_HOSTS` — a DNS-rebinding / localhost-CSRF guard.
- **DoS bounds.** Request bodies are capped (`HOTCELL_MAX_BODY_BYTES`) and WebSocket messages are size-limited.
- **Isolation.** The container driver shares the host kernel; per-sandbox CPU/memory/PID caps are available. For **hardware** isolation, switch to a microVM driver — `firecracker` (Linux + KVM) or `applevz` (macOS), both shipped and selectable per sandbox — each sandbox a separate VM with its own kernel.

## Architecture

- **`hotcelld`** — single control-plane daemon per host: hand-rolled `node:http` REST API + WebSocket, embedded SQLite state, idle reaper, metrics sampler, preview proxy, egress control plane, and a pluggable runtime-driver layer. (`hotcell start` launches it in the background for you.)
- **Runtime drivers** — the core abstraction (`create`/`exec`/`openTerminal`/files/ports/backup/stats/…), selected by `HOTCELL_DRIVER` or per sandbox at create time. All three ship live behind the same interface: `container` (Docker, Linux + macOS; optional `HOTCELL_CONTAINER_WARM_POOL`), `firecracker` (Linux + KVM), and `applevz` (macOS) microVMs — the microVM drivers with warm pools and memory-snapshot pause/resume — so the daemon/SDKs/CLI are unchanged when you swap isolation tiers.
- **SDKs** — TypeScript + Python, mirroring the Cloudflare Sandbox surface so existing harnesses adopt with near-zero friction.

See [plan.md](plan.md) for the full spec and phased roadmap, and `KIMI.md` for contributor/agent context.
