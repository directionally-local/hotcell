import { HotcellClient } from "@hotcell/sdk";
import type { GlobalArgs } from "./cli.js";
import { parseEnvPairs } from "./env.js";
import { injectedEnv } from "./envconfig.js";
import { startProgress } from "./progress.js";
import { nodeCapableImage, AUTOPILOT_SETUP, OPENCODE_SETUP } from "./setups.js";
import { formatError, parseLimitFlags } from "./util.js";

/**
 * hotcell create [--image I] [--env K=V,…] [--sleep-after MS] [--egress] [--label K=V,…]
 *           [--setup "cmd"] [--autopilot] [--opencode]
 *
 * Provision a standalone, persistent sandbox and print its id (unlike `sb run`,
 * which runs a command and destroys the sandbox). `--autopilot` and `--opencode`
 * preinstall their agent wired to the LLM gateway (both imply --egress). Creation is
 * detached: each sandbox shows live status (TTY stderr) while the daemon provisions
 * it, so slow creates (repo clone + heavy setup) can't time out client-side.
 */
export async function createCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });

  const image = typeof flags.image === "string" ? flags.image : undefined;
  const autopilot = flags.autopilot === true;
  const opencode = flags.opencode === true;
  const egress = flags.egress === true || autopilot || opencode;
  const egressSpendCapUsd =
    typeof flags["egress-spend-cap"] === "string" ? Number(flags["egress-spend-cap"]) : undefined;
  const sleepAfter =
    typeof flags["sleep-after"] === "string" ? Number(flags["sleep-after"]) : undefined;
  const driver = typeof flags.driver === "string" ? flags.driver : undefined;
  const { memoryMb, cpus, pidsLimit } = parseLimitFlags(flags);
  // Harness setup follows user prerequisites; Autopilot is the preferred install
  // when both harness flags are explicitly supplied.
  const setupSteps = [
    ...(typeof flags.setup === "string" ? [flags.setup] : []),
    ...(autopilot ? [AUTOPILOT_SETUP] : []),
    ...(opencode ? [OPENCODE_SETUP] : []),
  ];
  const setup = setupSteps.length ? setupSteps : undefined;
  const repo = typeof flags.repo === "string" ? flags.repo : undefined;
  const repoRef = typeof flags.ref === "string" ? flags.ref : undefined;
  // --branch feat/x  → that name;  bare --branch  → an auto-generated name.
  const branch =
    typeof flags.branch === "string" ? flags.branch : flags.branch === true ? "auto" : undefined;

  if ((autopilot || opencode) && process.stderr.isTTY) {
    const harness = autopilot ? "Autopilot" : "OpenCode";
    if (flags.egress !== true) {
      console.error(`  (--${autopilot ? "autopilot" : "opencode"} implies --egress — ${harness} uses the gateway)`);
    }
    if (!nodeCapableImage(image)) {
      console.error(`  (--${autopilot ? "autopilot" : "opencode"} needs npm — ${image} may not ship node)`);
    }
  }

  // Variables the user marked `inject` at import go into every sandbox this
  // project creates; an explicit --env still wins, so a one-off override needs
  // no re-import. `gateway` variables are absent by design — the daemon injects
  // a token for those, never the real key.
  let env: Record<string, string> | undefined;
  let labels: Record<string, string> | undefined;
  try {
    const injected = injectedEnv();
    const explicit = typeof flags.env === "string" ? parseEnvPairs(flags.env.split(",")) : {};
    const merged = {
      ...injected,
      // Autopilot normally stores config below /root/.config, which is tmpfs on
      // Apple VZ. Keep its gateway token/config on the persistent workspace disk.
      ...(autopilot ? { XDG_CONFIG_HOME: "/workspace/.config" } : {}),
      ...explicit,
    };
    if (Object.keys(merged).length) env = merged;
    if (typeof flags.label === "string") labels = parseEnvPairs(flags.label.split(","));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  // --name: a human handle, stored as the `name` label — shows as a column in
  // `hotcell ls` and the fleet TUI (five hex ids are indistinguishable).
  const name = typeof flags.name === "string" && flags.name ? flags.name : undefined;
  if (name) labels = { ...(labels ?? {}), name };

  // -n / --count: create N identical cells in one command (each with its own
  // auto-named branch under `--branch`). stdout stays machine-clean: one id per
  // line, so `ids=$(hotcell create -n 5 …)` splits trivially.
  const count = Math.max(1, Math.floor(Number(flags.n ?? flags.count ?? 1)) || 1);
  const options = {
    image,
    env,
    labels,
    sleepAfter,
    driver,
    egress,
    egressSpendCapUsd,
    setup,
    repo,
    repoRef,
    branch,
    memoryMb,
    cpus,
    pidsLimit,
  };

  // A NAMED branch with -n would give every cell the same branch → colliding
  // pushes. Auto-suffix per cell (feat/x-1…N) and say so; bare --branch (auto)
  // already yields a unique name per sandbox daemon-side. A shared --name is
  // suffixed per cell too (feat → feat-1…feat-N).
  const optionsFor = (i: number) => {
    let o = options;
    if (count > 1) {
      if (branch && branch !== "auto") o = { ...o, branch: `${branch}-${i + 1}` };
      if (name) o = { ...o, labels: { ...(o.labels ?? {}), name: `${name}-${i + 1}` } };
    }
    return o;
  };

  // Detached create + live per-sandbox status (TTY stderr only; the progress
  // handle is a no-op otherwise). ids reach stdout only after everything
  // settles, so the stream contract holds.
  const progress = startProgress(
    Array.from({ length: count }, (_, i) => (count > 1 ? `#${i + 1}` : "")),
  );
  const results = await Promise.allSettled(
    Array.from({ length: count }, (_, i) =>
      client
        .getSandbox(undefined, {
          ...optionsFor(i),
          detach: true,
          onStatus: (status, info) =>
            progress.update(
              i,
              status === "creating"
                ? info.statusReason
                  ? `creating (${info.statusReason})`
                  : "creating"
                : status,
            ),
        })
        .then(
          (sandbox) => {
            progress.settle(i, true, sandbox.id);
            return sandbox;
          },
          (err) => {
            progress.settle(i, false, formatError(err));
            throw err;
          },
        ),
    ),
  );
  progress.stop();

  const ok = results.filter(
    (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof client.getSandbox>>> =>
      r.status === "fulfilled",
  );
  for (const r of ok) console.log(r.value.id);
  const failed = results.length - ok.length;
  const firstFailure = results.find((r) => r.status === "rejected") as
    | PromiseRejectedResult
    | undefined;

  if (count > 1) {
    if (process.stderr.isTTY) {
      console.error(`✓ created ${ok.length}/${count} sandboxes`);
      ok.forEach((r, i) => console.error(`  #${i + 1}  hotcell terminal ${r.value.id}`));
      if (branch === "auto") console.error(`  each on its own branch (auto-named)`);
      else if (branch) console.error(`  branches ${branch}-1 … ${branch}-${count} (suffixed so pushes don't collide)`);
    }
    if (failed) {
      console.error(
        `✗ ${failed} create(s) failed: ${firstFailure ? String(firstFailure.reason?.message ?? firstFailure.reason) : "unknown"}`,
      );
    }
    return failed ? 1 : 0;
  }

  if (!ok.length) {
    console.error(
      `Failed to create sandbox: ${firstFailure ? String(firstFailure.reason?.message ?? firstFailure.reason) : "unknown"}`,
    );
    return 1;
  }
  const sandbox = ok[0].value;

  // Human affordance (stderr, TTY only): the specs, what's actually installed,
  // and the obvious next moves — otherwise invisible unless you read --help.
  // Non-TTY (agents / CI / pipes) get nothing but the id above.
  if (process.stderr.isTTY) {
    const si = sandbox.getInfo();
    const info = await client.info().catch(() => null);
    const drv = driver ?? info?.driver ?? "container";
    const lim = si.limits ?? {};
    const specParts = [
      lim.cpus ? `${lim.cpus} cpu` : null,
      lim.memoryMb ? `${(lim.memoryMb / 1024).toFixed(lim.memoryMb % 1024 ? 1 : 0)} GiB` : null,
    ].filter(Boolean);
    const desc = describeImage(si.image);
    const e = (s: string) => console.error(s);
    e(`✓ created ${si.id}${name ? `  (${name})` : ""}  ·  ${drv} · ${specParts.length ? specParts.join(" · ") : "unlimited"}`);
    e(`  image      ${si.image}${desc ? `   — ${desc}` : ""}`);
    e(`  workspace  /workspace${repo ? " (repo cloned)" : " (empty)"}`);
    if (branch) e(`  branch     ${branch === "auto" ? "new (auto-named)" : branch}`);
    e("");
    e(`  open a shell   hotcell terminal ${si.id}`);
    if (!setup && !repo) e(`  preinstall     recreate with  --autopilot  or  --opencode   ·   clone a repo:  --repo <url>`);
    if (/slim/.test(si.image)) e(`  fuller image   --image python:3.11 (+git +build tools)   ·   see all: hotcell images`);
    if (autopilot) {
      e(`  run the agent  hotcell terminal ${si.id}  then: autopilot`);
      if (opencode) e(`  alternate      opencode (also installed)`);
    } else if (opencode) e(`  run the agent  hotcell terminal ${si.id}  then: opencode`);
    else e(`  run an agent   see examples/ (Autopilot, OpenCode, Codex, Claude Code, Mastra) — add --egress for keyless LLM`);
  }

  // TTY-only guidance; and a token-listing hiccup must NOT flip the exit code —
  // the sandbox exists and its id is already on stdout (agents would retry and
  // leak sandboxes otherwise). Recoverable anytime via `hotcell egress <id>`.
  if (egress && process.stderr.isTTY) {
    try {
      const { providers } = await sandbox.listEgressTokens();
      console.error("");
      for (const p of providers) {
        if (p.baseUrlEnv) console.error(`  ${p.baseUrlEnv}=${p.baseUrl}`);
      }
    } catch (err) {
      console.error(`  (sandbox created; egress token listing failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return 0;
}

/**
 * One-line, honest summary of what a base image ships — matched on the image name
 * (we can't introspect the layers). Empty string = don't guess. Keeps the create
 * hint truthful about why a fresh sandbox feels bare (e.g. `-slim` = no git/node).
 */
function describeImage(image: string): string {
  if (/hotcell[/-]base/.test(image)) return "python + node + git + build tools";
  if (/python:.*slim/.test(image)) return "python3 + pip — no git, node, or build tools";
  if (/(^|\/)python:/.test(image)) return "python3 + pip + git + build tools (no node)";
  if (/(^|\/)node:/.test(image)) return "node + npm + git (no python)";
  if (/(^|\/)(ubuntu|debian):/.test(image)) return "bare OS — install what you need with apt";
  return "";
}
