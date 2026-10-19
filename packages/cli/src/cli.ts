import { runCommand } from "./run.js";
import { createCommand } from "./create.js";
import { listCommand } from "./list.js";
import { removeCommand } from "./remove.js";
import { filesCommand } from "./files.js";
import { startCommand, psCommand, killCommand } from "./proc.js";
import { pauseCommand, stopCommand, startSandboxCommand } from "./lifecycle.js";
import { backupCommand, restoreCommand, backupsCommand } from "./backup.js";
import { runCodeCommand } from "./code.js";
import { watchCommand } from "./watch.js";
import { logsCommand } from "./logs.js";
import { waitPortCommand, exposeCommand } from "./ports.js";
import { execCommand } from "./exec.js";
import { envCommand } from "./env.js";
import { sessionCommand } from "./session.js";
import { statsCommand } from "./stats.js";
import { infoCommand } from "./info.js";
import { capacityCommand } from "./capacity.js";
import { egressCommand } from "./egress.js";
import { terminalCommand } from "./terminal.js";
import { tuiCommand } from "./tui.js";
import { startEngine, stopEngine, engineStatus } from "./engine.js";
import { keysCommand } from "./keys.js";
import { imagesCommand } from "./images.js";
import { versionCommand } from "./version.js";
import { defaultEndpoint, resolveSetting } from "./configfile.js";
import { menuCommand } from "./menu.js";
import { setupCommand } from "./setup.js";
import { createWizard } from "./wizard.js";

export interface GlobalArgs {
  endpoint?: string;
  /** API key for an auth-enabled daemon. Falls back to HOTCELL_API_KEY (legacy SBX_API_KEY still read). */
  apiKey?: string;
}

export async function cli(args: string[]): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return 0;
  }

  if (args[0] === "--version" || args[0] === "-v" || args[0] === "version") {
    // Same endpoint/key resolution as every other command (env > file), or the
    // drift check itself drifts when config.json moves the port.
    return versionCommand({
      endpoint: defaultEndpoint(),
      apiKey: process.env.HOTCELL_API_KEY ?? process.env.SBX_API_KEY ?? resolveSetting("API_KEY"),
    });
  }

  // Bare `hotcell` (no command) is the human front door: first run → setup
  // wizard; otherwise the home menu (fleet view one Enter away). Non-TTY (pipes,
  // scripts, agents) falls back to help so automation is never surprised.
  if (args.length === 0) {
    const globals: GlobalArgs = {
      endpoint: defaultEndpoint(),
      apiKey: process.env.HOTCELL_API_KEY ?? process.env.SBX_API_KEY ?? resolveSetting("API_KEY"),
    };
    if (process.stdout.isTTY && process.stdin.isTTY) return menuCommand(globals);
    printHelp();
    return 0;
  }

  const [command, ...rest] = args;
  const { flags, positional } = parseFlags(rest);
  const globals: GlobalArgs = {
    endpoint: (flags.endpoint as string | undefined) ?? defaultEndpoint(),
    apiKey:
      (flags["api-key"] as string | undefined) ??
      process.env.HOTCELL_API_KEY ??
      process.env.SBX_API_KEY ??
      resolveSetting("API_KEY"),
  };

  switch (command) {
    case "run":
      return runCommand(positional, globals, flags);
    case "create":
      // -i / --interactive: the guided create (TTY); flags stay the agent path.
      if (flags.i === true || flags.interactive === true) return createWizard(globals);
      return createCommand(positional, globals, flags);
    case "setup":
      return setupCommand(globals, flags);
    case "exec":
      return execCommand(positional, globals, flags);
    case "env":
      return envCommand(positional, globals);
    case "session":
      return sessionCommand(positional, globals, flags);
    case "ls":
    case "list":
      return listCommand(globals);
    case "stats":
      return statsCommand(positional, globals);
    case "info":
      return infoCommand(positional, globals);
    case "images":
      return imagesCommand(positional, globals, flags);
    case "capacity":
      return capacityCommand(positional, globals);
    case "egress":
      return egressCommand(positional, globals, flags);
    case "terminal":
      return terminalCommand(positional, globals);
    case "tui":
    case "top":
      return tuiCommand(positional, globals);
    case "rm":
    case "remove":
      return removeCommand(positional, globals, flags);
    case "files":
      return filesCommand(positional, globals, flags);
    case "start":
      // Arity overload: no args starts the background daemon; `hotcell
      // start <id>` resumes a stopped sandbox; `hotcell start <id> "<cmd>"` launches
      // a process inside it.
      if (positional.length === 0) return startEngine(globals, flags);
      return positional.length >= 2
        ? startCommand(positional, globals, flags)
        : startSandboxCommand(positional, globals);
    case "resume":
      // Clear name for resuming a paused/stopped sandbox (pairs with `pause`).
      return startSandboxCommand(positional, globals);
    case "status":
      return engineStatus(globals);
    case "keys":
      return keysCommand(positional, globals, flags);
    case "stop":
      // No args stops the daemon; `hotcell stop <id>` stops a sandbox.
      return positional.length === 0 ? stopEngine(globals) : stopCommand(positional, globals);
    case "pause":
      return pauseCommand(positional, globals);
    case "backup":
      return backupCommand(positional, globals);
    case "restore":
      return restoreCommand(positional, globals);
    case "backups":
      return backupsCommand(positional, globals);
    case "run-code":
      return runCodeCommand(positional, globals, flags);
    case "watch":
      return watchCommand(positional, globals, flags);
    case "ps":
      return psCommand(positional, globals);
    case "kill":
      return killCommand(positional, globals, flags);
    case "logs":
      return logsCommand(positional, globals, flags);
    case "wait-port":
      return waitPortCommand(positional, globals, flags);
    case "expose":
      return exposeCommand(positional, globals, flags);
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      return 1;
  }
}

