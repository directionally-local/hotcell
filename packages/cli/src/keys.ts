import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { relative } from "node:path";
import { HotcellClient } from "@hotcell/sdk";
import { readConfigFile, writeConfigFile } from "./configfile.js";
import {
  AUTH_PRESETS,
  BUILTIN_ROUTES,
  ROUTED_ENV_VARS,
  type Disposition,
  type EnvManifest,
  manifestPath,
  readManifest,
  readValues,
  suggestRouteName,
  validateBaseUrl,
  writeManifest,
  writeValues,
} from "./envconfig.js";
import { storeKey, removeKey, loadKeys } from "./keystore.js";
import { c, cycleList, multilineInput, select, textInput, type CycleRow } from "./prompts.js";
import type { GlobalArgs } from "./cli.js";

/**
 * hotcell keys add|ls|rm|import|review — the provider keys the daemon uses to
 * swap token→real key at the egress gateway, and the disposition of every other
 * variable an imported `.env` carries.
 *
 * hotcell never classifies your variables. Import parses `KEY=VALUE` lines and
 * then asks you to set each one to `gateway`, `inject`, or `skip` (see
 * `envconfig.ts` for what those mean); the confirm step lists every value that
 * will enter a sandbox before anything is written. The only preselection is for
 * env-var names the daemon demonstrably already routes — a lookup of existing
 * state, not a guess about what a name means.
 *
 * Human: `hotcell keys add openrouter` prompts for the secret (hidden).
 * Agent: `hotcell keys add openrouter --value sk-…` or `… | hotcell keys add openrouter --stdin`.
 * Bulk:  `hotcell keys import .env` (add `--set NAME=gateway …` when not on a tty).
 */

const tty = () => process.stdout.isTTY && !process.env.NO_COLOR;
const green = (s: string) => (tty() ? `\x1b[38;5;114m${s}\x1b[0m` : s);
const dim = (s: string) => (tty() ? `\x1b[38;5;244m${s}\x1b[0m` : s);
const red = (s: string) => (tty() ? `\x1b[38;5;203m${s}\x1b[0m` : s);

const mask = (v: string) => (v.length <= 8 ? "•".repeat(Math.max(4, v.length)) : `${v.slice(0, 5)}…${v.slice(-2)}`);

function promptHidden(label: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(label);
    const wasRaw = stdin.isRaw;
    try { stdin.setRawMode?.(true); } catch { /* not a tty */ }
    stdin.resume();
    let buf = "";
    const onData = (d: Buffer) => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          try { stdin.setRawMode?.(wasRaw ?? false); } catch { /* ignore */ }
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(buf);
        } else if (ch === "\x03") { process.stdout.write("\n"); process.exit(130); }
        else if (ch === "\x7f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let d = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c)).on("end", () => resolve(d.trim()));
  });
}

/**
 * Tell a running daemon to hot-reload keys and provider shapes (no restart).
 * Distinguishes "daemon down" from "daemon rejected our API key" — conflating
 * them told users to start a daemon that was already running.
 */
async function reload(globals: GlobalArgs): Promise<"ok" | "auth" | "down"> {
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  try {
    await client.request("POST", "/reload-keys");
    return "ok";
  } catch (err) {
    return err instanceof Error && /-> 401/.test(err.message) ? "auth" : "down";
  }
}

export interface ParsedEnvVar {
  envName: string;
  value: string;
}

/**
 * Parse .env text into `KEY=VALUE` pairs: `export` prefixes, quotes, comments,
 * and blank lines tolerated; anything else skipped. Deliberately does nothing
 * else — no provider inference, no secret detection. What each variable is FOR
 * is the user's call, made in the review step.
 */
export function parseDotenv(text: string): ParsedEnvVar[] {
  const out: ParsedEnvVar[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value) continue;
    out.push({ envName: m[1], value });
  }
  return out;
}

/**
 * Ask for the route a variable's key should be swapped through, and — when that
 * route is new — the shape the gateway needs to reach it. The base-URL parse is
 * the routability test: a `postgres://` value has no request header to swap a
 * credential into, so it cannot be a gateway route and the user is told why and
 * sent back to `inject`/`skip`.
 *
 * Returns the route name, or null when the variable cannot be gatewayed.
 */
