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

- `--spend-cap <usd>` — hard ceiling; the gateway returns **402** for any call whose worst-case cost no longer fits under it ([how](#how-spend-caps-are-enforced)).
- `--models <csv>` — model allowlist (prefix globs ok); a disallowed model → **403**.
- `--providers <csv>` — restrict which providers this token may use → **403**.
- `--rate-calls` / `--rate-tokens` / `--rate-window` — sliding-window rate limit → **429**.
- `--ttl <dur>` — expiry (e.g. `30m`, `24h`); after that the token → **403**.

## Per-sandbox spend ceiling

A hard cap across *all* of a sandbox's tokens, so even an abused-but-not-yet-revoked token can't exceed it:

```bash
hotcell run --egress --egress-spend-cap 2 "..."     # this sandbox can never spend > $2 on LLMs
```

## How spend caps are enforced

A cap is checked *before* a call is forwarded, against the call's **worst-case cost**, not just against what earlier calls already spent — so neither one huge call nor a burst of concurrent ones can run past it. When a token cap or a sandbox cap applies:

- **Every call reserves its worst case up front.** Worst case = *request-body bytes* as input tokens (a token is at least one byte of text, so this bounds a text prompt) + the call's *output limit*, times the number of completions asked for (`n`, `best_of`, `candidateCount`), at the model's price. The call is admitted only if *spent + in-flight reservations + this reservation* stays within each cap; otherwise **402**, and the call never reaches the provider. Check and reservation happen atomically, and when the call finishes (or fails) the reservation is replaced by its actual cost.
- **The output limit is always bounded.** An explicit `max_tokens` / `max_completion_tokens` (OpenAI chat), `max_output_tokens` (Responses), `max_tokens` (Anthropic) or `generationConfig.maxOutputTokens` (Gemini) above **128,000** is clamped to 128,000; a missing (or `null`) one is set to `HOTCELL_EGRESS_MAX_OUTPUT_TOKENS` (default **8192**) in the forwarded body. On routes the gateway doesn't recognise, nothing is rewritten and 128,000 output tokens are reserved. Embeddings reserve input only; token-counting routes are free.
- **Unpriced models are refused (403).** A model with no entry in the price table (exact or prefix match, after dropping a `vendor/` prefix) can't be bounded, so it can't run under a cap — add it to `HOTCELL_MODEL_PRICES`. Without a cap it still runs, metered as $0 with a warning.
- **Usage is never silently free.** OpenAI chat streams get `stream_options.include_usage: true` so they report usage (the client sees one extra, choice-less final chunk). A successful response whose usage still can't be read — or a stream that dies midway — is charged its full reservation. Error responses with no usage cost nothing, since providers don't bill them.
- **Gemini native routes** (`/google/v1beta/models/<model>:generateContent`) are priced and checked against `--models` by the model in the URL path, and metered from `usageMetadata`, with thinking tokens counted as output.

Without a cap, nothing above changes the request: it's forwarded byte-for-byte and only metered. One exception: `--models` also checks a Gemini path model, cap or no cap.

Limits: the bound covers what's *in* the request. Content the provider pulls in by reference costs more than its bytes suggest: an image URL, a Gemini `fileData` URI, an OpenAI `previous_response_id`, or a stored prompt. That content is billed at its real usage after the call, and the call's reservation doesn't cover it. Async jobs (Batch, fine-tuning, Assistants runs) aren't metered at all. A price-table prefix match can underprice a pricier variant, such as `o3` matching `o3-pro`, and long-context price tiers aren't modelled. Reservations live in the daemon's memory. To cap these, combine the cap with `--models` / `--providers`.

## Real cost, every provider

OpenRouter reports USD inline; for OpenAI / Anthropic / Google the gateway computes it from the token usage each response reports (including Anthropic cache tokens and Gemini's `usageMetadata`) and a built-in model price table (override with `HOTCELL_MODEL_PRICES`). Per-sandbox LLM cost shows up in `hotcell stats`, the metrics API, and the dashboard, folded into the `$` total.

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

> On **macOS Docker Desktop** the firewall can't be installed (the bridge lives in a VM), so enforcement is **advisory** there — the gateway still works, but a process could route around it. Kernel-enforced lockdown on a Mac is the **Apple VZ microVM driver** (shipped) — its guests have **no NIC by default**, so egress is denied by construction and only reaches the gateway over vsock. (A NAT NIC is opt-in for trusted workloads on the **Firecracker** driver only — Apple VZ guests have no NIC and ignore `networked`; on the Firecracker path the allowlist is advisory — proxy-based — not enforced.) The gateway, policy, caps, cost, providers, and allowlist all work on macOS today.

**Egress enforcement, by tier** — pick what matches your isolation needs:

| Config | Enforcement | Mechanism |
| --- | --- | --- |
| Container + `HOTCELL_EGRESS_ENFORCE` (Linux) | **Kernel-enforced** | host `DOCKER-USER` iptables, default-drop, on a dedicated bridge (needs `CAP_NET_ADMIN`; degrades to advisory if the daemon can't install rules) |
| microVM, no NIC (default) | **Enforced by construction** | no network device exists; the vsock gateway is the only route out |
| microVM, opt-in NAT NIC (`networked: true`, Firecracker only) | **Advisory** | proxy env points tools at the gateway; a raw socket bypasses it, unlogged |
| Container on macOS (Docker Desktop) | **Advisory** | host firewall can't be installed (bridge lives in a VM); proxy env still set |

**`networked: true` is a trusted mode.** It gives a Firecracker guest a real NAT'd NIC, so code in it can open raw sockets to any internet host, and to anything else routable from the host's default-route interface (your LAN / VPC). Use it only for workloads you would run on the host anyway. The driver does fence off the worst targets with per-TAP host firewall rules: the guest can't reach host-local services (all input from its TAP is dropped, including via the TAP gateway IP), can't reach the cloud instance-metadata service (`169.254.0.0/16` is dropped, and IPv6 is disabled on the TAP), and can't be routed into other sandboxes' TAPs or local bridges. Teardown removes every rule it added.

It's an LLM gateway (base-URL rewrite + key injection), not a TLS-MITM proxy — no CA to install in any sandbox. Exposed through REST (`POST/GET /sandboxes/:id/egress-tokens`, `DELETE …/:token`), both SDKs, and the CLI; `npm run check:egress` verifies the whole surface (policy, cost, providers, allowlist, fail-closed) with no Docker required.
