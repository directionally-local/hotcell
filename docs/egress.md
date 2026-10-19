# Egress control plane ⭐

[← back to README](../README.md)

A single chokepoint that every outbound byte from a sandbox flows through. This is hotcell's answer to the two things that bite when you run *agents* and not just containers: **credentials** (a real key in the sandbox is one prompt injection away from being stolen) and **blast radius** (a runaway agent spending unboundedly or phoning data out anywhere).

**The real key never enters the sandbox.** Give the daemon your provider keys; each sandbox gets a per-sandbox **token** instead. It points its LLM SDK at the gateway, the daemon swaps the token for the real key on the way out, forwards the call, and meters it. Leak the token and it's worthless — revoke that one, and the real key (plus every other sandbox) is untouched.

```bash
# keys live on the host, never in a sandbox:
hotcell keys add openrouter          # (or export HOTCELL_PROVIDER_KEY_OPENROUTER=sk-or-… for CI)
hotcell start

# auto-wire a sandbox: OPENROUTER_BASE_URL + OPENROUTER_API_KEY (a token) are injected for you
hotcell run --egress --keep "printenv OPENROUTER_BASE_URL"   # -> http://host.docker.internal:4752/openrouter
```

## Importing a whole .env

```bash
hotcell keys import .env      # review screen: set every variable, then confirm
hotcell keys review           # change those decisions later
```

Each variable gets one of three dispositions, chosen by you:

| | what the sandbox gets |
| --- | --- |
| `gateway` | `<PROVIDER>_BASE_URL` → the gateway, `<PROVIDER>_API_KEY` → a per-sandbox token. The real key stays on the host. |
| `inject` | the real value, verbatim — for credentials the gateway cannot stand in front of, and for plain config like `NODE_ENV`. |
| `skip` | nothing. |

hotcell classifies nothing. The only preselection is for env-var names the daemon already routes (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `GITHUB_API_KEY`) — a lookup of existing routes, not a guess — and even those are preselected, never locked. Choosing `gateway` for an unknown provider asks for its base URL and auth header once; that shape is saved to `.hotcell/env.json`, which holds **no secret values** and is meant to be committed, so a teammate's clone inherits every decision and re-enters only the secrets themselves.