async function shapePrompt(envName: string, manifest: EnvManifest): Promise<string | null> {
  console.log("");
  console.log(`  ${c.bold}${envName}${c.reset} ${dim("→ gateway")}`);
  const provider = (await textInput("route name", suggestRouteName(envName))).toLowerCase();
  if (!provider) return null;
  if (BUILTIN_ROUTES.has(provider) || manifest.shapes[provider]) {
    console.log(`  ${green("✓")} ${provider} ${dim("— route already known")}`);
    return provider;
  }

  console.log(dim(`  no route for "${provider}" yet — two questions, asked once`));
  for (;;) {
    const answer = await textInput("base URL", "");
    if (!answer) return null;
    const checked = validateBaseUrl(answer);
    if ("error" in checked) {
      console.log(`  ${red("✗")} ${checked.error}`);
      console.log(dim(`    ${envName} can still be [i] inject or [s] skip.`));
      const again = await select("try a different base URL?", [{ label: "yes" }, { label: "no" }], 1, { erase: true });
      if (again !== 0) return null;
      continue;
    }
    const preset = await select(
      "auth",
      AUTH_PRESETS.map((p) => ({ label: p.label })),
      0,
      { erase: true },
    );
    if (preset < 0) return null;
    const { authHeader, format } = AUTH_PRESETS[preset];
    manifest.shapes[provider] = { baseUrl: checked.url, authHeader, format };
    console.log(`  ${green("✓")} ${provider}  ${dim(`${checked.url} · ${authHeader}: ${format}`)}`);
    return provider;
  }
}

/**
 * Materialise project shapes into the daemon's persisted env
 * (`~/.hotcell/config.json`) as `HOTCELL_PROVIDER_<NAME>_*`, which is where the
 * daemon's provider registry reads them from. Keeps a teammate's `git clone` +
 * `hotcell keys import` sufficient to reconstruct every route.
 */
function syncShapesToDaemon(manifest: EnvManifest): void {
  const cfg = readConfigFile();
  for (const [provider, shape] of Object.entries(manifest.shapes)) {
    const name = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    cfg[`HOTCELL_PROVIDER_${name}_BASEURL`] = shape.baseUrl;
    cfg[`HOTCELL_PROVIDER_${name}_AUTHHEADER`] = shape.authHeader;
    cfg[`HOTCELL_PROVIDER_${name}_FORMAT`] = shape.format;
  }
  writeConfigFile(cfg);
}

const STATE_COLORS = { gateway: c.green, inject: c.yellow, skip: c.dim };

/**
 * The review step: every variable gets an explicit disposition, then a confirm
 * that names each value which will enter a sandbox. Returns the number of rows
 * decided, or -1 if the user cancelled.
 */
async function reviewInteractive(
  vars: ParsedEnvVar[],
  manifest: EnvManifest,
): Promise<{ rows: CycleRow[]; providers: Map<string, string> } | null> {
  const providers = new Map<string, string>();
  const rows: CycleRow[] = vars.map((v) => {
    const prior = manifest.vars[v.envName];
    const routed = ROUTED_ENV_VARS[v.envName];
    const provider = prior?.provider ?? routed;
    if (provider) providers.set(v.envName, provider);
    return {
      name: v.envName,
      detail: mask(v.value),
      note: provider ? `→ ${provider}` : undefined,
      state: prior?.disposition ?? (routed ? "gateway" : null),
    };
  });

  const result = await cycleList(`${vars.length} variables · set each, then confirm`, rows, {
    states: ["gateway", "inject", "skip"],
    shortcuts: { g: "gateway", i: "inject", s: "skip" },
    colors: STATE_COLORS,
    onSet: async (row, state) => {
      if (state !== "gateway") {
        providers.delete(row.name);
        row.note = undefined;
        return state;
      }
      const known = providers.get(row.name) ?? ROUTED_ENV_VARS[row.name];
      if (known) {
        providers.set(row.name, known);
        row.note = `→ ${known}`;
        return state;
      }
      const provider = await shapePrompt(row.name, manifest);
      if (!provider) return null;
      providers.set(row.name, provider);
      row.note = `→ ${provider}`;
      return state;
    },
  });
  if (!result) return null;
  return { rows: result, providers };
}

