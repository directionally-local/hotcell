# sbx-agent

The **in-sandbox agent**: a tiny static Linux binary that runs as PID 1 inside each container or microVM and serves a framed, multiplexed protocol to the daemon over a Unix socket on Linux containers, authenticated loopback TCP on non-Linux Docker hosts, or vsock (Firecracker / Apple VZ).

This agent is the single implementation of sandbox operations across all drivers. The container driver mounts the static binary read-only; Linux uses a per-sandbox socket directory, while Docker Desktop-style hosts use a loopback-only published TCP port with a per-sandbox token. MicroVMs use vsock. The TypeScript `AgentDriver` routes exec, files, processes, terminal, watch, stats, and backup operations through the same wire protocol.

> Status: protocol, server, and transports are built. Static binaries target `linux/amd64` and `linux/arm64`; `npm run check:container-agent` exercises the Unix-socket driver path without Docker, `npm run check:container-agent-tcp` exercises authenticated TCP plus endpoint recovery through fake port mapping, `npm run check:agent` covers both handshakes, and `npm run smoke` validates the live container path. Container package releases include both architecture binaries.

## Why Go, why a separate module

- **Go**: trivial static `linux/{amd64,arm64}` cross-compile from macOS with `CGO_ENABLED=0`, and the stdlib (plus `golang.org/x/sys/unix` for `AF_VSOCK`) covers everything the agent needs. The result is a single dependency-free binary (~4 MB) baked into the guest rootfs — the only per-sandbox process we add.
- **Separate module** (`agent/` with its own `go.mod`, like `sdk/python` is top-level): keeps Go out of the npm-workspaces build and the TS toolchain out of the agent.

## Layout

```
agent/
  proto/                 wire protocol — framing + message structs (mirrors the daemon's wire types)
  server/                transport-agnostic Serve(io.ReadWriteCloser) + per-method handlers
    stats_linux.go         real /proc + cgroup reads (the guest)
    stats_other.go         stub so the package compiles/tests on macOS
  cmd/hotcell-agent/     entrypoint + transports
    listen_portable.go     tcp:// / unix:// dev transport (any OS)
    listen_linux.go        AF_VSOCK transport (the production path)
    listen_other.go        non-Linux: vsock unavailable, use HOTCELL_AGENT_LISTEN
```

The protocol and server are **pure, portable Go**: `Serve` takes any `io.ReadWriteCloser`, so the whole thing is unit-testable on a developer's macOS box over `net.Pipe` / a unix socket, with no vsock and no guest. Only `stats` is platform-specific.

## Protocol (summary)

A single host↔guest connection multiplexes many streams. Frame:

```
[u32 length][u8 type][u32 streamId][payload]
```

Types: `Control` (JSON request / control msg), `Stdin`/`Stdout`/`Stderr` (byte channels), `EOF`, `Result` (terminal JSON outcome), `Close`. The guest sends an unsolicited `Control` **Hello** on stream 0 at connect; the host's `create()` blocks on it. See `proto/frame.go` for the full spec. Request/Result JSON field names mirror the daemon's `ExecEvent`/`FileInfo`/`SandboxStats`, so the host driver marshals with the same vocabulary it already uses for the container driver.

## Develop / test / build

```bash
cd agent
go test ./...          # protocol + server + transport, all on macOS (no vsock)
go vet ./...

# build for the guest (static, no cgo):
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o hotcell-agent ./cmd/hotcell-agent   # Apple VZ guest
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o hotcell-agent ./cmd/hotcell-agent   # Firecracker on x86
```

From the repo root: `npm run test:agent` / `npm run build:agent`.

### Run it locally (no microVM)

```bash
# terminal 1 — serve over a local TCP port instead of vsock:
HOTCELL_AGENT_LISTEN=tcp://127.0.0.1:9000 go run ./cmd/hotcell-agent
```

A host-side client connects, reads the Hello frame, then sends `Control` request frames and reads back `Stdout`/`Stderr`/`Result` frames. (`server/server_test.go` and `cmd/sbx-agent/listen_portable_test.go` are exactly such clients.)

Inside a guest, with no `SBX_AGENT_LISTEN`, the agent binds `AF_VSOCK` on `SBX_AGENT_VSOCK_PORT` (default 1024) and the daemon connects to it through the VM's virtio-vsock device.