The base-URL prompt is also the routability test: `postgres://…` is rejected because the gateway substitutes a credential in a request header and Postgres carries its password inside the protocol handshake. See [what the gateway can and can't protect](../README.md#what-the-gateway-can-and-cant-protect).

Scripted use states each decision explicitly — there is no implicit default, because the convenient one silently copies secrets into sandboxes:

```bash
hotcell keys import .env --set OPENAI_API_KEY=gateway --set DATABASE_URL=inject \
                         --set NODE_ENV=inject --set SENTRY_DSN=skip
hotcell keys import .env --default-unknown=skip        # or name a blanket default
```

## Per-token policy

Mint a token scoped to exactly what one agent should be able to do:

```bash
hotcell egress <id> --spend-cap 5 --models 'gpt-4o,claude-3-5*' --rate-calls 60 --rate-window 1m --ttl 24h
```

- `--spend-cap <usd>` — hard ceiling; the gateway returns **402** once this token's cost reaches it.
- `--models <csv>` — model allowlist (prefix globs ok); a disallowed model → **403**.
- `--providers <csv>` — restrict which providers this token may use → **403**.
- `--rate-calls` / `--rate-tokens` / `--rate-window` — sliding-window rate limit → **429**.
- `--ttl <dur>` — expiry (e.g. `30m`, `24h`); after that the token → **403**.

## Per-sandbox spend ceiling

A hard cap across *all* of a sandbox's tokens, so even an abused-but-not-yet-revoked token can't exceed it:

```bash
hotcell run --egress --egress-spend-cap 2 "..."     # this sandbox can never spend > $2 on LLMs
```

## Real cost, every provider

OpenRouter reports USD inline; for OpenAI / Anthropic / Google the gateway computes it from a built-in model price table (override with `HOTCELL_MODEL_PRICES`). Per-sandbox LLM cost shows up in `hotcell stats`, the metrics API, and the dashboard, folded into the `$` total.

## Any provider, no code

Built-ins: `openai`, `anthropic`, `openrouter`, `google`/`gemini`. Add your own — a Cloudflare AI Gateway, Azure OpenAI, a self-hosted endpoint — via env:

```bash
export HOTCELL_PROVIDER_CFOPENAI_BASEURL="https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/openai"
export HOTCELL_PROVIDER_CFOPENAI_AUTHHEADER=authorization
export HOTCELL_PROVIDER_CFOPENAI_FORMAT="Bearer {key}"
export HOTCELL_PROVIDER_KEY_CFOPENAI=sk-...
# sandboxes now reach it at http://<egress>/cfopenai/...
```

## GitHub through the gateway (keyless git + PRs)

Your GitHub token gets the same treatment as an LLM key — it stays on the host, and sandboxes reach GitHub with only their per-sandbox egress token:

```bash
hotcell keys add github --value "$(gh auth token)"   # once, on the host — never typed, never inside
```

- **API** (`gh`-style calls, PRs): `$GITHUB_BASE_URL/…` with `Authorization: Bearer $GITHUB_API_KEY` — the gateway swaps in your real token at api.github.com.
- **git clone / fetch / push — automatic**: create a sandbox with `--egress` and a GitHub `--repo` while a `github` key is registered, and the daemon wires the clone's `origin` through the gateway for you — `git push` works keylessly out of the box. (Manual form, for any other remote: `http://x-access-token:$GITHUB_API_KEY@<gateway>/github-git/<owner>/<repo>.git`.)
- [`examples/agents.sh`](../examples/agents.sh) wires all of this for you: N sandboxes on one repo, Autopilot installed, git remote through the gateway, and a `pr` helper that pushes the branch + opens a PR without a token in the sandbox.

## Default-deny egress (Linux)

With `HOTCELL_EGRESS_ENFORCE=true`, a sandbox can reach *only* the gateway and a DNS resolver — everything else is dropped at the host firewall (`DOCKER-USER` iptables on a dedicated bridge). The gateway forwards non-LLM traffic (pip / npm / git / apt) to an **allowlist of hosts** — package registries + source forges by default, filtered by domain/SNI not IP — and denies the rest, logging every denial. So a prompt injection has nowhere to phone home, and `git push`-style exfil to a random host is blocked. Direct calls to LLM providers are denied too, so traffic can't skip key injection.

```bash
# needs the daemon to hold CAP_NET_ADMIN (see docs/self-hosting.md)
HOTCELL_EGRESS_ENFORCE=true hotcell start
```

> On **macOS Docker Desktop** the firewall can't be installed (the bridge lives in a VM), so enforcement is **advisory** there — the gateway still works, but a process could route around it. Kernel-enforced lockdown on a Mac is the **Apple VZ microVM driver** (shipped) — its guests have **no NIC by default**, so egress is denied by construction and only reaches the gateway over vsock. (A NAT NIC is opt-in for trusted workloads; on that path the allowlist is advisory — proxy-based — not enforced.) The gateway, policy, caps, cost, providers, and allowlist all work on macOS today.

**Egress enforcement, by tier** — pick what matches your isolation needs:

| Config | Enforcement | Mechanism |
| --- | --- | --- |
| Container + `HOTCELL_EGRESS_ENFORCE` (Linux) | **Kernel-enforced** | host `DOCKER-USER` iptables, default-drop, on a dedicated bridge (needs `CAP_NET_ADMIN`; degrades to advisory if the daemon can't install rules) |
| microVM, no NIC (default) | **Enforced by construction** | no network device exists; the vsock gateway is the only route out |
| microVM, opt-in NAT NIC (`networked: true`) | **Advisory** | proxy env points tools at the gateway; a raw socket bypasses it, unlogged |
| Container on macOS (Docker Desktop) | **Advisory** | host firewall can't be installed (bridge lives in a VM); proxy env still set |

It's an LLM gateway (base-URL rewrite + key injection), not a TLS-MITM proxy — no CA to install in any sandbox. Exposed through REST (`POST/GET /sandboxes/:id/egress-tokens`, `DELETE …/:token`), both SDKs, and the CLI; `npm run check:egress` verifies the whole surface (policy, cost, providers, allowlist, fail-closed) with no Docker required.