/** Summarise what was decided and what that means, then require a confirmation. */
async function confirmPlan(rows: CycleRow[]): Promise<boolean> {
  const by = (s: string) => rows.filter((r) => r.state === s);
  const injected = by("inject");
  console.log("");
  console.log(`  ${c.green}gateway${c.reset}   ${String(by("gateway").length).padStart(2)}   ${dim("real key stays on this host · sandbox gets a per-sandbox token")}`);
  console.log(`  ${c.yellow}inject${c.reset}    ${String(injected.length).padStart(2)}   ${dim("real value copied into every sandbox")}`);
  console.log(`  ${c.dim}skip${c.reset}      ${String(by("skip").length).padStart(2)}   ${dim("never leaves this machine")}`);
  if (injected.length) {
    console.log("");
    console.log(`  ${c.yellow}these ${injected.length} values will exist inside every sandbox:${c.reset}`);
    for (let i = 0; i < injected.length; i += 4) {
      console.log(`    ${injected.slice(i, i + 4).map((r) => r.name).join("  ")}`);
    }
  }
  console.log("");
  const answer = await select("write these decisions?", [{ label: "yes" }, { label: "cancel" }], 0, { erase: true });
  return answer === 0;
}

/** Persist a decided set of variables: keys, values, manifest, daemon shapes. */
async function persist(
  vars: ParsedEnvVar[],
  rows: CycleRow[],
  providers: Map<string, string>,
  manifest: EnvManifest,
  globals: GlobalArgs,
): Promise<void> {
  const valueOf = new Map(vars.map((v) => [v.envName, v.value]));
  const values = readValues();
  let keyCount = 0;
  let injectCount = 0;
  let keySource: string = process.platform === "darwin" ? "macOS keychain" : "~/.hotcell/keys.json (chmod 600)";

  for (const row of rows) {
    const value = valueOf.get(row.name);
    if (value === undefined) continue;
    if (row.state === "gateway") {
      const provider = providers.get(row.name);
      if (!provider) continue;
      keySource = storeKey(provider, value) === "keychain" ? "macOS keychain" : "~/.hotcell/keys.json (chmod 600)";
      manifest.vars[row.name] = { disposition: "gateway", provider };
      keyCount++;
    } else if (row.state === "inject") {
      values[row.name] = value;
      manifest.vars[row.name] = { disposition: "inject" };
      injectCount++;
    } else {
      delete values[row.name];
      manifest.vars[row.name] = { disposition: "skip" };
    }
  }

  writeValues(values);
  writeManifest(manifest);
  syncShapesToDaemon(manifest);

  const where = relative(process.cwd(), manifestPath()) || manifestPath();
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  console.log(`  ${green("✓")} ${plural(keyCount, "key").padEnd(12)} ${dim(keySource)}`);
  console.log(`  ${green("✓")} ${`${injectCount} injected`.padEnd(12)} ${dim("~/.hotcell/env-values.json (chmod 600)")}`);
  console.log(`  ${green("✓")} ${plural(rows.length, "decision").padEnd(12)} ${dim(`${where} — no secrets, safe to commit`)}`);
  const applied = await reload(globals);
  await reportKeyChoices(globals, rows);
  console.log(
    applied === "ok"
      ? dim("    applied live")
      : applied === "auth"
        ? dim("    (daemon rejected the API key — pass --api-key, or restart your shell to pick up the new one)")
        : dim("    (start the daemon to use them: hotcell start)"),
  );
}

const DISPOSITIONS: Disposition[] = ["gateway", "inject", "skip"];

