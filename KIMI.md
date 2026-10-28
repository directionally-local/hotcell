# KIMI.md — hotcell Project Context

> Generated context for AI agents working in this repository. Verify assumptions before relying on them; the project is an early MVP and changes quickly.

---

## 1. Project

**hotcell** is a self-hostable sandbox infrastructure for AI coding agents. It lets you spin up many secure, persistent, observable sandboxes on your own hardware (Mac, Linux VM, bare metal) instead of using managed cloud sandboxes.

- **Language / runtime:** TypeScript, ES modules (`"type": "module"`). Node.js ≥20 for the SDK/CLI; the daemon needs **≥22** because the store uses the built-in `node:sqlite`.
- **Package manager:** npm with workspaces
- **License:** Apache-2.0
- **Key frameworks / libraries:** `dockerode` (Docker Engine API), `tsx` (dev runner), native `node:http` + `fetch` + `node:sqlite` (embedded state store)

Current status: **Phases 0–2 complete; Phase 3 started.** The `container` (Docker) driver works on Linux and macOS with the full sandbox API, durable SQLite state, idle lifecycle, metrics + cost meter, structured logs + OTel traces, API-key auth, a web dashboard with a live xterm.js terminal, and an egress credential proxy (LLM gateway). Container sandbox operations now run through the static Go guest agent over a per-sandbox bind-mounted unix socket, shared with the microVM drivers. The runtime driver is selectable via `HOTCELL_DRIVER`; the `firecracker`/`applevz` microVM drivers require KVM/VZ host validation. The daemon now requires Node ≥22 (`node:sqlite` + global `WebSocket`).

---

## 2. Build / test / run

All commands run from the repository root unless noted.

| Command | What it does | Notes |
|---|---|---|
| `npm install` | Install workspace dependencies | Required first step |
| `npm run build` | Compile all workspaces (`tsc`) | Writes to `packages/*/dist/` |
| `npm run build:agent` | Build static Linux guest agents for amd64 + arm64 | Required for container creates from a source checkout; published daemon packages bundle both binaries |
| `npm run dev:daemon` | Run daemon in watch mode with `tsx` | Fast feedback; does not rebuild `dist/` |
| `node packages/daemon/dist/index.js` | Start compiled daemon | Or `hotcelld` via `node_modules/.bin` |
| `npm run smoke` | Build + run `packages/daemon/dist/smoke.js` | Full end-to-end suite (TS surface) |
| `npm run smoke:py` | Build + run `sdk/python/smoke.py` | Python SDK end-to-end (boots daemon on isolated ports) |
| `npm run dev:cli` | Run CLI in watch mode with `tsx` | Fast feedback; does not rebuild `dist/` |
| `hotcell run "<cmd>"` | Create a sandbox, run a command, destroy it | Via `node_modules/.bin/sb` after build |

There is no generic JS test runner or lint/format script. Targeted checks are exposed as `npm run check:*`; Go protocol/server tests run via `npm run test:agent`. Type-checking is performed by `tsc` during `npm run build`.

### Running the daemon locally

1. Ensure Docker (or colima / Apple `container`) is running.
2. `npm install && npm run build:agent && npm run build`
3. `node packages/daemon/dist/index.js`
4. Daemon listens on `http://127.0.0.1:4750` by default.

Environment variables (`packages/daemon/src/config.ts`):

| Variable | Default | Purpose |
|---|---|---|
| `HOTCELL_HOST` | `127.0.0.1` | Bind address |
| `HOTCELL_PORT` | `4750` | Bind port |
| `HOTCELL_IMAGE` | `python:3.11-slim-bookworm` | Default sandbox image |
| `HOTCELL_DB` | `~/.hotcell/state.db` | Embedded SQLite path for durable control-plane state (`:memory:` for ephemeral) |
| `HOTCELL_SLEEP_AFTER_MS` | `0` | Default idle timeout before a sandbox auto-pauses (`0` = disabled; per-sandbox override via `sleepAfter`) |
| `HOTCELL_REAP_INTERVAL_MS` | `15000` | How often the idle reaper scans for sandboxes to auto-pause |
| `HOTCELL_METRICS_INTERVAL_MS` | `10000` | How often the metrics sampler integrates per-sandbox CPU/mem usage (`0` = off) |
| `HOTCELL_COST_CPU_PER_HOUR` | `0.05` | Cost-meter rate: currency per vCPU-hour |
| `HOTCELL_COST_MEM_GB_PER_HOUR` | `0.005` | Cost-meter rate: currency per GB-hour of memory |
| `HOTCELL_COST_EGRESS_PER_GB` | `0.01` | Cost-meter rate: currency per GB of preview-proxy egress |
| `HOTCELL_ENDPOINT` | `http://127.0.0.1:4750` | SDK default endpoint |

---

## 3. Layout

