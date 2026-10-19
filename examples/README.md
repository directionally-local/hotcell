# Running AI agents on hotcell

hotcell is built to *run agents*, not just containers: each sandbox can come up with a **repo cloned in** (`--repo`), **LLM access wired without keys inside** (`--egress`), **hard resource caps**, and **per-agent cost/observability**. Two ways to use it:

## 1. Mastra (first-class) — [`@hotcell/mastra`](../packages/mastra)

A Mastra `Workspace` sandbox provider backed by hotcell. Drop `HotcellSandbox` in where you'd use Mastra's `E2BSandbox`/`ModalSandbox`, and your agent runs on your own hardware:

```ts
import { Agent, Workspace } from "@mastra/core";
import { HotcellSandbox } from "@hotcell/mastra";

const agent = new Agent({
  name: "coder",
  model: "openai/gpt-5",
  workspace: new Workspace({
    sandbox: new HotcellSandbox({ repo: "https://github.com/me/app", memoryMb: 2048 }),
  }),
});
await agent.generate("Add a /health route and run the tests.");
```

See [`mastra-agent/`](./mastra-agent) for a runnable example.

## 2. Autopilot (first-class CLI integration)

Create a sandbox with Autopilot installed and connected to hotcell’s OpenRouter gateway, then attach an interactive terminal:

```bash
hotcell keys add openrouter
hotcell create --autopilot --repo https://github.com/you/app --branch auto
hotcell terminal <id>      # inside: cd app && autopilot
```

`--autopilot` implies `--egress`. It installs the `autopilot-ai` npm package (which provides the `autopilot` command) and configures Autopilot’s custom endpoint with the sandbox’s revocable gateway token. Its config lives on the persistent workspace disk, including on Apple VZ. **Do not install `npm i -g autopilot`**: that npm package is an unrelated cryptocurrency CLI.

## 3. OpenCode (one-command headless runner)

Launch a sandbox, clone a repo, run a headless [OpenCode](https://opencode.ai) task through [OpenRouter](https://openrouter.ai), and destroy the sandbox when done — your real key never enters the sandbox (it's swapped in by the egress gateway):

```bash
# 1. start the daemon with your OpenRouter key (the key lives only here):
HOTCELL_PROVIDER_KEY_OPENROUTER=sk-or-... node packages/daemon/dist/index.js
# 2. build the base image once (gives the sandbox node + git):
docker build -t hotcell/base:latest images/base
# 3. one command — create → clone → run OpenCode → destroy:
examples/opencode.sh https://github.com/you/app "add a /health route and run the tests"
```

You get a clean run: a spinner with a **live token/$ ticker**, then the agent's answer, then a one-line summary — nothing else:

```
⠋ app · agent working · editing files · 12.4k tokens · $0.01
Added a /health route in src/server.js and a test in test/health.test.js. Tests pass.

✓ app · done in 41s · 18.2k tokens · $0.02 · 2 files changed, 23 insertions(+)
```

Flags: `[model]` (3rd arg, default `openrouter/moonshotai/kimi-k2.7-code`), `--keep` (don't destroy; print `hotcell terminal`/`hotcell rm` hints), `--verbose` (show the raw OpenCode stream). The answer goes to **stdout** and all chrome to **stderr**, so `examples/opencode.sh … > out.md` captures just the answer.

The launcher is a thin shim over [`examples/agent.mjs`](./agent.mjs), which drives the sandbox via `@hotcell/sdk`. Under the hood: `--egress` injects `OPENROUTER_BASE_URL` (→ the gateway) + a per-sandbox `OPENROUTER_API_KEY` **token**; the OpenCode config points OpenRouter at that base URL; the daemon swaps the token for your real key, forwards, and meters tokens + $ (which the runner reads live from the egress meter).

> Verified: `opencode-ai` installs + runs headless in the sandbox and the egress key-injection/forwarding is covered by `npm run smoke`; the runner's output filter + chrome are tested offline. The model call needs *your* OpenRouter key — run it with step 1 above. (`HOTCELL_AGENT_CMD="<cmd>"` runs any other harness instead of OpenCode.)

### Other harnesses (same shape)

Swap the `--setup` install + run command — same `--repo`/`--egress` flow:

| Harness | install (`--setup`) | run command |
|---|---|---|
| **Codex CLI** | `npm i -g @openai/codex` | `codex exec '<task>'` |
| **Claude Code** | `npm i -g @anthropic-ai/claude-code` | `claude -p '<task>'` |
| **pi.dev** | (per its install) | `pi '<task>'` |

The egress gateway also injects `OPENAI_*` / `ANTHROPIC_*` when those provider keys are set on the daemon. Exact headless flags differ per tool — check each CLI's `--help`.

## What you get that raw Docker doesn't
- LLM reachable from the sandbox **without keys inside it** (egress gateway), with **per-agent token + $ metering**.
- **Repo cloned in** + **git** at create; persistent `/workspace`; idle auto-pause.
- **Hard CPU/mem/PID caps** so 100 parallel agents can't starve each other.
- **Preview URLs**, a **live terminal**, and a **dashboard** to watch agents run.