/** Best-effort report: only variable names and the user's chosen disposition leave the CLI. */
async function reportKeyChoices(globals: GlobalArgs, rows: CycleRow[]): Promise<void> {
  const choices = rows
    .filter((row): row is CycleRow & { state: Disposition } => DISPOSITIONS.includes(row.state as Disposition))
    .map((row) => ({ name: row.name, disposition: row.state }));
  if (!choices.length) return;
  try {
    const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
    await client.request("POST", "/audit-events", { event: "keys.import", choices });
  } catch {
    // The local import remains successful if no daemon is reachable.
  }
}

/**
 * Import .env text. Interactive terminals get the review screen; everything else
 * must state each disposition up front (`--set`) or name a default explicitly,
 * because the safe-looking default is the one that quietly copies secrets into
 * sandboxes.
 */
export async function importEnvText(
  text: string,
  globals: GlobalArgs,
  flags: Record<string, string | boolean> = {},
): Promise<number> {
  const vars = parseDotenv(text);
  if (!vars.length) {
    console.error("no KEY=VALUE lines found — nothing imported");
    return 1;
  }
  const manifest = readManifest();

  const preset = new Map<string, Disposition>();
  if (typeof flags.set === "string") {
    for (const pair of flags.set.split(",")) {
      const eq = pair.indexOf("=");
      const name = eq > 0 ? pair.slice(0, eq).trim() : "";
      const state = eq > 0 ? pair.slice(eq + 1).trim() : "";
      if (!name || !DISPOSITIONS.includes(state as Disposition)) {
        console.error(`invalid --set "${pair}" (expected NAME=gateway|inject|skip)`);
        return 1;
      }
      preset.set(name, state as Disposition);
    }
  }
  const fallback = typeof flags["default-unknown"] === "string" ? flags["default-unknown"] : "";
  if (fallback && !DISPOSITIONS.includes(fallback as Disposition)) {
    console.error(`invalid --default-unknown "${fallback}" (expected gateway|inject|skip)`);
    return 1;
  }

  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (!interactive || preset.size || fallback) {
    return importNonInteractive(vars, manifest, preset, fallback as Disposition | "", globals, interactive);
  }

  console.log("");
  console.log(
    `  ${vars.length} variables · ${vars.filter((v) => ROUTED_ENV_VARS[v.envName] || manifest.vars[v.envName]).length} already known · ${dim("nothing stored until you confirm")}`,
  );
  const reviewed = await reviewInteractive(vars, manifest);
  if (!reviewed) {
    console.log(dim("  cancelled — nothing stored"));
    return 1;
  }
  if (!(await confirmPlan(reviewed.rows))) {
    console.log(dim("  cancelled — nothing stored"));
    return 1;
  }
  await persist(vars, reviewed.rows, reviewed.providers, manifest, globals);
  return 0;
}

/** Non-interactive import: every variable needs a disposition from flags or the manifest. */
async function importNonInteractive(
  vars: ParsedEnvVar[],
  manifest: EnvManifest,
  preset: Map<string, Disposition>,
  fallback: Disposition | "",
  globals: GlobalArgs,
  interactive: boolean,
): Promise<number> {
  const providers = new Map<string, string>();
  const rows: CycleRow[] = [];
  const undecided: string[] = [];

  for (const v of vars) {
    const prior = manifest.vars[v.envName];
    const routed = ROUTED_ENV_VARS[v.envName];
    const state = preset.get(v.envName) ?? prior?.disposition ?? (routed ? "gateway" : fallback || null);
    if (!state) {
      undecided.push(v.envName);
      continue;
    }
    if (state === "gateway") {
      const provider = prior?.provider ?? routed ?? "";
      if (!provider || (!BUILTIN_ROUTES.has(provider) && !manifest.shapes[provider])) {
        console.error(
          `${red("✗")} ${v.envName}=gateway has no route — add a shape first (HOTCELL_PROVIDER_<NAME>_BASEURL) or run \`hotcell keys import\` on a terminal`,
        );
        return 1;
      }
      providers.set(v.envName, provider);
    }
    rows.push({ name: v.envName, state });
  }

  if (undecided.length) {
    console.error(`${red("✗")} ${undecided.length} variables need a decision${interactive ? "" : " and stdin is not a terminal"}`);
    console.error("");
    console.error(`    hotcell keys import .env \\`);
    for (const n of undecided.slice(0, 3)) console.error(`      --set ${n}=${dim("gateway|inject|skip")} \\`);
    if (undecided.length > 3) console.error(`      …${undecided.length - 3} more`);
    console.error("");
    console.error(`    or --default-unknown=skip|inject   ${dim("(inject puts real values in sandboxes)")}`);
    return 1;
  }

  await persist(vars, rows, providers, manifest, globals);
  return 0;
}