| Path | Rationale |
|---|---|
| `packages/daemon/` | Control-plane daemon (`hotcelld`). Owns the REST API, sandbox store, and runtime-driver abstraction. |
| `packages/sdk/` | TypeScript client SDK (`@hotcell/sdk`). Thin HTTP client that mirrors the Cloudflare Sandbox surface. |
| `sdk/python/` | Python client SDK (`hotcell-sdk`, package `hotcell`). Stdlib-only; mirrors the TS surface, snake_cased. Outside `packages/*` so it's not an npm workspace. |
| `agent/` | **Go module** (`github.com/sinameraji/hotcell/agent`) for the in-sandbox `hotcell-agent` shared by container + microVM drivers. Separate `go.mod`, outside the npm workspaces. `proto/` = wire protocol, `server/` = transport-agnostic handlers, `cmd/hotcell-agent/` = entrypoint + transports. Dev: `npm run test:agent` (tests run on macOS over net.Pipe/unix, no vsock); ship: `npm run build:agent` (static `linux/{amd64,arm64}`). Only dep: `golang.org/x/sys` (for `AF_VSOCK`). See `agent/README.md`. |
| `packages/cli/` | `hotcell` CLI. Commands: `run`, `ls`, `rm`. Uses `@hotcell/sdk` to talk to the daemon. |
| `images/base/` | OCI image definition for the richer sandbox workspace (Python 3.11 + Node 22 + git/bash). |
| `docs/plan.md` | Long-form product/architecture spec and phased build plan. |
| `tsconfig.base.json` | Shared strict TypeScript config extended by every workspace. |

### Daemon source organization

| Path | Responsibility |
|---|---|
| `src/index.ts` | Entry point: loads config, pings Docker, starts HTTP server. |
| `src/api/server.ts` | Hand-rolled `node:http` REST server (Phase 0 endpoints). |
| `src/driver/` | Runtime-driver interface (`types.ts`) and container implementation (`container.ts`). |
| `src/store.ts` | Sandbox registry backed by embedded SQLite (`node:sqlite`); in-memory `Map`s are a write-through cache rehydrated from the DB on startup. |
| `src/lifecycle.ts` | Lifecycle FSM transitions (`pauseSandbox`/`resumeSandbox`) + the idle reaper (`reapIdle`/`startReaper`). |
| `src/metrics.ts` | In-process metrics sampler (`sampleUsage`/`startSampler`) integrating per-sandbox CPU/mem usage from the Docker stats API. |
| `src/cost.ts` | Cost meter: turns cumulative usage into a `{cpu, mem, total}` breakdown via configurable rates. |
| `src/web/dashboard.ts` | Dependency-free single-page dashboard (vanilla JS/CSS string) served at `GET /`. |
| `src/config.ts` | Environment-driven configuration. |
| `src/types.ts` | Shared daemon types. |

---

## 4. Conventions

### Code style

- **ES modules only.** Every workspace has `"type": "module"`.
- **Import style:** explicit relative imports with `.js` extension, e.g. `import { loadConfig } from "./config.js"`. Required by `NodeNext` module resolution.
- **Node built-ins:** prefix with `node:`, e.g. `import { createServer } from "node:http"`.
- **Export style:** named `export` declarations; no `module.exports`.
- **Naming:** `PascalCase` for classes/interfaces/types, `camelCase` for functions/variables, `kebab-case` for files.

### TypeScript

- `tsconfig.base.json` enables `strict`, `forceConsistentCasingInFileNames`, `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2022`.
- Each workspace extends the base config and sets `outDir: dist`, `rootDir: src`.
- The SDK additionally includes `DOM` lib because it parses `ReadableStream` from `fetch` responses.

### Git

- **Commit style:** conventional prefixes observed: `scaffold:`, `daemon:`, `docs:`.
- **Branching:** single `main` branch; no feature branches observed in history.

### Testing

- **No tests exist yet.** There is no test runner, no test scripts, and no `*.test.ts` / `*.spec.ts` files.

### Docker / images

- The daemon requires a running Docker-compatible runtime.
- Default sandbox image is `python:3.11-slim-bookworm` so the vertical slice works without building images.
- Build `images/base/Dockerfile` and set `HOTCELL_IMAGE=hotcell/base:latest` for the richer toolset.

---

## 5. Dependencies

### Adding dependencies

```bash
# Runtime dependency in a workspace
npm install <pkg> --workspace @hotcell/daemon

# Dev dependency in a workspace
npm install <pkg> --workspace @hotcell/daemon --save-dev

# Root dev dependency (e.g. shared tooling)
npm install <pkg> --save-dev
```

### Conventions

- Keep the daemon lightweight; avoid heavy frameworks. Current daemon uses only `dockerode` plus Node built-ins.
- The SDK has **zero runtime dependencies** today — keep it that way if possible. The Python SDK (`sdk/python`) is likewise **stdlib-only** (`urllib` + `json`).
- Native / external dependencies that must stay external:
  - `dockerode` and `@types/dockerode` (Docker Engine API client)
  - TypeScript toolchain (`typescript`, `tsx`, `@types/node`)
