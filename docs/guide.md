# Guide

[← back to README](../README.md)

The [README quick start](../README.md#quick-start-60-seconds) gets you running in three commands. This is the fuller tour: preinstalling packages, cloning repos, running agents, the SDKs, and everything a sandbox gives you.

## Pre-installing packages / custom setup

An empty sandbox is rarely what you want. The simplest way to arrive with your tools already installed is the declarative **`--setup`** flag — shell commands run once, in order, right after the sandbox starts:

```bash
hotcell create --setup "npm i -g some-cli && pip install ruff pandas"
hotcell run    --setup "pip install ruff" "ruff check ."
```

```ts
// SDK: pass an ordered array (each entry runs in sequence)
await client.getSandbox(undefined, { setup: ["npm i some-cli", "pip install ruff"] });
```

Setup is **best-effort** (a non-zero exit is logged, not fatal) and runs once at create — with persistence (the default) the installed deps live in the workspace volume and survive idle-pause/resume, so you don't reinstall every time. Other approaches:

1. **Bake a custom image** — extend `images/base/Dockerfile`, then `HOTCELL_IMAGE=my/hotcell:latest`. Fastest cold-start; daemon-wide.
2. **Run setup after create** — `id=$(hotcell create) && hotcell exec "$id" "npm i some-cli"`.
3. **Backup/restore templating** — provision once, `hotcell backup`, then `hotcell restore` into fresh sandboxes.

> Under default-deny egress, `--setup`/install steps reach package registries through the gateway (pypi, npm, crates, go, rubygems, maven, packagist, apt/apk are allowlisted by default). Add private registries with `HOTCELL_ALLOWLIST_EXTRA`.

## Clone a repo in

`--repo` (with optional `--ref`) clones a git repo into `/workspace` at create — great for pointing an agent at a codebase:

```bash
hotcell create --repo https://github.com/me/app --ref main --setup "npm install"
```

## Run AI agents on hotcell

hotcell is built to *run agents*, not just containers — a sandbox can come up with a **repo cloned in** (`--repo`), **LLM access wired without keys inside** (`--egress`), **per-token + per-sandbox spend caps**, **resource caps**, and **per-agent cost/observability**.

- **Mastra (first-class):** [`@hotcell/mastra`](../packages/mastra) is a Mastra `Workspace` sandbox provider — drop `HotcellSandbox` in where you'd use `E2BSandbox`/`ModalSandbox` and your agent runs on your own hardware.
- **CLI harnesses:** create Autopilot-ready sandboxes with `hotcell create --autopilot` (it installs `autopilot-ai`, configures the gateway, and implies `--egress`); OpenCode, Codex, Claude Code, pi.dev, and other agents remain usable too. For a headless one-shot OpenCode example, see [`examples/opencode.sh <repo> "<task>"`](../examples/opencode.sh).

```ts
import { Agent, Workspace } from "@mastra/core";
import { HotcellSandbox } from "@hotcell/mastra";

const agent = new Agent({
  name: "coder", model: "openai/gpt-5",
  workspace: new Workspace({ sandbox: new HotcellSandbox({ repo: "https://github.com/me/app" }) }),
});
await agent.generate("Add a /health route and run the tests.");
```

See [`examples/`](../examples) for runnable agent examples + harness recipes.

## SDKs

### TypeScript (`@hotcell/sdk`, zero runtime deps)

```ts
import { HotcellClient } from "@hotcell/sdk";

const client = new HotcellClient({ endpoint: "http://127.0.0.1:4750" /*, apiKey */ });

// egress wired + scoped in one call: token holds the policy, sandbox has a hard ceiling
const sandbox = await client.getSandbox(undefined, {
  egress: { spendCapUsd: 5, models: ["gpt-4o"], ttlMs: 24 * 3600_000 },
  egressSpendCapUsd: 10,
});
const { stdout } = await sandbox.exec("python3 -c 'print(2+2)'");
await sandbox.writeFile("/workspace/hi.txt", "hello");
await sandbox.destroy();
```

### Python (`hotcell` on PyPI, stdlib-only)

```python
# pip install hotcell
from hotcell import HotcellClient

sandbox = HotcellClient().get_sandbox()      # honors HOTCELL_ENDPOINT / HOTCELL_API_KEY
print(sandbox.exec("python3 -c 'print(2+2)'").stdout)   # "4\n"
sandbox.destroy()
```

## Everything a sandbox gives you

- **Sandboxes** — create / list / stop / start / destroy; `/workspace` on a named volume that survives stop/start and daemon restarts.
- **Exec** — streamed stdout/stderr (SSE), env vars, and persistent **sessions** (a `cd` sticks across commands).
- **Files** — write / read / mkdir / list, plus recursive **watch** (created/modified/deleted).
- **Processes** — detached background processes (list / signal / stream logs) and **wait-for-port**.
- **Preview URLs** — expose a container port at `http://<id>-<port>.localhost:4751/` via an L4 proxy that works even where container IPs aren't reachable (macOS Docker Desktop).
- **Code interpreter** — stateful Python/JavaScript contexts (variables + imports persist across `run-code`).
- **Backups** — snapshot/restore `/workspace` to durable host tarballs (portable across sandboxes).
- **Lifecycle** — idle sandboxes auto-pause after `sleepAfter`; the next operation auto-resumes them (workspace intact). They never self-destroy; destroy is explicit and revokes the sandbox's egress tokens.
- **Resource limits** — hard per-sandbox **memory / CPU / PID** caps (cgroups), per create or as daemon-wide defaults, so one sandbox can't starve the rest.
- **Capacity + admission** — tracks committed memory vs the host budget (auto-detected) and **refuses to over-subscribe** (`create` → 503 when full). Usage-based: idle agents pack densely, busy ones reserve what they use.
- **Metrics + cost** — per-sandbox CPU/mem/net/pids, integrated usage, and a configurable `$` cost meter (LLM cost folded in), with history sparklines in the dashboard.
- **Observability** — structured JSON/pretty logs and OpenTelemetry traces (one span per request; optional OTLP/HTTP export, or `GET /traces`).
- **Live terminal** — a real interactive shell (xterm.js) per sandbox in the dashboard, or `hotcell terminal <id>`.
- **Auth** — optional API key (`HOTCELL_API_KEY`) on the REST API, honored by both SDKs, the CLI, and the dashboard.

## Web dashboard

Open <http://127.0.0.1:4750/> after `hotcell start` — sandbox list, live CPU/mem/net with sparklines, cost meter, preview links, a live terminal, and create/stop/start/destroy.

## From a source checkout

`npm run smoke` exercises the whole surface end-to-end against live Docker; `npm run smoke:py` does the same through the Python SDK; `npm run check:egress` unit-tests the egress control plane (no Docker); `npm run smoke:remote` drives a live remote daemon via the SDK.