/**
 * TTY flow shared by the menu and setup wizard: paste .env lines, or read a
 * file. The mode is picked with the raw-mode `select` (not a text prompt) so
 * exactly one readline interface is ever created — two in sequence lose input
 * buffered by the first.
 */
export async function importEnvInteractive(globals: GlobalArgs): Promise<void> {
  const how = await select("import keys from", [
    { label: "paste .env lines here", hint: "ends at an empty line" },
    { label: "a .env file on disk", hint: "give its path" },
    { label: "cancel" },
  ]);
  let text = "";
  if (how === 0) {
    text = await multilineInput("paste .env lines");
  } else if (how === 1) {
    const path = await textInput("path to the .env");
    if (!path) return;
    try {
      text = readFileSync(path.replace(/^~(?=\/)/, homedir()), "utf8");
    } catch {
      console.error(red(`cannot read ${path}`));
      return;
    }
  } else return; // cancel, or Esc (-1)
  if (text.trim()) await importEnvText(text, globals);
}

/**
 * Re-open the review screen for variables already decided, with no .env needed.
 * A preselection is a starting point, never a lock — this is how a variable
 * hotcell recognised (say a project's own `OPENAI_BASE_URL` override) gets moved
 * off `gateway`, and how a route added later gets applied to old decisions.
 */
async function reviewCommand(globals: GlobalArgs): Promise<number> {
  const manifest = readManifest();
  const names = Object.keys(manifest.vars).sort();
  if (!names.length) {
    console.error("nothing to review yet — import an environment first:  hotcell keys import .env");
    return 1;
  }
  if (!process.stdin.isTTY) {
    console.error("hotcell keys review needs a terminal (use --set on import for scripted changes)");
    return 1;
  }
  const values = readValues();
  const keys = loadKeys();
  // Values are shown masked where we still hold them; a `skip` row has none.
  const vars: ParsedEnvVar[] = names.map((name) => {
    const decision = manifest.vars[name];
    const held =
      decision.disposition === "inject"
        ? values[name]
        : decision.provider
          ? keys[decision.provider]?.value
          : undefined;
    return { envName: name, value: held ?? "" };
  });
  console.log("");
  console.log(`  ${names.length} variables in ${relative(process.cwd(), manifestPath()) || manifestPath()}`);
  const reviewed = await reviewInteractive(vars, manifest);
  if (!reviewed) return 1;
  if (!(await confirmPlan(reviewed.rows))) {
    console.log(dim("  cancelled — nothing changed"));
    return 1;
  }
  // Only re-store values we actually still hold; a row whose value is gone keeps
  // its disposition without clobbering the stored secret.
  await persist(vars.filter((v) => v.value), reviewed.rows, reviewed.providers, manifest, globals);
  return 0;
}

