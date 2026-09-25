# CLI & configuration reference

[← back to README](../README.md)

## CLI

```
# the daemon (the background process that runs your sandboxes)
hotcell start [--foreground] [--defaults]    # start it in the background; returns your terminal.
                                             # very first start on a TTY shows the defaults once
                                             # (⏎ accept · c configure); --defaults skips that
hotcell setup                                # guided daemon config → ~/.hotcell/config.json
hotcell status                               # is it running? on what port? how much headroom?
hotcell stop                                 # stop it (logs: ~/.hotcell/daemon.log)

# bare `hotcell` (no command, in a terminal) = interactive menu; first run = setup.
# non-TTY (pipes/scripts/agents) always gets --help instead — nothing ever prompts.

# provider keys (kept on the host — macOS keychain, else chmod-600 ~/.hotcell/keys.json)
hotcell keys add <provider> [--value KEY | --stdin]   # any provider; asks its base URL once if new
hotcell keys ls | rm <provider>
hotcell keys import [.env] [--set NAME=gateway|inject|skip] [--default-unknown gateway|inject|skip]
hotcell keys review                                   # re-open those decisions later

# sandboxes
hotcell run "<cmd>" [--image I] [--keep] [--env K=V,…] [--sleep-after MS] [--egress] [--egress-spend-cap USD]
               [--memory MB] [--cpus N] [--pids N] [--repo URL] [--ref BRANCH] [--setup "cmd"]
hotcell create [-i] [-n N] [--name HANDLE] [--image I] [--driver container|firecracker|applevz] [--env K=V,…] [--egress]
               [--egress-spend-cap USD] [--memory MB] [--cpus N] [--pids N] [--repo URL] [--ref BRANCH] [--branch NAME] [--setup "cmd"]
               [--autopilot] [--opencode]     # prints id; --autopilot installs autopilot-ai (command: autopilot), implies --egress
                                             # --opencode remains a supported alternative; both need OpenRouter + Node/npm
                                             # shows live per-sandbox progress; Ctrl-C leaves provisioning running (see hotcell ls)
hotcell exec <id> "<cmd>" [--session SID] [--cwd DIR] [--env K=V,…]
hotcell ls | stats <id> | stop <id> | start <id> | rm <id> | capacity | info
hotcell terminal <id>                        # interactive shell inside a sandbox (attach)
hotcell tui   (alias: top)                   # full-screen fleet monitor: arrow-key nav,
                                             # live cpu/mem/cost, ⏎ attach, p/r/d, c create
hotcell pause <id> | resume <id>             # fast pause / resume (memory snapshot on microVMs)

# files, processes, ports, sessions, env
hotcell files <write|read|mkdir|list> …
hotcell watch <id> [path]                    # stream file changes
hotcell start <id> "<cmd>" | ps <id> | kill <id> <procId> | logs <id> <procId>
hotcell wait-port <id> <port> | expose <id> <port>
hotcell session create|ls|rm <id> …          # persistent cwd+env
hotcell env <id> [K=V …]                     # sandbox env
hotcell run-code <id> "<code>" [--lang python|javascript]
hotcell backup <id> | restore <id> <backupId> | backups [<id>]

# egress: mint a token, optionally scoped by policy; list / revoke
hotcell egress <id> [--list] [--revoke TOKEN]
               [--ttl DUR] [--spend-cap USD] [--models CSV] [--providers CSV]
               [--rate-calls N] [--rate-tokens N] [--rate-window DUR]

Global: --endpoint <url> (HOTCELL_ENDPOINT) · --api-key <key> (HOTCELL_API_KEY)
```

> `hotcell start` with no arguments starts the daemon. `hotcell start <id>` resumes a stopped sandbox, and `hotcell start <id> "<cmd>"` launches a background process inside one — the arity disambiguates. `hotcell stop` with no arguments stops the daemon; `hotcell stop <id>` stops a sandbox.

## Configuration (daemon env + config file)