- Version pinning: `package.json` uses caret ranges; `package-lock.json` locks exact versions. Commit `package-lock.json` changes.

---

## 6. Do / Don't

1. **Do not commit secrets.** `.gitignore` excludes `.env`, `.env.*`, and `.hotcell/`.
2. **Do not use CommonJS.** All packages are ES modules.
3. **Do not drop the `.js` extension** from relative TypeScript imports — `NodeNext` resolution requires it.
4. **Do not add a heavy web framework** to the daemon without discussion; the Phase 0 server is intentionally hand-rolled.
5. **CLI exists.** `packages/cli` implements the full surface — `run`/`create`/`exec`/`ls`/`rm`/`stats`/`stop`/`start`/`files`/`watch`/`ps`/`kill`/`logs`/`wait-port`/`expose`/`env`/`session`/`run-code`/`backup`/`restore`/`backups`/`egress`/`terminal`.
6. **Do not run the smoke script as a correctness check** until `packages/daemon/dist/smoke.js` (or `src/smoke.ts`) is added.
7. **Do keep the SDK dependency-free** unless there is a strong reason to add a runtime dependency.
8. **Do update `docs/plan.md`** when architectural decisions change; it is the source of truth for the phased roadmap.

---

## 7. Debugging & Troubleshooting

### Daemon fails to start

- Error: `container runtime (Docker) is not reachable`
  - Fix: start Docker Desktop, colima, or an Apple `container` daemon.

### Build issues

- `Cannot find module './foo.js'` — ensure the import includes the `.js` extension.
- `Cannot use import statement outside a module` — verify the package has `"type": "module"`.

### Reset / clean

```bash
rm -rf node_modules packages/*/dist
npm install
npm run build
```

### Logs

- The daemon logs to stdout/stderr only. There is no log file yet.
- Container exec output is streamed via Server-Sent Events (`/sandboxes/:id/exec`).

---

## 8. Architecture Notes

### Key abstractions

- **`Driver` interface** (`packages/daemon/src/driver/types.ts`): the runtime boundary. Future Firecracker / Apple VZ drivers implement this same surface so the API and SDK stay unchanged.
- **`ContainerDriver`**: backs sandboxes with Docker containers running the static `hotcell-agent` as PID 1. A read-only binary bind mount and a per-sandbox unix-socket mount connect the daemon to the shared `AgentDriver` operations; Docker still handles lifecycle, volumes, limits, and networking.
- **`SandboxStore`**: registry backed by embedded SQLite (`node:sqlite`), with in-memory `Map`s as a write-through cache rehydrated on startup, so records survive a daemon restart.
- **Lifecycle FSM**: status is `running` | `paused` | `stopped`. The idle reaper (`src/lifecycle.ts`) auto-pauses `running` sandboxes idle past `sleepAfterMs` (skipping those with exposed ports / running processes); any container-work op auto-resumes a `paused` sandbox via the `ensureLive` choke point in `api/server.ts`. `store.touch` records activity (also on proxy traffic). Manual `stop` → `stopped` is never auto-resumed.
- **Metrics + cost (Phase 2)**: `driver.stats(id)` reads guest `/proc`/cgroup stats through the agent (container and microVM drivers); the sampler (`src/metrics.ts`) integrates `cpuSeconds`/`memByteSeconds` into the persisted `usage` column and the preview proxy meters `egressBytes`; `src/cost.ts` applies configurable rates (cpu + mem + egress). Surfaced at `GET /sandboxes/:id/metrics` (`?live=0` skips the live runtime call), SDK `Sandbox.metrics()`, CLI `hotcell stats`.
- **Dashboard (Phase 2)**: served at `GET /` from `src/web/dashboard.ts` (no build step); `GET /info` exposes driver/image/proxy/cost-rates for it.
- **`HotcellClient` / `Sandbox`**: SDK classes that expose `getSandbox`, `exec`, `execStream`, `destroy`, matching the Cloudflare Sandbox shape.

### Data flow

1. Client calls SDK method.
2. SDK hits daemon REST endpoint.
3. Daemon looks up sandbox in `SandboxStore`.
4. Daemon invokes `Driver.exec` (container unix-socket agent or microVM vsock agent).
5. Output streams back as SSE and is parsed by the SDK into `ExecEvent`s.

### External integrations

- Docker Engine API via `dockerode`.
- OCI images from Docker Hub by default; custom base image in `images/base/`.

### State management

- Daemon state is currently in-memory only and is lost on restart.
- Per-sandbox metadata: `id`, `image`, `status`, `createdAt`, `labels`.

---

*Last updated: 2026-06-15*