export async function keysCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const sub = positional[0];

  if (sub === "add") {
    const provider = (positional[1] ?? "").toLowerCase();
    if (!provider) {
      console.error('Usage: hotcell keys add <provider> [--value <key>]   — any name (openrouter, stripe, cloudflare, …)');
      return 1;
    }
    let value =
      typeof flags.value === "string" ? flags.value
      : flags.stdin ? await readStdin()
      : "";
    if (!value) {
      if (!process.stdin.isTTY) {
        console.error("no key given — pass --value <key>, pipe with --stdin, or run in a terminal");
        return 1;
      }
      value = await promptHidden(dim(`paste ${provider} key (hidden): `));
    }
    if (!value) { console.error("empty key — nothing stored"); return 1; }

    // A key with no route is a key the gateway can never use. Capture the shape
    // now (on a terminal) rather than storing something that silently does
    // nothing — the failure mode this whole flow exists to remove.
    const manifest = readManifest();
    if (!BUILTIN_ROUTES.has(provider) && !manifest.shapes[provider]) {
      if (process.stdin.isTTY) {
        console.log(dim(`  no route for "${provider}" yet — two questions, asked once`));
        for (;;) {
          const answer = await textInput("base URL", "");
          if (!answer) { console.error(red("  no base URL — nothing stored")); return 1; }
          const checked = validateBaseUrl(answer);
          if ("error" in checked) { console.log(`  ${red("✗")} ${checked.error}`); continue; }
          const preset = await select("auth", AUTH_PRESETS.map((p) => ({ label: p.label })), 0, { erase: true });
          if (preset < 0) return 1;
          manifest.shapes[provider] = {
            baseUrl: checked.url,
            authHeader: AUTH_PRESETS[preset].authHeader,
            format: AUTH_PRESETS[preset].format,
          };
          writeManifest(manifest);
          syncShapesToDaemon(manifest);
          break;
        }
      } else {
        console.error(
          `${red("✗")} no route for "${provider}" — set HOTCELL_PROVIDER_${provider.toUpperCase()}_BASEURL (and _AUTHHEADER/_FORMAT), or run this on a terminal`,
        );
        return 1;
      }
    }

    const source = storeKey(provider, value.trim());
    const applied = await reload(globals);
    console.log(`${green("✓")} stored ${green(provider)}   ${dim(`· ${source === "keychain" ? "macOS keychain" : "~/.hotcell/keys.json (chmod 600)"}`)}`);
    console.log(
      applied === "ok"
        ? dim("  applied live")
        : applied === "auth"
          ? dim("  (daemon rejected the API key — pass --api-key, or restart your shell to pick up the new one)")
          : dim("  (start the daemon to use it: hotcell start)"),
    );
    return 0;
  }

  if (sub === "ls" || sub === "list") {
    const keys = loadKeys();
    const names = Object.keys(keys).sort();
    const manifest = readManifest();
    const injected = Object.entries(manifest.vars).filter(([, d]) => d.disposition === "inject");
    if (!names.length && !injected.length) {
      console.log(dim("no provider keys yet — add one:  hotcell keys add openrouter"));
      return 0;
    }
    if (names.length) {
      const w = Math.max(8, ...names.map((n) => n.length));
      console.log(`${dim("PROVIDER".padEnd(w))}  ${dim("KEY".padEnd(12))}  ${dim("SOURCE")}`);
      for (const n of names) {
        const { value, source } = keys[n];
        console.log(`${n.padEnd(w)}  ${mask(value).padEnd(12)}  ${dim(source)}`);
      }
    }
    // Injected values are not provider keys, but they DO enter sandboxes — the
    // one thing a key listing must never hide.
    if (injected.length) {
      console.log("");
      console.log(dim(`${injected.length} variables are injected verbatim into every sandbox:`));
      console.log(`  ${injected.map(([n]) => n).join("  ")}`);
      console.log(dim("  change with:  hotcell keys review"));
    }
    return 0;
  }

  if (sub === "import") {
    const path = positional[1];
    let text = "";
    if (path) {
      try {
        text = readFileSync(path, "utf8");
      } catch {
        console.error(`cannot read ${path}`);
        return 1;
      }
    } else if (!process.stdin.isTTY) {
      text = await readStdin();
    } else {
      console.error("Usage: hotcell keys import <.env path>   (or pipe: cat .env | hotcell keys import)");
      return 1;
    }
    return importEnvText(text, globals, flags);
  }

  if (sub === "review") return reviewCommand(globals);

  if (sub === "rm" || sub === "remove") {
    const provider = positional[1];
    if (!provider) { console.error("Usage: hotcell keys rm <provider>"); return 1; }
    const removed = removeKey(provider);
    if (removed) await reload(globals);
    console.log(removed ? `${green("✓")} removed ${green(provider)}` : dim(`${red("○")} no key named '${provider}'`));
    return 0;
  }

  console.error("Usage: hotcell keys <add|ls|rm|import|review> …");
  return 1;
}