function printHelp(): void {
  console.log(`hotcell — sandboxes for AI agents, on your own hardware

Usage: hotcell <command> [options]

Daemon (the background process that runs your sandboxes):
  hotcell start [--foreground] [--defaults]
                                 Start it in the background; returns your terminal.
                                 First start on a TTY shows the defaults once
                                 (⏎ accept · c configure); --defaults skips that.
  hotcell setup                  Guided daemon config (access, egress, isolation,
                                 default image) → ~/.hotcell/config.json.
                                 Precedence: env > config file > defaults.
  hotcell status                 Is it running? On what port? How much headroom?
  hotcell stop                   Stop it. (Logs: ~/.hotcell/daemon.log)

Bare \`hotcell\` (no command, in a terminal) opens the interactive menu — first
run opens setup. Pipes/scripts always get this help instead.

Commands:
  hotcell run "<command>" [--image <image>] [--keep] [--sleep-after <ms>] [--egress]
         [--repo <git-url>] [--ref <branch>] [--setup "cmd"]
         [--memory <MB>] [--cpus <n>] [--pids <n>] [--endpoint <url>]
    Create a sandbox, run a command, stream output, then destroy it.
    --egress wires the sandbox to the LLM gateway (provider keys injected by the daemon).
    --memory/--cpus/--pids set hard resource caps (override the daemon defaults).

  hotcell create [-i] [-n <count>] [--name <handle>] [--image I] [--driver container|firecracker|applevz] [--env K=V,…]
            [--sleep-after MS] [--egress] [--label K=V,…]
            [--repo <git-url>] [--ref <branch>] [--branch <name>] [--setup "cmd"] [--autopilot] [--opencode]
            [--memory <MB>] [--cpus <n>] [--pids <n>]
    Provision a standalone persistent sandbox and print its id.
    --autopilot installs autopilot-ai (run the command autopilot) and wires it to the
    LLM gateway (implies --egress; needs an openrouter key and a node-capable image).
    --opencode installs OpenCode as an alternative wired to the same gateway
    (also implies --egress; needs an openrouter key and a node-capable image).
    --branch creates + checks out a new branch after cloning (bare --branch
    auto-names it) — one branch per sandbox = clean parallel PRs.
    -n 5 creates five identical cells in one command (one id per line);
    --name gives a human handle (a NAME column in ls + the fleet; with -n it
    suffixes: feat-1…feat-N); -i opens the guided create instead (TTY only).
    --driver picks the isolation tier per sandbox (microVMs need a VZ/KVM host).
    --repo clones a git repo into /workspace at create (great for agents).
    --setup runs a shell command once after the container starts (best-effort;
    chain with && for multiple steps, e.g. --setup "npm i x && pip install y").

  hotcell keys add <provider> [--value <key>]  ·  keys import [.env]  ·  keys review  ·  keys ls  ·  keys rm <provider>
    Store API keys on the host (macOS keychain, else chmod-600 ~/.hotcell/keys.json)
    — never inside a sandbox. <provider> is any name; openai/anthropic/openrouter/
    google/github route out of the box, and any other provider once you give its
    base URL + auth header (asked once, saved to .hotcell/env.json).
    import reads a .env and asks you to set every variable to one of:
      gateway  key stays here; the sandbox gets a per-sandbox token
      inject   the real value is copied into every sandbox
      skip     never leaves this machine
    hotcell does not guess which is which. review re-opens those decisions later.
    Human: hidden prompt / review screen. Agent: --value/--stdin; for import,
    --set NAME=gateway|inject|skip (repeatable) or --default-unknown=skip|inject.

  hotcell tui   (alias: hotcell top)
    Full-screen fleet monitor + control panel. Arrow-key nav, live CPU/mem/cost,
    ⏎ to attach a shell, p/r/d to pause/resume/destroy, c to create.

  hotcell terminal <id>
    Attach an interactive shell (PTY) to a sandbox in your local terminal.

  hotcell exec <id> "<command>" [--session <sid>] [--cwd <dir>] [--env KEY=VAL,...]
    Run a command in an existing sandbox (optionally within a session).

  hotcell env <id> [KEY=VALUE ...]
    Set sandbox environment variables, or print them when none are given.

  hotcell session create <id> [--cwd <dir>] [--env KEY=VAL,...] [--id <sid>]
  hotcell session ls <id>
  hotcell session rm <id> <sessionId>
    Manage persistent sessions (working directory + env) inside a sandbox.

  hotcell ls [--endpoint <url>]
    List sandboxes managed by the daemon.

  hotcell info
    Show the daemon's driver, providers, auth, and cost configuration.

  hotcell images
    List recommended base images (and what each ships) for --image. Any public
    image works; --json for machine-readable output.

  hotcell capacity
    Show host memory budget, what's committed, and how many more sandboxes fit.

  hotcell stats <id>
    Show live CPU/mem/net usage and accumulated cost for a sandbox.

  hotcell egress <id> [--list] [--revoke <token>]
    Mint an egress (LLM gateway) token so the sandbox reaches providers without
    baked-in keys; prints the provider base URLs + env exports to set.

  hotcell stop <id>
    Stop a sandbox, freeing compute but keeping its persistent workspace.

  hotcell pause <id>
    Fast-pause a sandbox; any later operation resumes it. On microVM sandboxes
    this is a memory snapshot — background processes come back alive.

  hotcell start <id>
    Resume a stopped sandbox (workspace intact).

  hotcell backup <id>
    Snapshot a sandbox's /workspace to a durable backup.

  hotcell restore <id> <backupId>
    Replace a sandbox's /workspace with a backup (taken from any sandbox).

  hotcell backups [<id>]
    List all backups, or just those from one sandbox.

  hotcell run-code <id> "<code>" [--lang python|javascript]
    Run a code snippet in the sandbox's interpreter and print its output.

  hotcell rm <id...> | --all
    Destroy one, several, or every sandbox (incl. persistent workspace volumes).

  hotcell files <subcommand> [args] [--endpoint <url>]
    Manage files inside a sandbox. Run \`hotcell files\` for subcommand help.

  hotcell watch <id> [path] [--interval <ms>]
    Stream file-change events (created/modified/deleted) until Ctrl-C.

  hotcell start <id> "<command>" [--cwd <dir>]
    Launch a long-running background process inside a sandbox.
    (With no command, "hotcell start <id>" resumes a stopped sandbox — see above.)

  hotcell ps <id>
    List background processes in a sandbox.

  hotcell kill <id> <procId> [--signal <SIG>]
    Signal a background process (default SIGTERM).

  hotcell logs <id> <procId> [--follow]
    Stream a background process's logs.

  hotcell wait-port <id> <port> [--timeout <ms>]
    Block until a TCP port is listening inside the sandbox.

  hotcell expose <id> <port> [--token <token>]
    Expose a port and print its preview URL.

Global options:
  --endpoint <url>   Daemon URL (default: http://127.0.0.1:4750 or HOTCELL_ENDPOINT)
  --api-key <key>    API key for an auth-enabled daemon (or HOTCELL_API_KEY)
  -h, --help         Show this help
  -v, --version      Show the CLI + running daemon versions (flags any drift)`);
}

export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positional: string[];
}

/**
 * Repeated value flags accumulate comma-separated rather than overwriting, so
 * `--set A=gateway --set B=inject` and `--set A=gateway,B=inject` are the same
 * input. Every consumer already splits on commas (`--env`, `--label`, `--set`),
 * so this is uniform; a repeated flag silently dropping all but the last value
 * is the alternative, and with dispositions that would lose decisions.
 */
function accumulate(existing: string | boolean | undefined, value: string): string {
  return typeof existing === "string" ? `${existing},${value}` : value;
}

export function parseFlags(args: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const value = eq === -1 ? args[i + 1] : arg.slice(eq + 1);
      if (eq === -1 && value !== undefined && !value.startsWith("-")) {
        flags[key] = accumulate(flags[key], value);
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith("-")) {
      const key = arg.slice(1);
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("-")) {
        flags[key] = value;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}