Set these before `hotcell start` (they're inherited by the daemon) or on `hotcelld` directly. The same keys can be **persisted** in `${HOTCELL_HOME:-~/.hotcell}/config.json` — written by `hotcell setup`, or by hand as env-style keys with string values, e.g. `{"HOTCELL_HOST":"0.0.0.0","HOTCELL_EGRESS_ENFORCE":"true"}`. Precedence, highest first: **`HOTCELL_*` env → legacy `SBX_*` env → config file → built-in defaults** (a malformed file is warned about and ignored). The CLI also reads `HOTCELL_API_KEY`/`HOTCELL_PORT` from the file, so an auth-enabled daemon keeps working without re-exporting env.

| Var | Default | What |
|---|---|---|
| `HOTCELL_HOST` / `HOTCELL_PORT` | `127.0.0.1` / `4750` | REST API bind |
| `HOTCELL_DRIVER` | `container` | Default runtime driver — all three ship live: `container` (Docker, Linux + macOS), `firecracker` (Linux + KVM), `applevz` (macOS). Also selectable **per sandbox** at create time (`driver: …`), so one daemon mixes containers and microVMs |
| `HOTCELL_IMAGE` | `ghcr.io/sinameraji/hotcell-base` | Default sandbox image (python + node + git + build tools) |
| `HOTCELL_DEFAULT_MEMORY_MB` / `HOTCELL_DEFAULT_CPUS` / `HOTCELL_DEFAULT_PIDS` | `0` (unlimited) | Default per-sandbox hard caps (RAM MiB / fractional cores / process count) |
| `HOTCELL_ADMISSION` | `enforce` | Reject `create` when the host memory budget is exhausted (`off` to only report) |
| `HOTCELL_HOST_MEMORY_MB` / `HOTCELL_HOST_CPUS` | auto-detect | Host capacity budget for admission (defaults to the Docker host's MemTotal/NCPU) |
| `HOTCELL_OVERCOMMIT` / `HOTCELL_DEFAULT_RESERVATION_MB` | `1` / `256` | Memory overcommit factor / admission floor for an uncapped, not-yet-sampled sandbox |
| `HOTCELL_PROXY_PORT` | `4751` | Preview-URL proxy |
| **Egress control plane** | | |
| `HOTCELL_EGRESS_PORT` | `4752` | Egress gateway (`0` disables) |
| `HOTCELL_KEYSTORE` | `keychain` | Force the key backend to `file` (`$HOTCELL_HOME/keys.json`). The macOS keychain is global to the login session and ignores `HOTCELL_HOME`, so isolated/test installs need this to avoid touching real entries |
| `HOTCELL_PROVIDER_KEY_*` | — | Provider keys (`_OPENAI`, `_ANTHROPIC`, `_OPENROUTER`, `_GOOGLE`, or any custom name). `hotcell keys add` is the friendly equivalent |
| `HOTCELL_PROVIDER_<NAME>_BASEURL` / `_AUTHHEADER` / `_FORMAT` | — | Define a custom provider (e.g. a Cloudflare AI Gateway); pair with `HOTCELL_PROVIDER_KEY_<NAME>` |
| `HOTCELL_MODEL_PRICES` | built-in | JSON file overriding the model price table (used to compute cost when a provider doesn't report it) |
| `HOTCELL_EGRESS_SPEND_CAP` | `0` | Default per-sandbox LLM spend ceiling in USD (`0` = unlimited; per-create `egressSpendCapUsd` overrides) |
| `HOTCELL_EGRESS_ENFORCE` | `false` | **Default-deny egress** (Linux): lock sandboxes to the gateway + DNS via host iptables. Needs `CAP_NET_ADMIN`. Advisory on macOS |
| `HOTCELL_EGRESS_NETWORK` / `HOTCELL_EGRESS_SUBNET` | `hotcell-egress` / `10.200.0.0/24` | Bridge name / subnet for enforced egress |
| `HOTCELL_EGRESS_DNS` | embedded | Pinned DNS resolver IP under enforcement (blocks DNS exfil; DoH is denied by the allowlist) |
| `HOTCELL_ALLOWLIST_FILE` / `HOTCELL_ALLOWLIST_EXTRA` / `HOTCELL_ALLOW_SOURCE_CONTROL` | defaults / — / `true` | Forward-proxy host allowlist: full override file / extra hosts / include the git-forge tier |
| `HOTCELL_EGRESS_HOST` / `HOTCELL_EGRESS_ADVERTISE_HOST` | `127.0.0.1` / `host.docker.internal` | Gateway bind address / host advertised in egress base URLs |
| **Other** | | |
| `HOTCELL_DB` | `~/.hotcell/state.db` | SQLite state (`:memory:` = ephemeral) |
| `HOTCELL_BACKUP_DIR` | `~/.hotcell/backups` | Backup tarballs |
| `HOTCELL_SLEEP_AFTER_MS` | `0` | Default idle auto-pause (`0` = off) |
| `HOTCELL_METRICS_INTERVAL_MS` / `HOTCELL_METRICS_HISTORY` | `10000` / `60` | Sampler cadence / sparkline ring |
| `HOTCELL_COST_CPU_PER_HOUR` / `_MEM_GB_PER_HOUR` / `_EGRESS_PER_GB` | `0.05` / `0.005` / `0.01` | Cost-meter rates |
| `HOTCELL_API_KEY` | — | Require this key on the REST API (empty = open, loopback) |
| `HOTCELL_ALLOWED_HOSTS` | — | Extra `Host` values accepted by the API (DNS-rebinding guard; loopback always allowed) |
| `HOTCELL_MAX_BODY_BYTES` | `33554432` | Max request body size before 413 (REST + egress) |
| `HOTCELL_LOG_LEVEL` / `HOTCELL_LOG_FORMAT` | `info` / `pretty` | Logging (`json` for ingestion) |
| `HOTCELL_OTLP_ENDPOINT` | — | OTLP/HTTP traces export (e.g. `http://localhost:4318`) |

SDK/CLI endpoint: `HOTCELL_ENDPOINT` (default `http://127.0.0.1:4750`).
