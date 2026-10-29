# AGENTS.md — hotcell

Shared instructions for coding agents working in this repository. Verify details against source and `docs/plan.md`; this project changes quickly.

## Project overview

**hotcell** is self-hostable sandbox infrastructure for coding agents. It is an npm-workspaces monorepo of TypeScript ES modules, with a Go guest agent and a Swift helper for Apple Virtualization.

- The daemon requires Node.js **22 or newer** (`node:sqlite` and global `WebSocket`). SDKs and CLI target Node.js 20+.
- Default runtime: Docker containers. Firecracker requires Linux with KVM; Apple VZ requires macOS and its helper/guest artifacts.
- The container driver runs the static Go `hotcell-agent` as PID 1. The daemon connects over a Unix socket on Linux and authenticated loopback TCP on non-Linux Docker hosts.
- Optional container warm pool: `HOTCELL_CONTAINER_WARM_POOL` (default `0`, disabled). It adopts only fresh spares matching the default image and resolved resource limits. Non-persistent or custom-Docker-labeled creates use the cold path. Pool target memory is charged to admission control.
- Durable control-plane state is SQLite. The daemon also provides API-key auth, lifecycle management, metrics/cost, a dashboard, preview proxy, and an egress credential gateway.
- `docs/plan.md` is the architectural and roadmap source of truth. `docs/reference.md` documents CLI/configuration; `docs/benchmarks.md` records measurements.

## Repository layout

| Path | Purpose |
|---|---|
| `packages/daemon/` | REST/WebSocket API, SQLite store, lifecycle, capacity, runtime drivers |
| `packages/sdk/` | Dependency-free TypeScript HTTP client |
| `packages/cli/` | `hotcell` CLI |
| `packages/mastra/` | Mastra adapter |
| `sdk/python/` | Standard-library Python SDK and smoke test |
| `agent/` | Go guest-agent protocol, server, and entrypoint; separate Go module |
| `images/base/` | Optional richer OCI image (Python, Node, git, bash) |
| `docs/` | Product/architecture plan, operational reference, benchmarks |
| `scripts/` | Build, packaging, validation, and benchmark scripts |

## Build, test, and benchmark

Run from the repository root unless noted.

```bash
npm ci
npm run build:agent                 # static Linux amd64 + arm64 guest binaries
npm run build                       # compile all TypeScript workspaces
npm run typecheck:fast              # fast TS check; run after build
npm run test:agent                  # Go unit tests (no VM required)
npm run check:agent                 # agent protocol over Unix + authenticated TCP
npm run check:container-agent       # container-driver Unix path with fake Docker
npm run check:container-agent-tcp   # authenticated TCP path with fake Docker
npm run check:warmpool              # container pool contract; no Docker/KVM required
npm run check:warmpool:vz           # Apple VZ pool check; requires macOS VZ artifacts
npm run check:fc-fork               # microVM snapshot-fork contract; no KVM required
npm run check:netreconcile          # Docker egress-network reconciliation checks
npm run smoke                       # full daemon/API smoke; requires a Docker-compatible engine
npm run smoke:py                    # Python SDK end-to-end smoke; requires Docker
npm run bench:container-agent       # Docker before/after operation latency
npm run bench:container-warm-pool   # live Docker cold-vs-warm burst benchmark
```

`npm run build` does not build the Go agent. Build it before creating containers from a source checkout. The daemon package's `prepack` bundles both static agents; verify with `npm pack --dry-run --workspace @hotcell/daemon`.

There is no general-purpose JavaScript unit-test runner, linter, or formatter. Use the targeted `check:*` scripts, Go tests, TypeScript builds, and live smoke tests. `smoke:fc`/`smoke:fc:full` require a KVM-capable Linux host; `smoke:vz` requires Apple VZ.

## Architecture notes

- `Driver` (`packages/daemon/src/driver/types.ts`) is the runtime boundary. `DriverRouter` lazily selects and caches drivers per sandbox.
- `ContainerDriver` owns Docker lifecycle, resource limits, networking, and workspace volumes. Agent-served operations go through `AgentDriver`. Linux uses a mounted Unix socket; non-Linux Docker hosts use a loopback-published TCP port protected by a per-sandbox token.
- Container pool spares are one-use: they have not run user code, each owns a distinct workspace volume, and adoption requires exact image/resource-shape matching. User env is applied through the agent; custom Docker labels and `persist: false` fall back to cold creation. Egress-enforced spares use the configured egress network/DNS. Stopping an adopted sandbox removes its container but preserves a workspace-volume mapping for a later start.
- `Driver.poolStats()` is aggregated by `DriverRouter` and passed to `Capacity`; pool memory is reserved at the configured target, not merely the number of currently ready spares.
- `SandboxStore` persists records in SQLite and rehydrates an in-memory cache on daemon startup.
- Request flow: SDK → daemon API → `SandboxStore`/lifecycle/capacity → selected driver → sandbox agent; exec output returns through SSE.

## Code conventions

- TypeScript is strict ESM with `NodeNext` resolution. Include `.js` on relative imports (for example `./config.js`) and use `node:` prefixes for built-ins.
- Use named exports, not CommonJS. Keep the daemon lightweight and the SDKs dependency-free unless a change has a strong justification.
- The Go agent is a separate module under `agent/`; run Go tests from the repository root through `npm run test:agent` or from `agent/` with `go test ./...`.
- Preserve the layering: driver → REST/API → SDK → CLI. Update `docs/plan.md` when architecture or roadmap decisions change.
- Do not manually bump release versions. Release-please handles versioning; commit `package-lock.json` only when dependencies change.

## Configuration and runtime notes

- Default API bind is `127.0.0.1:4750`; default image is `ghcr.io/sinameraji/hotcell-base:latest`.
- `HOTCELL_DRIVER` selects the default driver; `HOTCELL_IMAGE` selects the default sandbox image; `HOTCELL_CONTAINER_WARM_POOL` opts into container spares.
- `HOTCELL_DB` defaults to `~/.hotcell/state.db`. `HOTCELL_HOST_MEMORY_MB`, `HOTCELL_DEFAULT_RESERVATION_MB`, and `HOTCELL_OVERCOMMIT` control admission accounting.
- The daemon honors `DOCKER_HOST`; Docker CLI contexts alone do not necessarily configure the daemon's Docker Engine connection.
- Linux egress enforcement uses host firewall rules and needs the required network privileges (typically `CAP_NET_ADMIN`).

## Safety and review

- Never commit secrets. `.env`, `.env.*`, `.hotcell/`, build output, and local state are ignored.
- Keep hardware-gated tests clearly separated. Do not claim Firecracker/KVM or Apple VZ validation unless it actually ran on a capable host.
- Prefer a feature branch and pull request over direct pushes to `main`; use conventional PR titles. Avoid destructive cleanup commands unless the user explicitly requests them.
